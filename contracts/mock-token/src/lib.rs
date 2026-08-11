//! `mock-token`: a minimal SEP-41/SAC-shaped token contract used **only** by
//! `mandate-registry`'s Phase 3+ integration tests to exercise `allowance`,
//! `balance`, and `transfer_from` against something that behaves like the
//! Stellar Asset Contract (`soroban_sdk::token::TokenClient` compatible
//! function names, argument order, and types).
//!
//! # This contract is TEST-ONLY. Never deploy it.
//!
//! Two things make that true:
//!
//! 1. `mint` has no admin authorization check at all — any caller can credit
//!    any address's balance. That is fine for seeding test fixtures and
//!    would be a critical vulnerability in a real token.
//! 2. `set_fail_transfers` exists purely so tests can prove
//!    `mandate-registry`'s "a failed transfer must not mutate mandate
//!    accounting" rollback invariant (CLAUDE.md §6, §7 Tokens) by forcing a
//!    real, deterministic `transfer_from` failure. No production token has
//!    (or should have) a flag like this.
#![no_std]

#[cfg(test)]
extern crate std;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contract]
pub struct MockToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Balance(Address),
    /// `(from, spender)`, mirroring the real SEP-41 allowance key shape.
    Allowance(Address, Address),
    /// TEST-ONLY failure-injection switch. See the module doc.
    FailTransfers,
}

#[contractimpl]
impl MockToken {
    /// Trivial health-check method carried over from Phase 0.
    pub fn ping(_env: Env) -> u32 {
        1
    }

    /// TEST-ONLY. Credits `to`'s balance directly with no authorization
    /// check — this contract has no admin concept. Exists purely so tests
    /// can seed a payer's starting balance.
    pub fn mint(env: Env, to: Address, amount: i128) {
        assert!(amount > 0, "mock-token: mint amount must be positive");
        let current = Self::balance(env.clone(), to.clone());
        let updated = current
            .checked_add(amount)
            .expect("mock-token: balance arithmetic overflow");
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &updated);
    }

    /// Matches `soroban_sdk::token::TokenClient::balance` exactly (fn name,
    /// argument types, return type) — SAC-compatible.
    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    /// Matches `TokenClient::approve`. `live_until_ledger` is accepted for
    /// signature compatibility but not enforced — this is a synchronous
    /// test double, not a full SAC re-implementation.
    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        _live_until_ledger: u32,
    ) {
        from.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Allowance(from, spender), &amount);
    }

    /// Matches `TokenClient::allowance` exactly.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(from, spender))
            .unwrap_or(0)
    }

    /// Matches `TokenClient::transfer` (simplified: `to: Address` rather
    /// than `MuxedAddress`, since nothing in this project calls plain
    /// `transfer` through the generic `TokenClient` — only `transfer_from`
    /// is exercised that way). Provided for completeness / direct test use.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        Self::move_balance(&env, &from, &to, amount);
    }

    /// Matches `TokenClient::transfer_from` exactly: `(spender, from, to,
    /// amount)`. Authorized by `spender` per SEP-41. When `mandate-registry`
    /// calls this with `spender = its own contract address`, that
    /// `require_auth()` succeeds automatically under Soroban's
    /// same-invocation contract-auth rule (the calling contract is the
    /// direct invoker) — no explicit signature is needed, which is exactly
    /// what makes the bounded-allowance spender model work without the
    /// payer re-signing every charge.
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        assert!(amount > 0, "mock-token: transfer amount must be positive");

        // TEST-ONLY failure injection — see module doc. Checked before any
        // state mutation so a forced failure never partially applies.
        if Self::fail_transfers_enabled(&env) {
            panic!("mock-token: transfer_from forced to fail via set_fail_transfers(true)");
        }

        let allowance_key = DataKey::Allowance(from.clone(), spender.clone());
        let current_allowance: i128 = env.storage().persistent().get(&allowance_key).unwrap_or(0);
        let updated_allowance = current_allowance
            .checked_sub(amount)
            .expect("mock-token: allowance arithmetic overflow");
        if updated_allowance < 0 {
            panic!("mock-token: insufficient allowance");
        }
        env.storage()
            .persistent()
            .set(&allowance_key, &updated_allowance);

        Self::move_balance(&env, &from, &to, amount);
    }

    /// TEST-ONLY. Never present on a real token contract — see module doc.
    /// When `fail` is `true`, every subsequent `transfer_from` call panics
    /// (a real host trap) instead of moving funds, letting tests prove the
    /// mandate-registry rollback invariant against a genuine failure rather
    /// than an assumption. Flip back to `false` to prove a retry with the
    /// same `charge_id` can still succeed afterward.
    pub fn set_fail_transfers(env: Env, fail: bool) {
        env.storage().instance().set(&DataKey::FailTransfers, &fail);
    }

    fn fail_transfers_enabled(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::FailTransfers)
            .unwrap_or(false)
    }

    fn move_balance(env: &Env, from: &Address, to: &Address, amount: i128) {
        let from_balance = Self::balance(env.clone(), from.clone());
        let updated_from = from_balance
            .checked_sub(amount)
            .expect("mock-token: balance arithmetic overflow");
        if updated_from < 0 {
            panic!("mock-token: insufficient balance");
        }
        let to_balance = Self::balance(env.clone(), to.clone());
        let updated_to = to_balance
            .checked_add(amount)
            .expect("mock-token: balance arithmetic overflow");

        env.storage()
            .persistent()
            .set(&DataKey::Balance(from.clone()), &updated_from);
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to.clone()), &updated_to);
    }
}

#[cfg(test)]
mod test {
    use super::{MockToken, MockTokenClient};
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal,
    };

    struct Fixture {
        env: Env,
        contract_id: Address,
    }

    fn setup() -> Fixture {
        let env = Env::default();
        let contract_id = env.register(MockToken, ());
        Fixture { env, contract_id }
    }

    fn client(f: &Fixture) -> MockTokenClient<'_> {
        MockTokenClient::new(&f.env, &f.contract_id)
    }

    #[test]
    fn ping_returns_one() {
        let f = setup();
        assert_eq!(client(&f).ping(), 1);
    }

    #[test]
    fn mint_and_balance_round_trip() {
        let f = setup();
        let account = Address::generate(&f.env);
        assert_eq!(client(&f).balance(&account), 0);
        client(&f).mint(&account, &1_000);
        assert_eq!(client(&f).balance(&account), 1_000);
        client(&f).mint(&account, &500);
        assert_eq!(client(&f).balance(&account), 1_500);
    }

    fn approve_as(f: &Fixture, from: &Address, spender: &Address, amount: i128) {
        let invoke = MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "approve",
            args: (from.clone(), spender.clone(), amount, 0u32).into_val(&f.env),
            sub_invokes: &[],
        };
        let auths = [MockAuth {
            address: from,
            invoke: &invoke,
        }];
        client(f)
            .mock_auths(&auths)
            .approve(from, spender, &amount, &0u32);
    }

    fn transfer_from_as(
        f: &Fixture,
        spender: &Address,
        from: &Address,
        to: &Address,
        amount: i128,
    ) {
        let invoke = MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "transfer_from",
            args: (spender.clone(), from.clone(), to.clone(), amount).into_val(&f.env),
            sub_invokes: &[],
        };
        let auths = [MockAuth {
            address: spender,
            invoke: &invoke,
        }];
        client(f)
            .mock_auths(&auths)
            .transfer_from(spender, from, to, &amount);
    }

    #[test]
    fn approve_and_allowance_round_trip() {
        let f = setup();
        let from = Address::generate(&f.env);
        let spender = Address::generate(&f.env);
        assert_eq!(client(&f).allowance(&from, &spender), 0);
        approve_as(&f, &from, &spender, 300);
        assert_eq!(client(&f).allowance(&from, &spender), 300);
    }

    #[test]
    fn transfer_from_decrements_allowance_and_moves_balance() {
        let f = setup();
        let from = Address::generate(&f.env);
        let to = Address::generate(&f.env);
        let spender = Address::generate(&f.env);
        client(&f).mint(&from, &1_000);
        approve_as(&f, &from, &spender, 400);

        transfer_from_as(&f, &spender, &from, &to, 250);

        assert_eq!(client(&f).balance(&from), 750);
        assert_eq!(client(&f).balance(&to), 250);
        assert_eq!(client(&f).allowance(&from, &spender), 150);
    }

    #[test]
    #[should_panic(expected = "insufficient allowance")]
    fn transfer_from_insufficient_allowance_panics() {
        let f = setup();
        let from = Address::generate(&f.env);
        let to = Address::generate(&f.env);
        let spender = Address::generate(&f.env);
        client(&f).mint(&from, &1_000);
        approve_as(&f, &from, &spender, 100);
        transfer_from_as(&f, &spender, &from, &to, 200);
    }

    #[test]
    #[should_panic(expected = "insufficient balance")]
    fn transfer_from_insufficient_balance_panics() {
        let f = setup();
        let from = Address::generate(&f.env);
        let to = Address::generate(&f.env);
        let spender = Address::generate(&f.env);
        client(&f).mint(&from, &50);
        approve_as(&f, &from, &spender, 1_000);
        transfer_from_as(&f, &spender, &from, &to, 200);
    }

    #[test]
    #[should_panic(expected = "forced to fail")]
    fn set_fail_transfers_forces_transfer_from_to_panic() {
        let f = setup();
        let from = Address::generate(&f.env);
        let to = Address::generate(&f.env);
        let spender = Address::generate(&f.env);
        client(&f).mint(&from, &1_000);
        approve_as(&f, &from, &spender, 1_000);
        client(&f).set_fail_transfers(&true);
        transfer_from_as(&f, &spender, &from, &to, 200);
    }
}
