//! `evil-token`: a SEP-41-shaped token, SAME calling convention as
//! `mock-token`, used **only** by `mandate-registry`'s Phase 6 adversarial
//! tests (`test_adversarial.rs`) to prove CLAUDE.md §7 Token invariants (and
//! PLAN.md §18 invariant 22) hold even against a malicious asset contract.
//!
//! # This contract is TEST-ONLY. Never deploy it.
//!
//! Four failure modes, toggled independently via `set_*` setters (all
//! default off = behaves like a well-behaved token):
//!
//! 1. **`fail_transfers`** — `transfer`/`transfer_from` panic unconditionally
//!    (parity with `mock-token::set_fail_transfers`, kept here too so the
//!    adversarial matrix doesn't need two token contracts for this case).
//! 2. **`lying_mode`** — `transfer`/`transfer_from` return success
//!    immediately, *without moving any balance or decrementing any
//!    allowance*. Models a token whose interface lies about what it did.
//! 3. **`inflated_view_mode`** — `balance`/`allowance` unconditionally report
//!    `i128::MAX` regardless of the real stored ledger, while `transfer`/
//!    `transfer_from` still move (or refuse to move) real, independently
//!    tracked balances/allowances. Models a token whose pre-flight view
//!    functions are inconsistent with what the value-moving call actually
//!    does.
//! 4. **`reentry_target`** — when set, `transfer_from` attempts to call back
//!    into a caller-specified contract/function (in practice,
//!    `mandate-registry::charge` on the same mandate) via the *standard*
//!    `Env::invoke_contract` cross-contract call path, before moving any
//!    balance. This is deliberately the plain (non-`try_`) call: a real
//!    malicious token calling back through the normal SDK path gets exactly
//!    this behavior, not a hand-picked lenient one. See `test_adversarial.rs`
//!    for what the Soroban host actually does with it (short version: the
//!    host's `ContractReentryMode::Prohibited` default rejects *any* call
//!    back into a contract already on the invocation stack, so this call
//!    itself traps — and since `Env::invoke_contract`'s generated binding
//!    unwraps that trap, the trap propagates and the *entire* outer
//!    `charge()` invocation aborts with it, taking every storage write made
//!    so far down with it. There is no partial-mutation path to reach.)
#![no_std]

#[cfg(test)]
extern crate std;

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};

#[contract]
pub struct EvilToken;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Balance(Address),
    /// `(from, spender)`, mirroring `mock-token`'s allowance key shape.
    Allowance(Address, Address),
    FailTransfers,
    LyingMode,
    InflatedViewMode,
    /// The `mandate-registry` contract address to call back into. Presence
    /// of this key is what turns reentry-on-`transfer_from` on; there is no
    /// separate boolean flag.
    ReentryTarget,
    ReentryMandateId,
    ReentryChargeId,
    ReentryAmount,
    ReentryInvoiceHash,
}

#[contractimpl]
impl EvilToken {
    pub fn ping(_env: Env) -> u32 {
        1
    }

    /// TEST-ONLY, no authorization check — same convention as `mock-token`.
    pub fn mint(env: Env, to: Address, amount: i128) {
        assert!(amount > 0, "evil-token: mint amount must be positive");
        let current = Self::real_balance(&env, &to);
        let updated = current
            .checked_add(amount)
            .expect("evil-token: balance arithmetic overflow");
        env.storage()
            .persistent()
            .set(&DataKey::Balance(to), &updated);
    }

    /// Reports `i128::MAX` unconditionally when `inflated_view_mode` is on,
    /// regardless of the real stored balance — see mode 3 in the module doc.
    pub fn balance(env: Env, id: Address) -> i128 {
        if Self::inflated_view_enabled(&env) {
            return i128::MAX;
        }
        Self::real_balance(&env, &id)
    }

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

    /// Reports `i128::MAX` unconditionally when `inflated_view_mode` is on —
    /// see mode 3 in the module doc.
    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        if Self::inflated_view_enabled(&env) {
            return i128::MAX;
        }
        Self::real_allowance(&env, &from, &spender)
    }

    /// Matches `TokenClient::transfer` (simplified `to: Address`, same
    /// deviation `mock-token` documents). Honors `fail_transfers` and
    /// `lying_mode`.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "evil-token: transfer amount must be positive");

        if Self::fail_transfers_enabled(&env) {
            panic!("evil-token: transfer forced to fail via set_fail_transfers(true)");
        }
        if Self::lying_mode_enabled(&env) {
            // Report success without moving anything — mode 2.
            return;
        }

        Self::move_balance(&env, &from, &to, amount);
    }

    /// Matches `TokenClient::transfer_from` exactly. Honors `fail_transfers`,
    /// `lying_mode`, and — before touching any state — an armed
    /// `reentry_target` (mode 4, see module doc for exactly what happens).
    pub fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128) {
        spender.require_auth();
        assert!(amount > 0, "evil-token: transfer amount must be positive");

        if Self::fail_transfers_enabled(&env) {
            panic!("evil-token: transfer_from forced to fail via set_fail_transfers(true)");
        }

        // Mode 4: attempt the callback first, mirroring a real reentrancy
        // attempt that tries to act *before* this call's own effects land.
        if let Some(target) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::ReentryTarget)
        {
            let mandate_id: BytesN<32> = env
                .storage()
                .instance()
                .get(&DataKey::ReentryMandateId)
                .expect("evil-token: reentry armed without mandate_id");
            let charge_id: BytesN<32> = env
                .storage()
                .instance()
                .get(&DataKey::ReentryChargeId)
                .expect("evil-token: reentry armed without charge_id");
            let reentry_amount: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ReentryAmount)
                .expect("evil-token: reentry armed without amount");
            let invoice_hash: BytesN<32> = env
                .storage()
                .instance()
                .get(&DataKey::ReentryInvoiceHash)
                .expect("evil-token: reentry armed without invoice_hash");

            let args: Vec<Val> = Vec::from_array(
                &env,
                [
                    mandate_id.into_val(&env),
                    charge_id.into_val(&env),
                    reentry_amount.into_val(&env),
                    invoice_hash.into_val(&env),
                ],
            );
            // Plain (non-`try_`) cross-contract call: the standard path a
            // real token would use. If the host rejects this as reentry, the
            // panic this produces propagates straight out of THIS call too —
            // deliberately not caught here, see module doc mode 4.
            let _: Val = env.invoke_contract(&target, &Symbol::new(&env, "charge"), args);
        }

        if Self::lying_mode_enabled(&env) {
            // Report success without moving anything or touching the
            // allowance — mode 2.
            return;
        }

        let allowance_key = DataKey::Allowance(from.clone(), spender.clone());
        let current_allowance: i128 = env.storage().persistent().get(&allowance_key).unwrap_or(0);
        let updated_allowance = current_allowance
            .checked_sub(amount)
            .expect("evil-token: allowance arithmetic overflow");
        if updated_allowance < 0 {
            panic!("evil-token: insufficient allowance");
        }
        env.storage()
            .persistent()
            .set(&allowance_key, &updated_allowance);

        Self::move_balance(&env, &from, &to, amount);
    }

    /// TEST-ONLY. Mode 1 (see module doc).
    pub fn set_fail_transfers(env: Env, fail: bool) {
        env.storage().instance().set(&DataKey::FailTransfers, &fail);
    }

    /// TEST-ONLY. Mode 2 (see module doc).
    pub fn set_lying_mode(env: Env, lying: bool) {
        env.storage().instance().set(&DataKey::LyingMode, &lying);
    }

    /// TEST-ONLY. Mode 3 (see module doc).
    pub fn set_inflated_view_mode(env: Env, inflated: bool) {
        env.storage()
            .instance()
            .set(&DataKey::InflatedViewMode, &inflated);
    }

    /// TEST-ONLY. Arms mode 4: the next `transfer_from` call attempts to
    /// invoke `charge(mandate_id, charge_id, amount, invoice_hash)` on
    /// `target` before moving any balance. See module doc.
    pub fn set_reentry_target(
        env: Env,
        target: Address,
        mandate_id: BytesN<32>,
        charge_id: BytesN<32>,
        amount: i128,
        invoice_hash: BytesN<32>,
    ) {
        env.storage()
            .instance()
            .set(&DataKey::ReentryTarget, &target);
        env.storage()
            .instance()
            .set(&DataKey::ReentryMandateId, &mandate_id);
        env.storage()
            .instance()
            .set(&DataKey::ReentryChargeId, &charge_id);
        env.storage()
            .instance()
            .set(&DataKey::ReentryAmount, &amount);
        env.storage()
            .instance()
            .set(&DataKey::ReentryInvoiceHash, &invoice_hash);
    }

    fn fail_transfers_enabled(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::FailTransfers)
            .unwrap_or(false)
    }

    fn lying_mode_enabled(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::LyingMode)
            .unwrap_or(false)
    }

    fn inflated_view_enabled(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::InflatedViewMode)
            .unwrap_or(false)
    }

    fn real_balance(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id.clone()))
            .unwrap_or(0)
    }

    fn real_allowance(env: &Env, from: &Address, spender: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Allowance(from.clone(), spender.clone()))
            .unwrap_or(0)
    }

    fn move_balance(env: &Env, from: &Address, to: &Address, amount: i128) {
        let from_balance = Self::real_balance(env, from);
        let updated_from = from_balance
            .checked_sub(amount)
            .expect("evil-token: balance arithmetic overflow");
        if updated_from < 0 {
            panic!("evil-token: insufficient balance");
        }
        let to_balance = Self::real_balance(env, to);
        let updated_to = to_balance
            .checked_add(amount)
            .expect("evil-token: balance arithmetic overflow");

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
    use super::{EvilToken, EvilTokenClient};
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke},
        Address, Env, IntoVal,
    };

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register(EvilToken, ());
        (env, contract_id)
    }

    #[test]
    fn ping_and_mint_behave_like_a_normal_token() {
        let (env, contract_id) = setup();
        let client = EvilTokenClient::new(&env, &contract_id);
        assert_eq!(client.ping(), 1);
        let account = Address::generate(&env);
        client.mint(&account, &1_000);
        assert_eq!(client.balance(&account), 1_000);
    }

    #[test]
    fn lying_mode_moves_nothing_but_reports_success() {
        let (env, contract_id) = setup();
        let client = EvilTokenClient::new(&env, &contract_id);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        client.mint(&from, &1_000);
        client.set_lying_mode(&true);

        let invoke = MockAuthInvoke {
            contract: &contract_id,
            fn_name: "transfer",
            args: (from.clone(), to.clone(), 400i128).into_val(&env),
            sub_invokes: &[],
        };
        client
            .mock_auths(&[MockAuth {
                address: &from,
                invoke: &invoke,
            }])
            .transfer(&from, &to, &400);

        assert_eq!(client.balance(&from), 1_000);
        assert_eq!(client.balance(&to), 0);
    }

    #[test]
    fn inflated_view_mode_reports_max_regardless_of_real_balance() {
        let (env, contract_id) = setup();
        let client = EvilTokenClient::new(&env, &contract_id);
        let account = Address::generate(&env);
        client.set_inflated_view_mode(&true);
        assert_eq!(client.balance(&account), i128::MAX);
        assert_eq!(client.allowance(&account, &account), i128::MAX);
    }
}
