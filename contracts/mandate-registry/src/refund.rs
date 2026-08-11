//! Refund execution (Phase 5): `refund`, `get_refund`, `get_refunded_total`
//! (PLAN.md §10.4, §12; CLAUDE.md §6 refund scope, §7 Amounts/Replay
//! invariants).
//!
//! ## Validation order (this order is itself a spec, same discipline as
//! `charge.rs`'s CLAUDE.md §6 order)
//!
//! 1. Mandate exists -> `MandateNotFound`. **No status check.** A refund is
//!    permitted against a mandate in *any* status — `Active`, `Paused`,
//!    `Revoked`, `Completed`, or computed-`Expired` — per the lead decision:
//!    refusing to refund a cancelled subscription would be user-hostile and
//!    is not a security property. The only mandate-state precondition for a
//!    charge (CLAUDE.md §6 steps 2-4) simply does not apply here.
//! 2. Payment exists -> `PaymentNotFound`.
//! 3. The payment belongs to `mandate_id` -> `PaymentNotFound` (not a new
//!    "mismatched mandate" error — a merchant passing a `payment_id` that
//!    isn't this mandate's is, from the caller's point of view, exactly the
//!    same failure as passing a `payment_id` that doesn't exist under this
//!    mandate at all).
//! 4. `mandate.merchant.require_auth()`. The refund moves money merchant ->
//!    payer, so the merchant is the party giving up funds and the one whose
//!    authorization is required (PLAN.md §10.5) — never the payer, and never
//!    the relayer.
//! 5. `refund_id` unused -> `DuplicateRefund`. **Global** uniqueness: the
//!    Phase 1 `UsedRefund(refund_id)` key has no payment/mandate component,
//!    so a given `refund_id` can succeed at most once across every payment
//!    and every mandate this contract will ever hold, not just once per
//!    payment. This is a deliberate scope, not an oversight — see the module
//!    doc's "Global `refund_id` scope" section below.
//! 6. `amount > 0` -> `InvalidAmount`.
//! 7. `refunded_total[payment_id] + amount <= payment.amount` ->
//!    `RefundExceedsPayment`. Checked arithmetic (`math::checked_add_i128`).
//! 8. Merchant token balance sufficient -> `InsufficientBalance`. Advisory
//!    pre-flight only, same role as `charge.rs`'s allowance/balance checks:
//!    exists so a caller gets a typed, classifiable error instead of an
//!    opaque token-contract trap. `TokenClient::transfer` remains the actual
//!    authority.
//!
//! Then: `TokenClient::transfer(from = merchant, to = payer, amount)` on
//! `payment.asset`. **Not `transfer_from`** — the merchant authorizes the
//! transfer directly (`from.require_auth()` inside the token contract), no
//! allowance is involved on either side. The payer, merchant, and asset used
//! for the transfer (and for the receipt) are read from the stored
//! `PaymentReceipt`, **never from the mandate or from call arguments** — the
//! receipt is the immutable record of what actually moved the first time,
//! so a refund can only ever undo exactly that.
//!
//! ## No-headroom-restoration rule (the point of this phase)
//!
//! A refund does **not** decrement `mandate.total_collected` or
//! `mandate.current_period_collected`, and does not decrement
//! `mandate.successful_charges` or un-complete a `Completed` mandate.
//! `refund.rs` never touches the `Mandate` record at all — it only reads
//! `mandate.merchant` for the authorization check. Rationale: if a refund
//! restored spending headroom, a merchant could charge -> refund -> charge in
//! a loop and collect (and keep) unbounded real economic value while never
//! appearing to exceed `max_per_period` on any single balance check. Period
//! caps and the successful-charge-count cap are meant to bound *gross*
//! collection over a mandate's lifetime, not net-of-refunds collection — a
//! refund is a separate, merchant-initiated act of goodwill/correction that
//! sits on top of the original charge's already-consumed headroom, not a
//! reversal of it.
//!
//! ## Global `refund_id` uniqueness scope
//!
//! `storage::has_used_refund` / `mark_refund_used` operate on the bare
//! `UsedRefund(refund_id)` key inherited from Phase 1 — there is no
//! `(payment_id, refund_id)` or `(mandate_id, refund_id)` composite key. This
//! means a `refund_id` is unique across the *entire contract*, not scoped to
//! one payment. Kept as-is (not changed to a composite key) because Phase 1
//! already froze this storage shape and CLAUDE.md's idempotency model treats
//! a `refund_id` the same way an API `Idempotency-Key` is treated: a single
//! global namespace the caller (typically the merchant backend) is
//! responsible for generating collision-resistant values within, same as
//! `charge_id` is scoped per-mandate by a *different*, already-composite key.
//!
//! ## Accounting-mutates-only-after-transfer
//!
//! `RefundedTotal(payment_id)`, the `UsedRefund` replay guard, and the
//! `RefundReceipt` are all written strictly *after*
//! `TokenClient::transfer` returns successfully — identical discipline to
//! `charge.rs`. If `transfer` traps, the entire `refund` invocation traps
//! with it and the Soroban host discards every storage write attempted so
//! far, leaving `RefundedTotal`, the replay guard, and any receipt exactly as
//! they were before the call. `test_refund.rs`'s rollback test proves this
//! against a real failing transfer, not an assumption.

use soroban_sdk::{token::TokenClient, BytesN, Env, MuxedAddress};

use crate::{error::Error, events, math, storage, types::RefundReceipt};

/// Execute one refund against `payment_id`, which must belong to
/// `mandate_id`. Requires `mandate.merchant.require_auth()` — the merchant
/// gives up the funds, so the merchant authorizes. Permitted regardless of
/// the mandate's current status (see module doc).
pub fn refund(
    env: &Env,
    mandate_id: &BytesN<32>,
    payment_id: &BytesN<32>,
    amount: i128,
    refund_id: &BytesN<32>,
) -> Result<RefundReceipt, Error> {
    // 1. Mandate exists. No status check — refunds work on any mandate
    // status (revoked, expired, paused, completed included).
    let mandate = storage::get_mandate(env, mandate_id).ok_or(Error::MandateNotFound)?;

    // 2. Payment exists.
    let payment = storage::get_payment(env, payment_id).ok_or(Error::PaymentNotFound)?;

    // 3. The payment actually belongs to this mandate.
    if payment.mandate_id != *mandate_id {
        return Err(Error::PaymentNotFound);
    }

    // 4. Merchant authorization. The merchant loses funds here, so the
    // merchant authorizes — never the payer, never the relayer.
    mandate.merchant.require_auth();

    // 5. refund_id unused. Global scope across the whole contract — see
    // module doc.
    if storage::has_used_refund(env, refund_id) {
        return Err(Error::DuplicateRefund);
    }

    // 6. Amount is positive.
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    // 7. Cumulative refunds against this payment (including this one) must
    // not exceed the original payment amount.
    let refunded_so_far = storage::get_refunded_total(env, payment_id);
    let new_refunded_total = math::checked_add_i128(refunded_so_far, amount)?;
    if new_refunded_total > payment.amount {
        return Err(Error::RefundExceedsPayment);
    }

    let token = TokenClient::new(env, &payment.asset);

    // 8. Merchant token balance sufficient. Advisory pre-flight only, same
    // caveat as charge.rs's allowance/balance checks: `TokenClient::transfer`
    // below remains the actual authority.
    let merchant_balance = token.balance(&payment.merchant);
    if merchant_balance < amount {
        return Err(Error::InsufficientBalance);
    }

    // --- Transfer. `transfer`, not `transfer_from`: the merchant authorizes
    // directly (from.require_auth() inside the token contract), no allowance
    // involved on either side. Uses the payer/merchant/asset stored on the
    // payment receipt, never the mandate or call arguments, so a refund can
    // only ever undo exactly what the original charge moved. If this traps,
    // the whole invocation reverts and nothing below runs — see the module
    // doc and test_refund.rs's rollback test for the executed proof. ---
    token.transfer(
        &payment.merchant,
        MuxedAddress::from(&payment.payer),
        &amount,
    );

    // --- Accounting mutates only now, after the transfer succeeded. Per the
    // lead decision, the Mandate itself is never touched: no headroom is
    // restored (see module doc's "No-headroom-restoration rule"). ---
    storage::set_refunded_total(env, payment_id, new_refunded_total);
    storage::mark_refund_used(env, refund_id);

    let now = env.ledger().timestamp();
    let receipt = RefundReceipt {
        refund_id: refund_id.clone(),
        payment_id: payment_id.clone(),
        amount,
        timestamp: now,
    };
    storage::set_refund(env, &receipt);

    events::RefundSucceeded {
        mandate_id: mandate_id.clone(),
        payer: payment.payer.clone(),
        merchant: payment.merchant.clone(),
        refund_id: refund_id.clone(),
        payment_id: payment_id.clone(),
        asset: payment.asset.clone(),
        amount,
        refunded_total_after: new_refunded_total,
        timestamp: now,
    }
    .publish(env);

    Ok(receipt)
}

/// `RefundNotFound` if no receipt exists for `refund_id`. Read-only, parity
/// with `charge::get_payment`.
pub fn get_refund(env: &Env, refund_id: &BytesN<32>) -> Result<RefundReceipt, Error> {
    storage::get_refund(env, refund_id).ok_or(Error::RefundNotFound)
}

/// Cumulative amount refunded against `payment_id` so far (`0` if none).
/// Read-only convenience for backend/dashboard consumers (PLAN.md §12).
pub fn get_refunded_total(env: &Env, payment_id: &BytesN<32>) -> i128 {
    storage::get_refunded_total(env, payment_id)
}
