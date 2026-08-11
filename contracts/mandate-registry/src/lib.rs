//! `mandate-registry`: the Soroban contract that enforces bounded,
//! replay-safe recurring-payment mandates (PLAN.md §10, CLAUDE.md §6-§8).
//! This contract is the protocol's policy authority — the backend database
//! and relayer are never trusted over its on-chain state.
//!
//! Phase 1 scope (this file's current state): canonical data types, the
//! frozen error-code table, the persistent storage layer, deterministic id
//! derivation, and checked arithmetic helpers. No lifecycle or charge logic
//! yet — `create_mandate`, `pause_mandate`, `resume_mandate`,
//! `revoke_mandate` land in Phase 2, `charge` in Phase 3, `refund` in Phase
//! 5 (see tasks/todo.md).
#![no_std]

pub mod error;
pub mod id;
pub mod math;
pub mod storage;
pub mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct MandateRegistry;

#[contractimpl]
impl MandateRegistry {
    /// Trivial health-check method carried over from Phase 0. Replaced by
    /// `create_mandate` / `charge` / `refund` etc. starting Phase 2.
    pub fn ping(_env: Env) -> u32 {
        1
    }
}
