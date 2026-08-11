//! Phase 6 adversarial matrix (PLAN.md §20.5, CLAUDE.md §7 Token invariants,
//! PLAN.md §18 invariant 22). Every test here registers `evil_token::EvilToken`
//! (`contracts/evil-token`) as the mandate's asset instead of `mock-token`,
//! so the mandate contract is exercised against a token that actively tries
//! to misbehave, not just one that can be told to fail cleanly.
//!
//! Helpers are duplicated from `test_charge.rs`'s conventions rather than
//! shared, matching this crate's existing per-test-module pattern.

use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal,
};

use evil_token::{EvilToken, EvilTokenClient};

use crate::{
    error::Error,
    storage,
    types::{AmountRule, MandateInput},
    MandateRegistry, MandateRegistryClient,
};

const DAY: u64 = 24 * 60 * 60;
const START: u64 = 1_000;
const PERIOD: u64 = 30 * DAY;
const EXPIRES: u64 = START + 365 * DAY;
const FIXED_AMOUNT: i128 = 150_000_000;
const MIN_INTERVAL: u64 = 1_000;
const AMPLE_BALANCE: i128 = FIXED_AMOUNT * 100;
const AMPLE_ALLOWANCE: i128 = FIXED_AMOUNT * 100;

struct Fixture {
    env: Env,
    contract_id: Address,
    token_id: Address,
    payer: Address,
    merchant: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.ledger().set_timestamp(START);
    let contract_id = env.register(MandateRegistry, ());
    let token_id = env.register(EvilToken, ());
    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);
    Fixture {
        env,
        contract_id,
        token_id,
        payer,
        merchant,
    }
}

fn bytes32(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

fn client(f: &Fixture) -> MandateRegistryClient<'_> {
    MandateRegistryClient::new(&f.env, &f.contract_id)
}

fn token(f: &Fixture) -> EvilTokenClient<'_> {
    EvilTokenClient::new(&f.env, &f.token_id)
}

fn base_input(f: &Fixture, nonce: u8, amount_rule: AmountRule) -> MandateInput {
    MandateInput {
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.token_id.clone(),
        amount_rule,
        max_per_period: FIXED_AMOUNT * 100,
        period_seconds: PERIOD,
        min_interval_seconds: MIN_INTERVAL,
        start_at: START,
        expires_at: EXPIRES,
        max_successful_charges: 0,
        metadata_hash: bytes32(&f.env, 0xAA),
        client_nonce: bytes32(&f.env, nonce),
    }
}

fn create_success(f: &Fixture, input: &MandateInput) -> BytesN<32> {
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "create_mandate",
        args: (input.clone(),).into_val(&f.env),
        sub_invokes: &[],
    };
    let result = client(f)
        .mock_auths(&[MockAuth {
            address: &f.payer,
            invoke: &invoke,
        }])
        .try_create_mandate(input);
    result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
        .expect("create_mandate should succeed")
}

fn fund_and_approve(f: &Fixture, balance: i128, allowance: i128) {
    if balance > 0 {
        token(f).mint(&f.payer, &balance);
    }
    let invoke = MockAuthInvoke {
        contract: &f.token_id,
        fn_name: "approve",
        args: (f.payer.clone(), f.contract_id.clone(), allowance, 0u32).into_val(&f.env),
        sub_invokes: &[],
    };
    token(f)
        .mock_auths(&[MockAuth {
            address: &f.payer,
            invoke: &invoke,
        }])
        .approve(&f.payer, &f.contract_id, &allowance, &0u32);
}

fn charge_as(
    f: &Fixture,
    mandate_id: &BytesN<32>,
    charge_id: &BytesN<32>,
    amount: i128,
    invoice_hash: &BytesN<32>,
) -> Result<crate::types::PaymentReceipt, Error> {
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "charge",
        args: (
            mandate_id.clone(),
            charge_id.clone(),
            amount,
            invoice_hash.clone(),
        )
            .into_val(&f.env),
        sub_invokes: &[],
    };
    let result = client(f)
        .mock_auths(&[MockAuth {
            address: &f.merchant,
            invoke: &invoke,
        }])
        .try_charge(mandate_id, charge_id, &amount, invoice_hash);
    result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
}

fn charge_success(
    f: &Fixture,
    mandate_id: &BytesN<32>,
    charge_id: &BytesN<32>,
    amount: i128,
    invoice_hash: &BytesN<32>,
) -> crate::types::PaymentReceipt {
    charge_as(f, mandate_id, charge_id, amount, invoice_hash).expect("charge should succeed")
}

fn revoke_as(f: &Fixture, mandate_id: &BytesN<32>) -> Result<(), Error> {
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "revoke_mandate",
        args: (mandate_id.clone(),).into_val(&f.env),
        sub_invokes: &[],
    };
    let result = client(f)
        .mock_auths(&[MockAuth {
            address: &f.payer,
            invoke: &invoke,
        }])
        .try_revoke_mandate(mandate_id);
    result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
}

/// Run `f`, silencing the panic hook, and assert it panicked/trapped. Mirrors
/// `tasks/lessons.md`'s documented pattern for inspecting storage after an
/// expected contract-level panic without `#[should_panic]` ending the test.
fn expect_trap<F: FnOnce()>(f: F) {
    let prev_hook = std::panic::take_hook();
    std::panic::set_hook(std::boxed::Box::new(|_| {}));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    std::panic::set_hook(prev_hook);
    assert!(
        result.is_err(),
        "expected the call to panic/trap, but it returned normally"
    );
}

fn zero_accounting_untouched(f: &Fixture, mandate_id: &BytesN<32>) {
    let mandate = f.env.as_contract(&f.contract_id, || {
        storage::get_mandate(&f.env, mandate_id).expect("mandate must still exist")
    });
    assert_eq!(
        mandate.successful_charges, 0,
        "successful_charges must be untouched"
    );
    assert_eq!(
        mandate.total_collected, 0,
        "total_collected must be untouched"
    );
    assert_eq!(
        mandate.current_period_collected, 0,
        "current_period_collected must be untouched"
    );
    assert!(
        mandate.last_charged_at.is_none(),
        "last_charged_at must be untouched"
    );
}

fn payment_receipt_absent(f: &Fixture, mandate_id: &BytesN<32>, charge_id: &BytesN<32>) {
    f.env.as_contract(&f.contract_id, || {
        assert!(
            !storage::has_used_charge(&f.env, mandate_id, charge_id),
            "charge_id must not be marked used after a rolled-back charge"
        );
    });
}

// ============================================================
// Reentrancy — hard mode (the standard `Env::invoke_contract` path)
// ============================================================

/// A token whose `transfer_from` calls back into `charge` on the SAME
/// mandate with the SAME `charge_id` as the outer call. Soroban's host
/// enforces `ContractReentryMode::Prohibited` for every guest-to-guest call
/// made via the standard `invoke_contract`/`try_invoke_contract` path
/// (verified against `soroban-env-host-27.0.1`'s `host/frame.rs:924-956` and
/// `host.rs`'s `default_external_call()`, which hard-codes `Prohibited`) —
/// `mandate-registry` is already on the call stack (it invoked the token,
/// which is trying to invoke it back), so the host rejects the callback
/// with "Contract re-entry is not allowed" *before* any of `charge`'s own
/// logic runs a second time. Because `evil-token` uses the plain
/// (non-`try_`) `invoke_contract` binding, that rejection unwinds as a
/// genuine panic straight back through `transfer_from`, through the outer
/// `charge`'s `TokenClient::transfer_from` call, and out of the whole
/// invocation — so the *entire* first-order charge is rolled back too,
/// not just the reentrant attempt. There is no window in which any
/// mandate-registry logic ran twice, and no partial mutation to find.
#[test]
fn reentrant_transfer_from_same_charge_id_aborts_whole_charge_no_state_change() {
    let f = setup();
    let input = base_input(&f, 1, AmountRule::Fixed(FIXED_AMOUNT));
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 0x10);
    let invoice_hash = bytes32(&f.env, 0x11);

    token(&f).set_reentry_target(
        &f.contract_id,
        &mandate_id,
        &charge_id, // same charge_id as the outer call
        &FIXED_AMOUNT,
        &invoice_hash,
    );

    expect_trap(|| {
        let _ = charge_as(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);
    });

    zero_accounting_untouched(&f, &mandate_id);
    payment_receipt_absent(&f, &mandate_id, &charge_id);
    assert_eq!(
        token(&f).balance(&f.contract_id),
        0,
        "contract must never hold funds"
    );
    assert_eq!(
        token(&f).balance(&f.merchant),
        0,
        "merchant must not have been paid"
    );
}

/// Same attack, but the reentrant callback uses a *different* `charge_id`
/// than the outer call — proving the host's rejection is about the
/// **contract already being on the call stack**, not about which
/// `charge_id` is used. The outcome is identical: the whole invocation
/// aborts before either charge_id's accounting is touched.
#[test]
fn reentrant_transfer_from_different_charge_id_aborts_whole_charge_no_state_change() {
    let f = setup();
    let input = base_input(&f, 2, AmountRule::Fixed(FIXED_AMOUNT));
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let outer_charge_id = bytes32(&f.env, 0x20);
    let reentrant_charge_id = bytes32(&f.env, 0x21);
    let invoice_hash = bytes32(&f.env, 0x22);

    token(&f).set_reentry_target(
        &f.contract_id,
        &mandate_id,
        &reentrant_charge_id,
        &FIXED_AMOUNT,
        &invoice_hash,
    );

    expect_trap(|| {
        let _ = charge_as(
            &f,
            &mandate_id,
            &outer_charge_id,
            FIXED_AMOUNT,
            &invoice_hash,
        );
    });

    zero_accounting_untouched(&f, &mandate_id);
    payment_receipt_absent(&f, &mandate_id, &outer_charge_id);
    payment_receipt_absent(&f, &mandate_id, &reentrant_charge_id);
}

// ============================================================
// Lying token — reports success without moving value
// ============================================================

/// A token whose `transfer_from` returns success unconditionally without
/// moving any balance or decrementing any allowance. `mandate-registry` has
/// no way to observe this from inside `charge` — the token's return value
/// (a plain success, since `transfer_from` never traps) *is* its only
/// signal, per SEP-41. So the mandate's own books stay internally
/// consistent (a receipt is stored, `successful_charges`/`total_collected`
/// advance by exactly `amount`, matching every other invariant this suite
/// checks) — but no real economic value moved. This is the honest boundary
/// of PLAN.md §18 invariant 22: the contract cannot force a lying token to
/// move real value; it can only guarantee its *own* accounting stays
/// self-consistent with what the token *claimed* to have done.
#[test]
fn lying_token_keeps_mandate_books_self_consistent_but_moves_no_real_value() {
    let f = setup();
    let input = base_input(&f, 3, AmountRule::Fixed(FIXED_AMOUNT));
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    token(&f).set_lying_mode(&true);

    let charge_id = bytes32(&f.env, 0x30);
    let invoice_hash = bytes32(&f.env, 0x31);
    let receipt = charge_success(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);
    assert_eq!(receipt.amount, FIXED_AMOUNT);

    // The mandate's own books are internally self-consistent...
    let mandate = f.env.as_contract(&f.contract_id, || {
        storage::get_mandate(&f.env, &mandate_id).expect("exists")
    });
    assert_eq!(mandate.successful_charges, 1);
    assert_eq!(mandate.total_collected, FIXED_AMOUNT);
    f.env.as_contract(&f.contract_id, || {
        assert!(storage::has_used_charge(&f.env, &mandate_id, &charge_id));
    });

    // ...but the token's ledger proves no real value actually moved.
    assert_eq!(
        token(&f).balance(&f.payer),
        AMPLE_BALANCE,
        "payer must be unaffected by a lying transfer"
    );
    assert_eq!(
        token(&f).balance(&f.merchant),
        0,
        "merchant never actually received anything"
    );
    assert_eq!(
        token(&f).allowance(&f.payer, &f.contract_id),
        AMPLE_ALLOWANCE,
        "a lying transfer_from must not even have decremented the allowance"
    );
}

// ============================================================
// Inconsistent balance reporting: inflated view vs. real transfer
// ============================================================

/// A token whose `balance`/`allowance` **view** functions always report
/// `i128::MAX` (fooling `charge.rs`'s advisory steps 13/14 pre-flight
/// checks), while the real, independently-tracked balance backing
/// `transfer_from` is genuinely insufficient. The pre-flight check is
/// fooled and lets the call proceed to the real transfer — which then
/// really fails, and `charge.rs`'s "accounting mutates only after the
/// transfer succeeds" discipline (not the pre-flight check) is what
/// actually protects the mandate's books here.
#[test]
fn inflated_view_fools_preflight_but_real_transfer_failure_still_rolls_back() {
    let f = setup();
    let input = base_input(&f, 4, AmountRule::Fixed(FIXED_AMOUNT));
    let mandate_id = create_success(&f, &input);
    // Real balance is far below FIXED_AMOUNT; approve generously so the
    // pre-flight allowance check (also inflated, but let's not conflate the
    // two) isn't the one doing the rejecting here.
    fund_and_approve(&f, 10, AMPLE_ALLOWANCE);
    token(&f).set_inflated_view_mode(&true);

    // Pre-flight checks now see i128::MAX for both balance and allowance.
    assert_eq!(token(&f).balance(&f.payer), i128::MAX);
    assert_eq!(token(&f).allowance(&f.payer, &f.contract_id), i128::MAX);

    let charge_id = bytes32(&f.env, 0x40);
    let invoice_hash = bytes32(&f.env, 0x41);

    expect_trap(|| {
        let _ = charge_as(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);
    });

    zero_accounting_untouched(&f, &mandate_id);
    payment_receipt_absent(&f, &mandate_id, &charge_id);
}

// ============================================================
// Panicking token (parity: evil-token's own fail-flag, per the brief's
// request that this be part of the same adversarial matrix)
// ============================================================

#[test]
fn panicking_transfer_from_via_evil_token_rolls_back_cleanly() {
    let f = setup();
    let input = base_input(&f, 5, AmountRule::Fixed(FIXED_AMOUNT));
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    token(&f).set_fail_transfers(&true);

    let charge_id = bytes32(&f.env, 0x50);
    let invoice_hash = bytes32(&f.env, 0x51);

    expect_trap(|| {
        let _ = charge_as(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);
    });

    zero_accounting_untouched(&f, &mandate_id);
    payment_receipt_absent(&f, &mandate_id, &charge_id);

    // Flipping the flag back off proves the same charge_id can still
    // succeed afterward (parity with mock-token's own test).
    token(&f).set_fail_transfers(&false);
    let receipt = charge_success(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);
    assert_eq!(receipt.amount, FIXED_AMOUNT);
}

// ============================================================
// charge_id reuse after a successful charge
// ============================================================

#[test]
fn charge_id_reuse_after_success_is_rejected_and_does_not_double_spend() {
    let f = setup();
    let input = base_input(&f, 6, AmountRule::Fixed(FIXED_AMOUNT));
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 0x60);
    let invoice_hash = bytes32(&f.env, 0x61);
    charge_success(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);

    let merchant_balance_after_first = token(&f).balance(&f.merchant);
    assert_eq!(merchant_balance_after_first, FIXED_AMOUNT);

    let result = charge_as(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);
    assert_eq!(result, Err(Error::DuplicateCharge));

    // No double-spend: merchant balance and mandate accounting unchanged by
    // the rejected replay.
    assert_eq!(token(&f).balance(&f.merchant), merchant_balance_after_first);
    let mandate = f.env.as_contract(&f.contract_id, || {
        storage::get_mandate(&f.env, &mandate_id).expect("exists")
    });
    assert_eq!(mandate.successful_charges, 1);
    assert_eq!(mandate.total_collected, FIXED_AMOUNT);
}

// ============================================================
// Charge-vs-revoke ordering
// ============================================================

#[test]
fn revoke_immediately_blocks_any_later_charge_attempt() {
    let f = setup();
    let input = base_input(&f, 7, AmountRule::Fixed(FIXED_AMOUNT));
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let first_charge_id = bytes32(&f.env, 0x70);
    let invoice_hash = bytes32(&f.env, 0x71);
    charge_success(
        &f,
        &mandate_id,
        &first_charge_id,
        FIXED_AMOUNT,
        &invoice_hash,
    );

    revoke_as(&f, &mandate_id).expect("revoke should succeed");

    let second_charge_id = bytes32(&f.env, 0x72);
    let result = charge_as(
        &f,
        &mandate_id,
        &second_charge_id,
        FIXED_AMOUNT,
        &invoice_hash,
    );
    assert_eq!(result, Err(Error::MandateRevoked));

    // The first, legitimate charge's receipt survives revocation
    // untouched; no second receipt was ever created.
    let mandate = f.env.as_contract(&f.contract_id, || {
        storage::get_mandate(&f.env, &mandate_id).expect("exists")
    });
    assert_eq!(mandate.successful_charges, 1);
    assert_eq!(mandate.total_collected, FIXED_AMOUNT);
}

// ============================================================
// Period-boundary race
// ============================================================

/// A charge one second before a period boundary that would exceed the
/// *current* period's remaining headroom must be rejected; the identical
/// amount one second later, exactly on the new period boundary, must
/// succeed because the period has genuinely rolled over. Proves the
/// boundary comparison in `charge.rs` (`computed_period_start !=
/// current_period_start`) is exact, not off-by-one in either direction.
#[test]
fn period_boundary_is_exact_not_off_by_one() {
    let f = setup();
    // Variable rule with a period cap equal to the per-charge cap, so a
    // single charge fully consumes one period's headroom.
    let mut input = base_input(&f, 8, AmountRule::Variable(FIXED_AMOUNT));
    input.max_per_period = FIXED_AMOUNT;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id_1 = bytes32(&f.env, 0x80);
    let invoice_hash = bytes32(&f.env, 0x81);
    charge_success(&f, &mandate_id, &charge_id_1, FIXED_AMOUNT, &invoice_hash);

    // One second before the next period boundary: still the same period,
    // headroom fully consumed -> must reject.
    let next_boundary = START + PERIOD;
    f.env.ledger().set_timestamp(next_boundary - 1);
    let charge_id_2 = bytes32(&f.env, 0x82);
    let result = charge_as(&f, &mandate_id, &charge_id_2, 1, &invoice_hash);
    assert_eq!(result, Err(Error::AmountExceedsPeriodLimit));

    // Exactly on the boundary: a fresh period, full headroom restored.
    f.env.ledger().set_timestamp(next_boundary);
    let charge_id_3 = bytes32(&f.env, 0x83);
    let receipt = charge_success(&f, &mandate_id, &charge_id_3, FIXED_AMOUNT, &invoice_hash);
    assert_eq!(receipt.amount, FIXED_AMOUNT);

    let mandate = f.env.as_contract(&f.contract_id, || {
        storage::get_mandate(&f.env, &mandate_id).expect("exists")
    });
    assert_eq!(mandate.current_period_start, next_boundary);
    assert_eq!(mandate.current_period_collected, FIXED_AMOUNT);
    assert_eq!(mandate.successful_charges, 2);
    assert_eq!(mandate.total_collected, FIXED_AMOUNT * 2);
}
