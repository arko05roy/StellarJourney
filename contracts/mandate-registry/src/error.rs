//! Contract error codes.
//!
//! # ABI stability
//!
//! These discriminants are a **public ABI contract**: the backend
//! (`packages/stellar`, `apps/api`) maps the raw `u32` error code returned by
//! a failed contract invocation back to a typed error (CLAUDE.md §8). Once a
//! number is assigned to a variant it must never be renumbered or reused for
//! a different meaning — doing so would silently reclassify old failures for
//! any client that hasn't redeployed. New variants may only be appended after
//! the highest existing number (currently 20); the block below is frozen.
use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // --- FROZEN 1..20 — see module doc comment. Do not reorder or renumber. ---
    MandateNotFound = 1,
    MandateNotActive = 2,
    MandatePaused = 3,
    MandateRevoked = 4,
    MandateCompleted = 5,
    MandateExpired = 6,
    ChargeBeforeStart = 7,
    ChargeTooSoon = 8,
    InvalidAmount = 9,
    AmountExceedsChargeLimit = 10,
    AmountExceedsPeriodLimit = 11,
    ChargeCountExceeded = 12,
    DuplicateCharge = 13,
    UnauthorizedMerchant = 14,
    InsufficientAllowance = 15,
    InsufficientBalance = 16,
    PaymentNotFound = 17,
    RefundExceedsPayment = 18,
    DuplicateRefund = 19,
    ArithmeticOverflow = 20,
    // --- End frozen block. Phase 2+ may append new variants at 21+. ---
    /// A `create_mandate` input violates one of the bound checks enumerated
    /// in `lifecycle::validate_input` (non-positive amount rule value,
    /// `max_per_period` non-positive or below the per-charge cap,
    /// `period_seconds == 0`, `expires_at <= start_at`, `expires_at` already
    /// in the past, or `payer == merchant`). See `docs/contract-invariants.md`
    /// for the full bound table.
    InvalidMandateInput = 21,
    /// `create_mandate` derived an id that already has a stored mandate.
    /// Ids are derived deterministically from `(network_id, contract_address,
    /// payer, merchant, asset, client_nonce)`; a distinct `client_nonce`
    /// always produces a distinct id, so this only fires on a genuine replay
    /// of an identical input tuple.
    DuplicateMandate = 22,
    /// A lifecycle transition was requested that the state machine does not
    /// define, and no more specific status error applies. Currently only
    /// `resume_mandate` called on an `Active` mandate (Active is not a legal
    /// resume source and isn't itself a rejection reason like Paused/Revoked/
    /// Completed/Expired).
    InvalidStateTransition = 23,
}
