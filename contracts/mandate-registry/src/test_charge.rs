//! Phase 3 tests: fixed charge execution (`charge`, `get_payment`). A real
//! `MockToken` contract (`contracts/mock-token`) is registered and driven
//! end-to-end — allowance, balance, and `transfer_from` (including the
//! `set_fail_transfers` failure-injection path) are exercised against
//! genuine contract-to-contract invocation, not stubbed.
//!
//! Authorization tests use `env.mock_auths` / `MockAuth` — never
//! `mock_all_auths` — matching the Phase 2 convention (`test_lifecycle.rs`),
//! so a wrong-signer call genuinely fails because no authorization entry
//! matches the address the contract actually calls `require_auth()` on.

use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    Address, BytesN, Env, Event as _, IntoVal, Symbol,
};

use mock_token::{MockToken, MockTokenClient};

use crate::{
    error::Error,
    events, id, storage,
    types::{AmountRule, Mandate, MandateInput, MandateStatus, PaymentReceipt},
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
    let token_id = env.register(MockToken, ());
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

fn token(f: &Fixture) -> MockTokenClient<'_> {
    MockTokenClient::new(&f.env, &f.token_id)
}

fn base_input(f: &Fixture, nonce: u8) -> MandateInput {
    MandateInput {
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.token_id.clone(),
        amount_rule: AmountRule::Fixed(FIXED_AMOUNT),
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

/// Duplicated from `test_lifecycle.rs`'s `create_as`/`create_success`
/// rather than shared — matches the existing per-test-module convention in
/// this crate.
fn create_as(f: &Fixture, signer: &Address, input: &MandateInput) -> Result<BytesN<32>, Error> {
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "create_mandate",
        args: (input.clone(),).into_val(&f.env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    let result = client(f).mock_auths(&auths).try_create_mandate(input);
    result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
}

fn create_success(f: &Fixture, input: &MandateInput) -> BytesN<32> {
    create_as(f, &f.payer.clone(), input).expect("create_mandate should succeed")
}

/// Mint `balance` to the payer (skipped if 0) and approve the mandate
/// contract (the spender) for `allowance`, with the payer's authorization
/// genuinely mocked for the `approve` call — never `mock_all_auths`.
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
    let auths = [MockAuth {
        address: &f.payer,
        invoke: &invoke,
    }];
    token(f)
        .mock_auths(&auths)
        .approve(&f.payer, &f.contract_id, &allowance, &0u32);
}

fn charge_as(
    f: &Fixture,
    signer: &Address,
    mandate_id: &BytesN<32>,
    charge_id: &BytesN<32>,
    amount: i128,
    invoice_hash: &BytesN<32>,
) -> Result<PaymentReceipt, Error> {
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
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    let result =
        client(f)
            .mock_auths(&auths)
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
) -> PaymentReceipt {
    charge_as(
        f,
        &f.merchant.clone(),
        mandate_id,
        charge_id,
        amount,
        invoice_hash,
    )
    .expect("charge should succeed with merchant auth")
}

/// Directly write a mandate into storage bypassing `create_mandate`, so
/// tests can exercise the `Completed` branch even though Phase 3 has no
/// code path that can ever produce it (that lands in Phase 4).
fn store_mandate_with_status(f: &Fixture, mandate_id: &BytesN<32>, status: MandateStatus) {
    let mandate = Mandate {
        id: mandate_id.clone(),
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.token_id.clone(),
        status,
        amount_rule: AmountRule::Fixed(FIXED_AMOUNT),
        max_per_period: FIXED_AMOUNT * 100,
        period_seconds: PERIOD,
        min_interval_seconds: MIN_INTERVAL,
        start_at: START,
        expires_at: EXPIRES,
        max_successful_charges: 0,
        successful_charges: 1,
        total_collected: FIXED_AMOUNT,
        current_period_start: START,
        current_period_collected: FIXED_AMOUNT,
        last_charged_at: Some(START),
        created_at: START,
        metadata_hash: bytes32(&f.env, 0xAA),
    };
    f.env
        .as_contract(&f.contract_id, || storage::set_mandate(&f.env, &mandate));
}

fn raw_mandate(f: &Fixture, mandate_id: &BytesN<32>) -> Mandate {
    f.env.as_contract(&f.contract_id, || {
        storage::get_mandate(&f.env, mandate_id).expect("mandate should exist in storage")
    })
}

fn raw_has_used_charge(f: &Fixture, mandate_id: &BytesN<32>, charge_id: &BytesN<32>) -> bool {
    f.env.as_contract(&f.contract_id, || {
        storage::has_used_charge(&f.env, mandate_id, charge_id)
    })
}

/// Call `body` and assert it panics (a genuine host trap — a missing
/// authorization or a sub-invocation trap such as a forced token failure)
/// without ending the test the way `#[should_panic]` would, so assertions
/// can continue afterward. Used by the rollback test, which must keep
/// inspecting storage after the panic.
fn expect_panic<F: FnOnce()>(body: F) {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(std::boxed::Box::new(|_| {})); // silence the expected panic's output
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    std::panic::set_hook(previous_hook);
    assert!(
        result.is_err(),
        "expected the call to panic (host trap), but it completed"
    );
}

// ============================================================
// Happy path
// ============================================================

#[test]
fn charge_fixed_success_full_accounting_and_balances() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 1));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let invoice_hash = bytes32(&f.env, 0xBB);
    let receipt = charge_success(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);

    // Token balances: merchant +amount, payer -amount, contract untouched.
    assert_eq!(token(&f).balance(&f.merchant), FIXED_AMOUNT);
    assert_eq!(token(&f).balance(&f.payer), AMPLE_BALANCE - FIXED_AMOUNT);
    assert_eq!(token(&f).balance(&f.contract_id), 0);
    // Allowance decremented by exactly the charged amount.
    assert_eq!(
        token(&f).allowance(&f.payer, &f.contract_id),
        AMPLE_ALLOWANCE - FIXED_AMOUNT
    );

    // Receipt stored and retrievable via get_payment.
    let expected_payment_id = id::derive_payment_id(&f.env, &mandate_id, &charge_id);
    assert_eq!(receipt.payment_id, expected_payment_id);
    assert_eq!(receipt.mandate_id, mandate_id);
    assert_eq!(receipt.charge_id, charge_id);
    assert_eq!(receipt.payer, f.payer);
    assert_eq!(receipt.merchant, f.merchant);
    assert_eq!(receipt.asset, f.token_id);
    assert_eq!(receipt.amount, FIXED_AMOUNT);
    assert_eq!(receipt.invoice_hash, invoice_hash);
    assert_eq!(receipt.timestamp, START);
    assert_eq!(client(&f).get_payment(&expected_payment_id), receipt);

    // Mandate accounting.
    let mandate = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate.successful_charges, 1);
    assert_eq!(mandate.total_collected, FIXED_AMOUNT);
    assert_eq!(mandate.current_period_collected, FIXED_AMOUNT);
    assert_eq!(mandate.last_charged_at, Some(START));
}

#[test]
fn charge_requires_merchant_auth_and_records_it() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 2));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let invoice_hash = bytes32(&f.env, 0xBB);
    charge_success(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);

    assert_eq!(
        f.env.auths(),
        std::vec![(
            f.merchant.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    f.contract_id.clone(),
                    Symbol::new(&f.env, "charge"),
                    (
                        mandate_id.clone(),
                        charge_id.clone(),
                        FIXED_AMOUNT,
                        invoice_hash.clone(),
                    )
                        .into_val(&f.env),
                )),
                sub_invocations: std::vec![],
            },
        )]
    );
}

#[test]
fn charge_emits_event_with_full_fields() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 3));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let invoice_hash = bytes32(&f.env, 0xBB);
    let receipt = charge_success(&f, &mandate_id, &charge_id, FIXED_AMOUNT, &invoice_hash);

    let expected = events::ChargeSucceeded {
        mandate_id: mandate_id.clone(),
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        payment_id: receipt.payment_id.clone(),
        charge_id: charge_id.clone(),
        asset: f.token_id.clone(),
        amount: FIXED_AMOUNT,
        invoice_hash: invoice_hash.clone(),
        period_index: 0,
        successful_charge_number: 1,
        timestamp: START,
    };

    let recorded = f.env.events().all();
    assert_eq!(
        recorded,
        soroban_sdk::vec![
            &f.env,
            (
                f.contract_id.clone(),
                expected.topics(&f.env),
                expected.data(&f.env),
            )
        ]
    );
}

// ============================================================
// Rejections — one per specific error code
// ============================================================

#[test]
fn charge_nonexistent_mandate_rejected() {
    let f = setup();
    let mandate_id = bytes32(&f.env, 200);
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::MandateNotFound);
}

#[test]
fn charge_paused_mandate_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 4));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "pause_mandate",
        args: (mandate_id.clone(),).into_val(&f.env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &f.payer,
        invoke: &invoke,
    }];
    client(&f).mock_auths(&auths).pause_mandate(&mandate_id);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::MandatePaused);
}

#[test]
fn charge_revoked_mandate_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 5));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "revoke_mandate",
        args: (mandate_id.clone(),).into_val(&f.env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: &f.payer,
        invoke: &invoke,
    }];
    client(&f).mock_auths(&auths).revoke_mandate(&mandate_id);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::MandateRevoked);
}

#[test]
fn charge_completed_mandate_rejected() {
    let f = setup();
    let mandate_id = bytes32(&f.env, 99);
    store_mandate_with_status(&f, &mandate_id, MandateStatus::Completed);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::MandateCompleted);
}

#[test]
fn charge_before_start_rejected() {
    let f = setup();
    let mut input = base_input(&f, 6);
    input.start_at = START + 5_000;
    input.expires_at = START + 10_000;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // now (START) is still before start_at.
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::ChargeBeforeStart);
}

#[test]
fn charge_exactly_at_start_at_succeeds() {
    let f = setup();
    // Default base_input has start_at == START == the ledger's initial
    // timestamp, so an immediate charge is exactly at the boundary.
    let mandate_id = create_success(&f, &base_input(&f, 7));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
}

#[test]
fn charge_exactly_at_expires_at_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 8));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    f.env.ledger().set_timestamp(EXPIRES);
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::MandateExpired);
}

#[test]
fn charge_zero_amount_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 9));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        0,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn charge_negative_amount_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 10));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        -1,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn charge_fixed_amount_more_than_configured_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 11));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT + 1,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::AmountExceedsChargeLimit);
}

#[test]
fn charge_fixed_amount_less_than_configured_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 12));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // CLAUDE.md §7: a fixed mandate charges exactly the configured amount —
    // a *smaller* amount is also a violation, not just a larger one.
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT - 1,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::AmountExceedsChargeLimit);
}

#[test]
fn charge_too_soon_after_previous_charge_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 13));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    f.env.ledger().set_timestamp(START + MIN_INTERVAL - 1);
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::ChargeTooSoon);
}

#[test]
fn charge_exactly_at_min_interval_boundary_succeeds() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 14));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // Exactly at last_charged_at + min_interval_seconds: >=, not >.
    f.env.ledger().set_timestamp(START + MIN_INTERVAL);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(receipt.timestamp, START + MIN_INTERVAL);
    assert_eq!(client(&f).get_mandate(&mandate_id).successful_charges, 2);
}

#[test]
fn charge_max_successful_charges_reached_rejected() {
    let f = setup();
    let mut input = base_input(&f, 15);
    input.max_successful_charges = 1;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    f.env.ledger().set_timestamp(START + MIN_INTERVAL);
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::ChargeCountExceeded);
}

#[test]
fn charge_insufficient_allowance_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 16));
    fund_and_approve(&f, AMPLE_BALANCE, FIXED_AMOUNT - 1);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::InsufficientAllowance);
}

#[test]
fn charge_insufficient_balance_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 17));
    fund_and_approve(&f, FIXED_AMOUNT - 1, AMPLE_ALLOWANCE);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::InsufficientBalance);
}

// ============================================================
// Replay / duplicate charge_id, including order-precedence
// ============================================================

#[test]
fn charge_duplicate_charge_id_after_success_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 18));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    charge_success(
        &f,
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // Same charge_id, still well within min_interval — proves the
    // duplicate-charge_id check (step 6) fires before the min-interval
    // check (step 9), matching CLAUDE.md §6's exact ordering: if it were
    // checked after, this would instead report ChargeTooSoon.
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::DuplicateCharge);
}

#[test]
fn charge_different_charge_id_after_success_succeeds_subject_to_interval() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 19));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    f.env.ledger().set_timestamp(START + MIN_INTERVAL);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(client(&f).get_mandate(&mandate_id).successful_charges, 2);
    assert_ne!(receipt.charge_id, bytes32(&f.env, 1));
}

// ============================================================
// Authorization
// ============================================================

#[test]
#[should_panic]
fn charge_signed_by_payer_instead_of_merchant_fails() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 20));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_as(
        &f,
        &f.payer.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap();
}

#[test]
#[should_panic]
fn charge_signed_by_relayer_stand_in_fails() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 21));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // The relayer has no on-chain identity distinct from "some other
    // address" — it holds no special spending authority (CLAUDE.md §11).
    let relayer = Address::generate(&f.env);
    charge_as(
        &f,
        &relayer,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap();
}

#[test]
fn charge_cannot_redirect_funds_away_from_stored_merchant() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 22));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // `charge`'s signature has no merchant/destination argument at all —
    // the transfer target can only ever be `mandate.merchant` as read from
    // storage. There is no attacker-controlled address anywhere to try to
    // redirect through; the strongest available proof is that after a
    // legitimately merchant-authorized charge, funds land at the stored
    // merchant and nowhere else, including an arbitrary third-party address
    // standing in for whatever a malicious relayer might have wanted.
    let unrelated_third_party = Address::generate(&f.env);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    assert_eq!(receipt.merchant, f.merchant);
    assert_eq!(token(&f).balance(&f.merchant), FIXED_AMOUNT);
    assert_eq!(token(&f).balance(&unrelated_third_party), 0);
}

// ============================================================
// Rollback — the critical test
// ============================================================

#[test]
fn charge_transfer_failure_rolls_back_and_allows_retry_with_same_charge_id() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 23));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let invoice_hash = bytes32(&f.env, 0xBB);
    let payment_id = id::derive_payment_id(&f.env, &mandate_id, &charge_id);

    token(&f).set_fail_transfers(&true);

    expect_panic(|| {
        let _ = charge_as(
            &f,
            &f.merchant.clone(),
            &mandate_id,
            &charge_id,
            FIXED_AMOUNT,
            &invoice_hash,
        );
    });

    // Accounting must be entirely unchanged — the transfer trapped, so the
    // whole invocation reverted and none of the post-transfer writes stuck.
    let mandate = raw_mandate(&f, &mandate_id);
    assert_eq!(mandate.successful_charges, 0);
    assert_eq!(mandate.total_collected, 0);
    assert_eq!(mandate.current_period_collected, 0);
    assert_eq!(mandate.last_charged_at, None);

    // No receipt was stored.
    let payment_err = client(&f)
        .try_get_payment(&payment_id)
        .unwrap_err()
        .unwrap();
    assert_eq!(payment_err, Error::PaymentNotFound);

    // The charge_id was never marked used — a legitimate retry must still
    // be possible.
    assert!(!raw_has_used_charge(&f, &mandate_id, &charge_id));

    // Flip the token back to working and retry with the SAME charge_id.
    token(&f).set_fail_transfers(&false);
    let receipt = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &invoice_hash,
    )
    .expect("retry with the same charge_id should now succeed");

    assert_eq!(receipt.charge_id, charge_id);
    assert_eq!(client(&f).get_mandate(&mandate_id).successful_charges, 1);
    assert_eq!(token(&f).balance(&f.merchant), FIXED_AMOUNT);
}

// ============================================================
// Variable amount rule (generic step-8 enforcement, implemented now per
// the Phase 3 lead decision even though max_per_period/rollover are
// Phase 4)
// ============================================================

#[test]
fn charge_variable_mandate_success_at_max() {
    let f = setup();
    let mut input = base_input(&f, 24);
    input.amount_rule = AmountRule::Variable(FIXED_AMOUNT);
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
}

#[test]
fn charge_variable_mandate_over_max_rejected() {
    let f = setup();
    let mut input = base_input(&f, 25);
    input.amount_rule = AmountRule::Variable(FIXED_AMOUNT);
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT + 1,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::AmountExceedsChargeLimit);
}

// ============================================================
// get_payment
// ============================================================

#[test]
fn get_payment_nonexistent_rejected() {
    let f = setup();
    let err = client(&f)
        .try_get_payment(&bytes32(&f.env, 250))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::PaymentNotFound);
}
