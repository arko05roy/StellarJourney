//! Canonical on-chain data types for the mandate-registry contract.
//!
//! Field names and ordering mirror PLAN.md §10.3 (`Mandate`) and §12
//! (`PaymentReceipt`, `RefundReceipt`) exactly. These types are the single
//! source of truth for the mandate data model — the backend and frontend
//! mirror them but never redefine the business rules they encode
//! (CLAUDE.md §20). Do not reorder or rename fields without updating those
//! mirrors and regenerating the contract client (Phase 7).

use soroban_sdk::{contracttype, Address, BytesN};

/// Lifecycle status of a mandate.
///
/// `Expired` is intentionally never written by a getter: `get_mandate`
/// computes it on the read path as `now >= expires_at` without mutating
/// storage (PLAN.md §10.8). A write path (Phase 2+) may still persist
/// `Expired` explicitly once it observes the condition during another state
/// transition, but reads alone must stay side-effect free.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MandateStatus {
    Active,
    Paused,
    Revoked,
    Completed,
    Expired,
}

/// Fixed vs. variable-capped billing rule for a mandate.
///
/// # Deviation from PLAN.md §10.3
///
/// PLAN.md sketches `Variable { max_per_charge: i128 }` as a named-field
/// enum variant. `soroban-sdk` 27's `#[contracttype]` macro rejects named
/// (struct-style) enum fields outright — see
/// `soroban-sdk-macros-27.0.2/src/derive_enum.rs:65` ("enum variant ... has
/// unsupported named fields"); only unit and non-empty tuple variants are
/// supported. `Variable(i128)` is the semantics-preserving equivalent: the
/// single field is the same `max_per_charge` value, just carried
/// positionally instead of by name. No business rule changes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AmountRule {
    Fixed(i128),
    /// `max_per_charge` — see the deviation note above for why this is a
    /// tuple variant rather than the named-field form PLAN.md sketches.
    Variable(i128),
}

/// A recurring-payment authorization. See PLAN.md §10.3 for the field
/// contract and CLAUDE.md §6 for the validation order that guards every
/// mutation of this struct once `charge` lands in Phase 3.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Mandate {
    pub id: BytesN<32>,
    pub payer: Address,
    pub merchant: Address,
    pub asset: Address,
    pub status: MandateStatus,
    pub amount_rule: AmountRule,
    pub max_per_period: i128,
    pub period_seconds: u64,
    pub min_interval_seconds: u64,
    pub start_at: u64,
    pub expires_at: u64,
    pub max_successful_charges: u32,
    pub successful_charges: u32,
    pub total_collected: i128,
    pub current_period_start: u64,
    pub current_period_collected: i128,
    pub last_charged_at: Option<u64>,
    pub created_at: u64,
    pub metadata_hash: BytesN<32>,
}

/// Immutable receipt for one successful charge. Never deleted, including on
/// mandate revocation (CLAUDE.md §7 State invariants).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaymentReceipt {
    pub payment_id: BytesN<32>,
    pub mandate_id: BytesN<32>,
    pub charge_id: BytesN<32>,
    pub payer: Address,
    pub merchant: Address,
    pub asset: Address,
    pub amount: i128,
    pub invoice_hash: BytesN<32>,
    pub timestamp: u64,
}

/// Immutable receipt for one successful refund.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundReceipt {
    pub refund_id: BytesN<32>,
    pub payment_id: BytesN<32>,
    pub amount: i128,
    pub timestamp: u64,
}

/// Argument struct for `create_mandate` (Phase 2). Not itself stored — a
/// `Mandate` is built from this plus derived fields (`id`, `status`,
/// `successful_charges`, accounting counters, `created_at`).
///
/// `client_nonce` is a 32-byte value the checkout flow generates client-side
/// (e.g. a random value or a hash of the checkout session id) so that the
/// same `(payer, merchant, asset)` triple can mint distinct mandates on
/// request, and so the derived `mandate_id` (see `id::derive_mandate_id`)
/// stays collision-resistant.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MandateInput {
    pub payer: Address,
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
    pub client_nonce: BytesN<32>,
}
