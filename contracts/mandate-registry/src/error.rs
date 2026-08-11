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
}
