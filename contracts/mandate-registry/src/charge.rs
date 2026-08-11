//! Fixed charge execution (Phase 3): `charge`, `get_payment` (PLAN.md §10.4,
//! §10.6, §11, §12; CLAUDE.md §6 validation order — the exact sequence below
//! is itself a spec, since it determines which error a caller observes when
//! several rules are violated by the same call at once).
//!
//! ## Scope
//!
//! `AmountRule::Fixed` is fully enforced: the charged amount must equal the
//! configured amount exactly (CLAUDE.md §7 Amounts — a *smaller* amount is
//! also a violation, not just a larger one). `AmountRule::Variable`'s
//! per-charge cap (validation step 8) is implemented generically here too
//! (`amount <= max_per_charge`), per the Phase 3 lead decision, but
//! `max_per_period` enforcement and billing-period rollover (steps 11-12)
//! are Phase 4's scope. This module still calls out those two steps at
//! their exact ordinal position so Phase 4 can fill them in without
//! reordering anything above or below.
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
//! `last_charged_at`, the used-charge-id replay guard, the payment receipt,
//! and the `charge_succeeded` event are all written *after*
//! `TokenClient::transfer_from` returns successfully. If that call traps,
//! the entire `charge` invocation traps with it and the Soroban host
//! discards every storage write the invocation made so far — there is no
//! partial-mutation path. `test_charge.rs`'s rollback test proves this by
//! executing a real failing transfer and inspecting storage afterward,
//! rather than assuming host semantics.

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

    // 11. Billing-period rollover — Phase 4 owns
    // `period_index = floor((now - start_at) / period_seconds)` and resetting
    // `current_period_collected` / `current_period_start` on index change
    // (PLAN.md §10.7). Deliberately a no-op in Phase 3: `current_period_start`
    // is left exactly as `create_mandate` set it.

    // 12. Remaining period allowance — Phase 4 owns the
    // `current_period_collected + amount <= max_per_period` check. Not
    // enforced in Phase 3 (Fixed-only scope); `current_period_collected` is
    // still accumulated below (see accounting section) so Phase 4 inherits a
    // correct running total to enforce against.

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
    mandate.current_period_collected =
        math::checked_add_i128(mandate.current_period_collected, amount)?;
    mandate.last_charged_at = Some(now);

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

    // Informational only in Phase 3 (PLAN.md §10.7's formula, computed
    // straight from `start_at` since `current_period_start` is never
    // recomputed until Phase 4 implements rollover). `period_seconds > 0` is
    // guaranteed by `create_mandate`'s input validation and is immutable
    // thereafter, so the division below cannot panic.
    let elapsed_since_start = math::checked_sub_u64(now, mandate.start_at)?;
    let period_index = elapsed_since_start / mandate.period_seconds;

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

    Ok(receipt)
}

/// `PaymentNotFound` if no receipt exists for `payment_id`.
pub fn get_payment(env: &Env, payment_id: &BytesN<32>) -> Result<PaymentReceipt, Error> {
    storage::get_payment(env, payment_id).ok_or(Error::PaymentNotFound)
}
