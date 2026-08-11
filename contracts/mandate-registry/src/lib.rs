//! `mandate-registry`: the Soroban contract that enforces bounded,
//! replay-safe recurring-payment mandates (PLAN.md §10, CLAUDE.md §6-§8).
//! This contract is the protocol's policy authority — the backend database
//! and relayer are never trusted over its on-chain state.
//!
//! Phase 5 scope (this file's current state): the payer-only mandate
//! lifecycle (`create_mandate`, `pause_mandate`, `resume_mandate`,
//! `revoke_mandate`, `get_mandate`), charge execution (`charge`,
//! `get_payment`) — fixed and variable amount rules, billing-period
//! rollover, and the `Completed` transition — and refunds (`refund`,
//! `get_refund`, `get_refunded_total`). Lifecycle business logic lives in
//! `lifecycle.rs`, charge logic in `charge.rs`, refund logic in `refund.rs`;
//! this file only declares the thin `#[contractimpl]` entrypoints that adapt
//! them to the Soroban ABI.
//!
//! Phase 6 adds no new public methods — it adds `test_property.rs` (a
//! seeded, shadow-model-checked random-sequence harness) and
//! `test_adversarial.rs` (malicious-token scenarios) as the security bar
//! before Phase 7. See `docs/contract-invariants.md` for the full PLAN.md
//! §18 invariant -> test mapping.
#![no_std]

// Tests run on std (via soroban-sdk's `testutils`, e.g. `Address::generate`,
// `env.auths()`); only the `test`/`test_lifecycle`/`test_charge`/
// `test_period`/`test_refund` modules pull it in.
#[cfg(test)]
extern crate std;

pub mod charge;
pub mod error;
pub mod events;
pub mod id;
pub mod lifecycle;
pub mod math;
pub mod refund;
pub mod storage;
pub mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_adversarial;
#[cfg(test)]
mod test_charge;
#[cfg(test)]
mod test_lifecycle;
#[cfg(test)]
mod test_period;
#[cfg(test)]
mod test_property;
#[cfg(test)]
mod test_refund;

use soroban_sdk::{contract, contractimpl, BytesN, Env};

use error::Error;
use types::{Mandate, MandateInput, PaymentReceipt, RefundReceipt};

#[contract]
pub struct MandateRegistry;

#[contractimpl]
impl MandateRegistry {
    /// Trivial health-check method carried over from Phase 0.
    pub fn ping(_env: Env) -> u32 {
        1
    }

    /// Create a new mandate. Requires `input.payer.require_auth()` — the
    /// merchant and the relayer are never sufficient (PLAN.md §10.5).
    pub fn create_mandate(env: Env, input: MandateInput) -> Result<BytesN<32>, Error> {
        lifecycle::create_mandate(&env, input)
    }

    /// `Active -> Paused`. Requires the payer's authorization.
    pub fn pause_mandate(env: Env, mandate_id: BytesN<32>) -> Result<(), Error> {
        lifecycle::pause_mandate(&env, &mandate_id)
    }

    /// `Paused -> Active`. Requires the payer's authorization.
    pub fn resume_mandate(env: Env, mandate_id: BytesN<32>) -> Result<(), Error> {
        lifecycle::resume_mandate(&env, &mandate_id)
    }

    /// `Active|Paused|Expired -> Revoked`, unconditionally at the payer's
    /// request. Requires the payer's authorization; never the merchant's.
    pub fn revoke_mandate(env: Env, mandate_id: BytesN<32>) -> Result<(), Error> {
        lifecycle::revoke_mandate(&env, &mandate_id)
    }

    /// Read-only. Reports `Expired` when `now >= expires_at` for a stored
    /// `Active`/`Paused` mandate without writing storage.
    pub fn get_mandate(env: Env, mandate_id: BytesN<32>) -> Result<Mandate, Error> {
        lifecycle::get_mandate(&env, &mandate_id)
    }

    /// Execute one charge. Requires `mandate.merchant.require_auth()` —
    /// never the relayer, which has no spending authority (CLAUDE.md §11).
    /// See `charge.rs` for the full CLAUDE.md §6 validation order.
    pub fn charge(
        env: Env,
        mandate_id: BytesN<32>,
        charge_id: BytesN<32>,
        amount: i128,
        invoice_hash: BytesN<32>,
    ) -> Result<PaymentReceipt, Error> {
        charge::charge(&env, &mandate_id, &charge_id, amount, &invoice_hash)
    }

    /// Read-only. `PaymentNotFound` if no receipt exists for `payment_id`.
    pub fn get_payment(env: Env, payment_id: BytesN<32>) -> Result<PaymentReceipt, Error> {
        charge::get_payment(&env, &payment_id)
    }

    /// Execute one refund against `payment_id` (must belong to
    /// `mandate_id`). Requires `mandate.merchant.require_auth()` — the
    /// merchant gives up the funds. Permitted regardless of the mandate's
    /// current status (revoked/paused/expired/completed all allowed); see
    /// `refund.rs` for the full validation order and the no-headroom-
    /// restoration rule.
    pub fn refund(
        env: Env,
        mandate_id: BytesN<32>,
        payment_id: BytesN<32>,
        amount: i128,
        refund_id: BytesN<32>,
    ) -> Result<RefundReceipt, Error> {
        refund::refund(&env, &mandate_id, &payment_id, amount, &refund_id)
    }

    /// Read-only. `RefundNotFound` if no receipt exists for `refund_id`.
    pub fn get_refund(env: Env, refund_id: BytesN<32>) -> Result<RefundReceipt, Error> {
        refund::get_refund(&env, &refund_id)
    }

    /// Read-only. Cumulative amount refunded against `payment_id` so far
    /// (`0` if none). Convenience for backend/dashboard consumers.
    pub fn get_refunded_total(env: Env, payment_id: BytesN<32>) -> i128 {
        refund::get_refunded_total(&env, &payment_id)
    }
}
