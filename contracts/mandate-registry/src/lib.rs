//! `mandate-registry`: the Soroban contract that enforces bounded,
//! replay-safe recurring-payment mandates (PLAN.md §10, CLAUDE.md §6-§8).
//! This contract is the protocol's policy authority — the backend database
//! and relayer are never trusted over its on-chain state.
//!
//! Phase 3 scope (this file's current state): the payer-only mandate
//! lifecycle (`create_mandate`, `pause_mandate`, `resume_mandate`,
//! `revoke_mandate`, `get_mandate`) plus fixed charge execution (`charge`,
//! `get_payment`) — the first point token transfer occurs. `refund` lands in
//! Phase 5 (see tasks/todo.md). Lifecycle business logic lives in
//! `lifecycle.rs`, charge logic in `charge.rs`; this file only declares the
//! thin `#[contractimpl]` entrypoints that adapt them to the Soroban ABI.
#![no_std]

// Tests run on std (via soroban-sdk's `testutils`, e.g. `Address::generate`,
// `env.auths()`); only the `test`/`test_lifecycle`/`test_charge` modules
// pull it in.
#[cfg(test)]
extern crate std;

pub mod charge;
pub mod error;
pub mod events;
pub mod id;
pub mod lifecycle;
pub mod math;
pub mod storage;
pub mod types;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_charge;
#[cfg(test)]
mod test_lifecycle;

use soroban_sdk::{contract, contractimpl, BytesN, Env};

use error::Error;
use types::{Mandate, MandateInput, PaymentReceipt};

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
}
