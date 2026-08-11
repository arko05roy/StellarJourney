//! Placeholder for the mandate-registry contract. Real mandate lifecycle,
//! charge, and refund methods land starting Phase 1 (see PLAN.md, CLAUDE.md
//! §6). This crate exists in Phase 0 only to prove the Rust workspace,
//! release profile, and wasm32v1-none build target are wired correctly.
#![no_std]

use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct MandateRegistry;

#[contractimpl]
impl MandateRegistry {
    /// Trivial health-check method. Replaced by create_mandate / charge /
    /// refund etc. in later phases.
    pub fn ping(_env: Env) -> u32 {
        1
    }
}

#[cfg(test)]
mod test {
    use super::{MandateRegistry, MandateRegistryClient};
    use soroban_sdk::Env;

    #[test]
    fn ping_returns_one() {
        let env = Env::default();
        let contract_id = env.register(MandateRegistry, ());
        let client = MandateRegistryClient::new(&env, &contract_id);

        assert_eq!(client.ping(), 1);
    }
}
