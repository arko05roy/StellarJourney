//! Storage layer. Later phases must go through these typed helpers instead
//! of calling `env.storage()` directly, so the durability and TTL policy
//! stays in one place.
//!
//! # Durability decision — everything here is PERSISTENT, never temporary
//!
//! `Mandate`, `PaymentReceipt`, the `UsedCharge` / `UsedRefund` replay
//! guards, and `RefundedTotal` all live in **persistent** storage.
//!
//! This is a security invariant, not a cost optimization: temporary storage
//! in Soroban is deleted outright once its TTL lapses, and a deleted key
//! reads back as absent — indistinguishable from "never used". If a
//! `charge_id` or `refund_id` replay guard were temporary, an old id could
//! be resubmitted successfully after the TTL expired, silently violating the
//! "a charge_id can succeed once at most" / "a refund_id can succeed once at
//! most" invariants (CLAUDE.md §7 Replay resistance). Persistent entries
//! never disappear on their own — they can only be removed by an explicit
//! contract write, which this contract never does to a replay guard or a
//! receipt. The same argument applies to `Mandate` (losing it would make a
//! revoked/completed mandate look "not found" and therefore uncharged-again
//! but also un-auditable) and to receipts (CLAUDE.md requires historical
//! receipts survive revocation).
//!
//! There is no contract-level instance config in Phase 1, so `instance()`
//! storage is unused for now; the constants and `bump_instance` helper below
//! exist so Phase 2+ has one place to wire it up if/when config appears.

use soroban_sdk::{contracttype, BytesN, Env, IntoVal, Val};

use crate::types::{Mandate, PaymentReceipt};

/// Ledger close time on Stellar is targeted at ~5s, so ~17,280 ledgers is
/// approximately one day. Used as the TTL *threshold*: once an entry's
/// remaining TTL drops below this, the next touch extends it back out.
pub const PERSISTENT_TTL_THRESHOLD: u32 = 17_280;

/// ~30 days of ledgers at ~5s/ledger. Used as the TTL *extend-to* value:
/// every bump pushes the entry's live-until-ledger this far into the future.
/// Chosen so a mandate that goes quiet for weeks (paused, or between long
/// billing periods) doesn't need constant babysitting, while still bounding
/// the rent the contract prepays at any one time.
pub const PERSISTENT_TTL_EXTEND_TO: u32 = PERSISTENT_TTL_THRESHOLD * 30;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Mandate(BytesN<32>),
    Payment(BytesN<32>),
    /// `(mandate_id, charge_id)` — a charge id is only unique *within* a
    /// mandate, so both halves of the pair are part of the key.
    UsedCharge(BytesN<32>, BytesN<32>),
    UsedRefund(BytesN<32>),
    /// Cumulative amount refunded against a given `payment_id`.
    RefundedTotal(BytesN<32>),
}

/// Bump a persistent key's TTL using the contract-wide threshold/extend-to
/// policy. Called after every write so a fresh write always resets the
/// rent clock.
fn bump_persistent<K>(env: &Env, key: &K)
where
    K: IntoVal<Env, Val>,
{
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND_TO);
}

// --- Mandate ---

pub fn get_mandate(env: &Env, id: &BytesN<32>) -> Option<Mandate> {
    env.storage()
        .persistent()
        .get(&DataKey::Mandate(id.clone()))
}

pub fn set_mandate(env: &Env, mandate: &Mandate) {
    let key = DataKey::Mandate(mandate.id.clone());
    env.storage().persistent().set(&key, mandate);
    bump_persistent(env, &key);
}

// --- Payment receipts ---

pub fn get_payment(env: &Env, payment_id: &BytesN<32>) -> Option<PaymentReceipt> {
    env.storage()
        .persistent()
        .get(&DataKey::Payment(payment_id.clone()))
}

pub fn set_payment(env: &Env, receipt: &PaymentReceipt) {
    let key = DataKey::Payment(receipt.payment_id.clone());
    env.storage().persistent().set(&key, receipt);
    bump_persistent(env, &key);
}

// --- Charge replay guard ---

pub fn has_used_charge(env: &Env, mandate_id: &BytesN<32>, charge_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::UsedCharge(mandate_id.clone(), charge_id.clone()))
}

pub fn mark_charge_used(env: &Env, mandate_id: &BytesN<32>, charge_id: &BytesN<32>) {
    let key = DataKey::UsedCharge(mandate_id.clone(), charge_id.clone());
    env.storage().persistent().set(&key, &true);
    bump_persistent(env, &key);
}

// --- Refund replay guard ---

pub fn has_used_refund(env: &Env, refund_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::UsedRefund(refund_id.clone()))
}

pub fn mark_refund_used(env: &Env, refund_id: &BytesN<32>) {
    let key = DataKey::UsedRefund(refund_id.clone());
    env.storage().persistent().set(&key, &true);
    bump_persistent(env, &key);
}

// --- Cumulative refunded total per payment ---

/// Returns `0` when no refund has ever been recorded against `payment_id`,
/// which is the correct starting value for the cumulative total (as opposed
/// to treating "absent" as an error).
pub fn get_refunded_total(env: &Env, payment_id: &BytesN<32>) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::RefundedTotal(payment_id.clone()))
        .unwrap_or(0)
}

pub fn set_refunded_total(env: &Env, payment_id: &BytesN<32>, total: i128) {
    let key = DataKey::RefundedTotal(payment_id.clone());
    env.storage().persistent().set(&key, &total);
    bump_persistent(env, &key);
}
