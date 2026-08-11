//! Contract events for the mandate lifecycle (PLAN.md §11).
//!
//! Every successful lifecycle transition emits exactly one of these events;
//! a rejected call (an `Err` return from `lifecycle.rs`) never reaches the
//! `publish` call, so no event fires for a failed transition. `mandate_id`,
//! `payer`, and `merchant` are topics on every event so indexers can filter
//! by any of the three without scanning event data. `mandate_created` also
//! carries the full mandate terms (asset, amount rule, caps, window) so an
//! indexer can reconstruct mandate state from events alone without reading
//! contract storage.
//!
//! `mandate_expired` is intentionally not defined here: expiry is
//! computed-only on the read path (`lifecycle::effective_status`) and is
//! never itself persisted or treated as a state transition, so there is no
//! successful write to attach such an event to. See the "computed-only
//! expiry" note in `docs/contract-invariants.md`.
//!
//! Only `metadata_hash` is carried on-chain, never plaintext metadata
//! (CLAUDE.md §5, §9 — descriptive text stays off-chain).

use soroban_sdk::{contractevent, Address, BytesN};

use crate::types::AmountRule;

/// Emitted once by `create_mandate` after the mandate is durably stored.
#[contractevent]
pub struct MandateCreated {
    #[topic]
    pub mandate_id: BytesN<32>,
    #[topic]
    pub payer: Address,
    #[topic]
    pub merchant: Address,
    pub asset: Address,
    pub amount_rule: AmountRule,
    pub max_per_period: i128,
    pub period_seconds: u64,
    pub min_interval_seconds: u64,
    pub start_at: u64,
    pub expires_at: u64,
    pub max_successful_charges: u32,
    pub metadata_hash: BytesN<32>,
    pub timestamp: u64,
}

/// Emitted by `pause_mandate` on a successful `Active -> Paused` transition.
#[contractevent]
pub struct MandatePaused {
    #[topic]
    pub mandate_id: BytesN<32>,
    #[topic]
    pub payer: Address,
    #[topic]
    pub merchant: Address,
    pub timestamp: u64,
}

/// Emitted by `resume_mandate` on a successful `Paused -> Active` transition.
#[contractevent]
pub struct MandateResumed {
    #[topic]
    pub mandate_id: BytesN<32>,
    #[topic]
    pub payer: Address,
    #[topic]
    pub merchant: Address,
    pub timestamp: u64,
}

/// Emitted by `revoke_mandate` on a successful transition to `Revoked` (from
/// `Active`, `Paused`, or an expired-but-not-yet-terminal mandate).
#[contractevent]
pub struct MandateRevoked {
    #[topic]
    pub mandate_id: BytesN<32>,
    #[topic]
    pub payer: Address,
    #[topic]
    pub merchant: Address,
    pub timestamp: u64,
}

/// Emitted by `charge` (Phase 3) once a payment has been durably recorded —
/// i.e. only after `TokenClient::transfer_from` succeeded, accounting was
/// updated, and the receipt was stored. Full field set per PLAN.md §11.
/// Topics follow the same `mandate_id`/`payer`/`merchant` convention as the
/// lifecycle events above so indexers can filter charges the same way they
/// filter lifecycle transitions; `payment_id`, `charge_id`, and the rest are
/// carried as data. `invoice_hash` only — no plaintext invoice metadata ever
/// reaches the chain (CLAUDE.md §5, §9).
#[contractevent]
pub struct ChargeSucceeded {
    #[topic]
    pub mandate_id: BytesN<32>,
    #[topic]
    pub payer: Address,
    #[topic]
    pub merchant: Address,
    pub payment_id: BytesN<32>,
    pub charge_id: BytesN<32>,
    pub asset: Address,
    pub amount: i128,
    pub invoice_hash: BytesN<32>,
    pub period_index: u64,
    pub successful_charge_number: u32,
    pub timestamp: u64,
}
