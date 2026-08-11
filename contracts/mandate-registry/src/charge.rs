//! Charge execution (Phase 3 fixed + Phase 4 variable/period accounting):
//! `charge`, `get_payment` (PLAN.md §10.4, §10.6, §10.7, §10.8, §11, §12;
//! CLAUDE.md §6 validation order — the exact sequence below is itself a
//! spec, since it determines which error a caller observes when several
//! rules are violated by the same call at once).
//!
//! ## Scope
//!
//! `AmountRule::Fixed` requires the charged amount equal the configured
//! amount exactly (CLAUDE.md §7 Amounts — a *smaller* amount is also a
//! violation, not just a larger one). `AmountRule::Variable` caps the
//! per-charge amount at `max_per_charge` (validation step 8).
//! `max_per_period` enforcement and billing-period rollover (steps 11-12)
//! are implemented below (Phase 4).
//!
//! ## Billing-period rollover (steps 11-12)
//!
//! `period_index = floor((now - start_at) / period_seconds)` (PLAN.md
//! §10.7). The *stored* period is identified by comparing the **computed
//! period boundary** (`start_at + period_index * period_seconds`) against
//! the mandate's stored `current_period_start`, rather than deriving a
//! stored index from `current_period_start` and comparing indices. Both are
//! mathematically equivalent given `period_seconds` is immutable after
//! creation, but comparing boundaries directly needs no extra assumption
//! about how `current_period_start` was produced — it's the one value the
//! `Mandate` actually persists, so it's the more direct thing to compare
//! against.
//!
//! - If the computed boundary differs from `current_period_start`, this
//!   charge lands in a period that has never been seen before: the
//!   *effective* `current_period_collected` for this charge is `0` (a full
//!   reset), regardless of how many periods were skipped — the boundary is
//!   computed directly via one division, never by looping period-by-period,
//!   so a long gap (e.g. 5 skipped periods) still resolves in one step to
//!   the correct current boundary, and can only ever reset the allowance
//!   once for that period (CLAUDE.md §7 Time invariant 12).
//! - If it matches, the effective collected total is the stored one (no
//!   reset — same period as last time).
//! - The boundary comparison is (`>=`, not `>`) semantics by construction:
//!   at `now == start_at + n*period_seconds` exactly, `floor((now -
//!   start_at) / period_seconds) == n`, so the charge is already treated as
//!   belonging to period `n` and sees a freshly-reset allowance if `n`'s
//!   boundary differs from the stored one.
//!
//! Per the lead decision, the effective `current_period_collected` and
//! `current_period_start` are computed here (steps 11-12, before any token
//! call) but **only written to storage after `transfer_from` succeeds**,
//! in the same accounting block as everything else — a rolled-over-but-
//! failed charge must leave storage untouched, exactly like every other
//! Phase 3 accounting field. There is deliberately no separate write path
//! that persists rollover independently of a successful charge.
//!
//! ## Spender / allowance model
//!
//! The mandate contract itself is the SEP-41 `spender`: the payer approves
//! *this contract's address* for a bounded allowance (PLAN.md §10.10), and
//! `charge` calls `TokenClient::transfer_from(spender = contract, from =
//! payer, to = merchant, amount)`. Funds move directly payer -> merchant;
//! the contract is never `from` or `to` in any transfer it makes, so it
//! never holds payment funds even transiently (CLAUDE.md §7 Tokens). The
//! merchant destination is read from the stored `Mandate` only — `charge`'s
//! signature has no merchant/destination argument at all, which is what
//! makes relayer redirection structurally impossible, not just policy.
//!
//! ## Accounting-mutates-only-after-transfer
//!
//! `successful_charges`, `total_collected`, `current_period_collected`,
//! `current_period_start`, `last_charged_at`, the used-charge-id replay
//! guard, the payment receipt, and the `charge_succeeded` event (plus, when
//! applicable, the `Completed` status write and `mandate_completed` event)
//! are all written *after* `TokenClient::transfer_from` returns
//! successfully. If that call traps, the entire `charge` invocation traps
//! with it and the Soroban host discards every storage write the invocation
//! made so far — there is no partial-mutation path. `test_charge.rs`'s and
//! `test_period.rs`'s rollback tests prove this by executing a real failing
//! transfer and inspecting storage afterward, rather than assuming host
//! semantics.
//!
//! ## Completion transition
//!
//! After a successful charge, if `max_successful_charges != 0` (`0` means
//! unlimited, the Phase 2 convention) and the new `successful_charges`
//! equals it exactly, the mandate transitions to `Completed` and a
//! `mandate_completed` event is published — inside the same post-transfer
//! accounting block, so this is atomic with the rest of the charge's
//! effects, not a separate write.

use soroban_sdk::{token::TokenClient, BytesN, Env};

use crate::{
    error::Error,
    events, id, lifecycle, math, storage,
    types::{AmountRule, MandateStatus, PaymentReceipt},
};

/// Execute one charge against `mandate_id`. Requires
/// `mandate.merchant.require_auth()` — never the relayer, which has no
/// spending authority at all (CLAUDE.md §11, PLAN.md §10.5).
pub fn charge(
    env: &Env,
    mandate_id: &BytesN<32>,
    charge_id: &BytesN<32>,
    amount: i128,
    invoice_hash: &BytesN<32>,
) -> Result<PaymentReceipt, Error> {
    // 1. Mandate exists.
    let mut mandate = storage::get_mandate(env, mandate_id).ok_or(Error::MandateNotFound)?;

    let now = env.ledger().timestamp();

    // 2. Status is Active, using the same computed-expiry helper Phase 2's
    // get_mandate/pause/resume/revoke use (lifecycle::effective_status).
    match lifecycle::effective_status(&mandate, now) {
        MandateStatus::Active => {}
        MandateStatus::Paused => return Err(Error::MandatePaused),
        MandateStatus::Revoked => return Err(Error::MandateRevoked),
        MandateStatus::Completed => return Err(Error::MandateCompleted),
        MandateStatus::Expired => return Err(Error::MandateExpired),
    }

    // 3. now >= start_at.
    if now < mandate.start_at {
        return Err(Error::ChargeBeforeStart);
    }

    // 4. now < expires_at. Step 2's Active/Paused -> Expired computation
    // already rejects most expired mandates before reaching here; this is a
    // defense-in-depth restatement at the exact ordinal position CLAUDE.md
    // §6 assigns it, not new logic layered on top.
    if now >= mandate.expires_at {
        return Err(Error::MandateExpired);
    }

    // 5. Merchant authorization. The relayer that submits the transaction
    // envelope supplies no spending authority of its own.
    mandate.merchant.require_auth();

    // 6. charge_id has not been used for this mandate.
    if storage::has_used_charge(env, mandate_id, charge_id) {
        return Err(Error::DuplicateCharge);
    }

    // 7. Amount is positive.
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    // 8. Amount satisfies the fixed or variable rule. Fixed mandates charge
    // exactly the configured amount — a smaller amount is also a violation
    // (CLAUDE.md §7 Amounts), not only a larger one.
    match mandate.amount_rule {
        AmountRule::Fixed(fixed_amount) => {
            if amount != fixed_amount {
                return Err(Error::AmountExceedsChargeLimit);
            }
        }
        AmountRule::Variable(max_per_charge) => {
            if amount > max_per_charge {
                return Err(Error::AmountExceedsChargeLimit);
            }
        }
    }

    // 9. min_interval_seconds has elapsed since last_charged_at. Skipped on
    // the first-ever charge (no previous charge to measure from).
    if let Some(last_charged_at) = mandate.last_charged_at {
        let next_eligible_at =
            math::checked_add_u64(last_charged_at, mandate.min_interval_seconds)?;
        if now < next_eligible_at {
            return Err(Error::ChargeTooSoon);
        }
    }

    // 10. max_successful_charges is not exceeded. 0 means unlimited (Phase 2
    // convention, unchanged here).
    if mandate.max_successful_charges != 0
        && mandate.successful_charges >= mandate.max_successful_charges
    {
        return Err(Error::ChargeCountExceeded);
    }

    // 11. Billing-period rollover. Compute the effective period state for
    // this charge without persisting anything yet — see the module doc for
    // why the boundary (not a derived index) is compared against the stored
    // `current_period_start`, and why this is safe to compute before the
    // token calls but must only be written after a successful transfer.
    // `now >= mandate.start_at` is already guaranteed by step 3, so this
    // subtraction cannot underflow.
    let elapsed_since_start = math::checked_sub_u64(now, mandate.start_at)?;
    let period_index = elapsed_since_start / mandate.period_seconds;
    let computed_period_start = math::checked_add_u64(
        mandate.start_at,
        math::checked_mul_u64(period_index, mandate.period_seconds)?,
    )?;
    // A different boundary than the one currently stored means this charge
    // is the first one observed in a new period (possibly several periods
    // after the last charge) — the effective allowance resets to zero.
    // Otherwise this charge is still within the same period as last time,
    // and the effective collected total is whatever is already stored.
    let effective_period_collected = if computed_period_start != mandate.current_period_start {
        0
    } else {
        mandate.current_period_collected
    };

    // 12. Remaining period allowance.
    let new_period_collected = math::checked_add_i128(effective_period_collected, amount)?;
    if new_period_collected > mandate.max_per_period {
        return Err(Error::AmountExceedsPeriodLimit);
    }

    let contract_address = env.current_contract_address();
    let token = TokenClient::new(env, &mandate.asset);

    // 13. Token allowance sufficient. Advisory only: this pre-flight check
    // exists so the relayer gets a typed, classifiable error instead of an
    // opaque token-contract trap (CLAUDE.md §11). The `transfer_from` call
    // below remains the actual authority.
    let allowance = token.allowance(&mandate.payer, &contract_address);
    if allowance < amount {
        return Err(Error::InsufficientAllowance);
    }

    // 14. Payer balance sufficient. Same advisory caveat as step 13.
    let balance = token.balance(&mandate.payer);
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }

    // --- Transfer. The contract is the spender; funds move payer ->
    // merchant directly, never through the contract itself. If this traps,
    // the whole invocation reverts and nothing below runs — see the module
    // doc and test_charge.rs's rollback test for the executed proof. ---
    token.transfer_from(
        &contract_address,
        &mandate.payer,
        &mandate.merchant,
        &amount,
    );

    // --- Accounting mutates only now, after the transfer succeeded. ---
    mandate.successful_charges = math::checked_add_u32(mandate.successful_charges, 1)?;
    mandate.total_collected = math::checked_add_i128(mandate.total_collected, amount)?;
    // Write the effective period state computed at steps 11-12 above — never
    // recomputed here, so a failed transfer (which returns before this line
    // runs at all) can never have partially applied the rollover.
    mandate.current_period_start = computed_period_start;
    mandate.current_period_collected = new_period_collected;
    mandate.last_charged_at = Some(now);

    // Completion transition: 0 means unlimited (Phase 2 convention) and can
    // never complete. A non-zero cap completes the instant the count first
    // equals it — this and the accounting above are part of the same write,
    // so completion can never be observed without the charge that caused it
    // also having succeeded, and vice versa.
    let became_completed = mandate.max_successful_charges != 0
        && mandate.successful_charges == mandate.max_successful_charges;
    if became_completed {
        mandate.status = MandateStatus::Completed;
    }

    storage::set_mandate(env, &mandate);
    storage::mark_charge_used(env, mandate_id, charge_id);

    let payment_id = id::derive_payment_id(env, mandate_id, charge_id);
    let receipt = PaymentReceipt {
        payment_id: payment_id.clone(),
        mandate_id: mandate_id.clone(),
        charge_id: charge_id.clone(),
        payer: mandate.payer.clone(),
        merchant: mandate.merchant.clone(),
        asset: mandate.asset.clone(),
        amount,
        invoice_hash: invoice_hash.clone(),
        timestamp: now,
    };
    storage::set_payment(env, &receipt);

    // `period_index` is now the authoritative value computed at steps 11-12
    // above (Phase 4) — no longer a placeholder recomputed straight from
    // `start_at` (that was a Phase 3 stand-in, since `current_period_start`
    // was never recomputed before now).
    events::ChargeSucceeded {
        mandate_id: mandate_id.clone(),
        payer: mandate.payer.clone(),
        merchant: mandate.merchant.clone(),
        payment_id: payment_id.clone(),
        charge_id: charge_id.clone(),
        asset: mandate.asset.clone(),
        amount,
        invoice_hash: invoice_hash.clone(),
        period_index,
        successful_charge_number: mandate.successful_charges,
        timestamp: now,
    }
    .publish(env);

    if became_completed {
        events::MandateCompleted {
            mandate_id: mandate_id.clone(),
            payer: mandate.payer.clone(),
            merchant: mandate.merchant.clone(),
            successful_charges: mandate.successful_charges,
            timestamp: now,
        }
        .publish(env);
    }

    Ok(receipt)
}

/// `PaymentNotFound` if no receipt exists for `payment_id`.
pub fn get_payment(env: &Env, payment_id: &BytesN<32>) -> Result<PaymentReceipt, Error> {
    storage::get_payment(env, payment_id).ok_or(Error::PaymentNotFound)
}
