//! Placeholder for a test-only mock token contract used by mandate-registry's
//! integration tests (allowance / transfer_from / balance). Real token
//! interface methods land starting Phase 3. This crate exists in Phase 0
//! only to prove the Rust workspace builds two independent contract crates.
#![no_std]

use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    /// Trivial health-check method. Replaced by mint / transfer / approve /
    /// balance etc. in later phases.
    pub fn ping(_env: Env) -> u32 {
        1
    }
}

#[cfg(test)]
mod test {
    use super::{MockToken, MockTokenClient};
    use soroban_sdk::Env;

    #[test]
    fn ping_returns_one() {
        let env = Env::default();
        let contract_id = env.register(MockToken, ());
        let client = MockTokenClient::new(&env, &contract_id);

        assert_eq!(client.ping(), 1);
    }
}
