//! Phase 5 tests: `refund`, `get_refund`, `get_refunded_total`
//! (`refund.rs`). Helpers are duplicated from `test_charge.rs`/
//! `test_period.rs` rather than shared, matching this crate's existing
//! per-test-module convention.
//!
//! Authorization tests use `env.mock_auths`/`MockAuth` — never
//! `mock_all_auths`. A refund's merchant authorization spans *two* levels of
//! the call tree: the top-level `refund` invocation itself
//! (`mandate.merchant.require_auth()` in `refund.rs`), and the nested
//! `TokenClient::transfer` call inside the token contract (`from.require_auth()`
//! there, `from == merchant`). `refund_as` below builds a `MockAuthInvoke`
//! tree with the token `transfer` call as a `sub_invokes` entry under the
//! `refund` root, mirroring exactly what a real merchant wallet would sign.

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, Event as _, IntoVal,
};

use mock_token::{MockToken, MockTokenClient};

use crate::{
    error::Error,
    events, storage,
    types::{AmountRule, Mandate, MandateInput, MandateStatus, PaymentReceipt, RefundReceipt},
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

/// Build the two-level auth tree a real merchant would sign for a refund:
/// the root `refund` invocation, with the nested token `transfer` call
/// (`from = merchant`) as a `sub_invokes` entry. Both levels call
/// `merchant.require_auth()` (once explicitly in `refund.rs`, once inside
/// the token contract's `transfer`), so both must appear in the tree.
fn refund_as(
    f: &Fixture,
    signer: &Address,
    mandate_id: &BytesN<32>,
    payment_id: &BytesN<32>,
    amount: i128,
    refund_id: &BytesN<32>,
) -> Result<RefundReceipt, Error> {
    let transfer_invoke = MockAuthInvoke {
        contract: &f.token_id,
        fn_name: "transfer",
        args: (f.merchant.clone(), f.payer.clone(), amount).into_val(&f.env),
        sub_invokes: &[],
    };
    let refund_invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name: "refund",
        args: (
            mandate_id.clone(),
            payment_id.clone(),
            amount,
            refund_id.clone(),
        )
            .into_val(&f.env),
        sub_invokes: &[transfer_invoke],
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &refund_invoke,
    }];
    let result = client(f)
        .mock_auths(&auths)
        .try_refund(mandate_id, payment_id, &amount, refund_id);
    result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
}

fn refund_success(
    f: &Fixture,
    mandate_id: &BytesN<32>,
    payment_id: &BytesN<32>,
    amount: i128,
    refund_id: &BytesN<32>,
) -> RefundReceipt {
    refund_as(
        f,
        &f.merchant.clone(),
        mandate_id,
        payment_id,
        amount,
        refund_id,
    )
    .expect("refund should succeed with merchant auth")
}

fn pause_as(f: &Fixture, mandate_id: &BytesN<32>) {
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
    client(f).mock_auths(&auths).pause_mandate(mandate_id);
}

fn revoke_as(f: &Fixture, mandate_id: &BytesN<32>) {
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
    client(f).mock_auths(&auths).revoke_mandate(mandate_id);
}

fn raw_refunded_total(f: &Fixture, payment_id: &BytesN<32>) -> i128 {
    f.env.as_contract(&f.contract_id, || {
        storage::get_refunded_total(&f.env, payment_id)
    })
}

fn raw_has_used_refund(f: &Fixture, refund_id: &BytesN<32>) -> bool {
    f.env.as_contract(&f.contract_id, || {
        storage::has_used_refund(&f.env, refund_id)
    })
}

fn raw_refund(f: &Fixture, refund_id: &BytesN<32>) -> Option<RefundReceipt> {
    f.env
        .as_contract(&f.contract_id, || storage::get_refund(&f.env, refund_id))
}

fn raw_mandate(f: &Fixture, mandate_id: &BytesN<32>) -> Mandate {
    f.env.as_contract(&f.contract_id, || {
        storage::get_mandate(&f.env, mandate_id).expect("mandate should exist in storage")
    })
}

fn expect_panic<F: FnOnce()>(body: F) {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(std::boxed::Box::new(|_| {}));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
    std::panic::set_hook(previous_hook);
    assert!(
        result.is_err(),
        "expected the call to panic (host trap), but it completed"
    );
}

// ============================================================
// Happy path — full and partial refunds
// ============================================================

#[test]
fn refund_full_amount_succeeds_balances_and_receipt() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 1));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let refund_id = bytes32(&f.env, 1);
    let refund_receipt = refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &refund_id,
    );

    // Payer balance: -amount (charge) +amount (refund) = starting balance.
    assert_eq!(token(&f).balance(&f.payer), AMPLE_BALANCE);
    // Merchant balance: +amount (charge) -amount (refund) = 0.
    assert_eq!(token(&f).balance(&f.merchant), 0);
    // Contract never holds funds.
    assert_eq!(token(&f).balance(&f.contract_id), 0);

    assert_eq!(refund_receipt.refund_id, refund_id);
    assert_eq!(refund_receipt.payment_id, receipt.payment_id);
    assert_eq!(refund_receipt.amount, FIXED_AMOUNT);
    assert_eq!(refund_receipt.timestamp, START);
    assert_eq!(client(&f).get_refund(&refund_id), refund_receipt);
    assert_eq!(
        client(&f).get_refunded_total(&receipt.payment_id),
        FIXED_AMOUNT
    );
}

#[test]
fn refund_partial_amount_succeeds_refunded_total_correct() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 2));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let partial = FIXED_AMOUNT / 3;
    refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        partial,
        &bytes32(&f.env, 1),
    );

    assert_eq!(client(&f).get_refunded_total(&receipt.payment_id), partial);
    assert_eq!(token(&f).balance(&f.merchant), FIXED_AMOUNT - partial);
    assert_eq!(
        token(&f).balance(&f.payer),
        AMPLE_BALANCE - FIXED_AMOUNT + partial
    );
}

#[test]
fn refund_two_partials_summing_to_exact_total_both_succeed_third_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 3));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let half = FIXED_AMOUNT / 2;
    refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        half,
        &bytes32(&f.env, 1),
    );
    refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT - half,
        &bytes32(&f.env, 2),
    );
    assert_eq!(
        client(&f).get_refunded_total(&receipt.payment_id),
        FIXED_AMOUNT
    );

    // A third refund of any positive amount now exceeds the payment.
    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &receipt.payment_id,
        1,
        &bytes32(&f.env, 3),
    )
    .unwrap_err();
    assert_eq!(err, Error::RefundExceedsPayment);
}

#[test]
fn refund_single_over_refund_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 4));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT + 1,
        &bytes32(&f.env, 1),
    )
    .unwrap_err();
    assert_eq!(err, Error::RefundExceedsPayment);
}

// ============================================================
// Duplicate refund_id — global uniqueness
// ============================================================

#[test]
fn refund_duplicate_refund_id_rejected_even_different_amount() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 5));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let charge_id = bytes32(&f.env, 1);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let refund_id = bytes32(&f.env, 1);
    refund_success(&f, &mandate_id, &receipt.payment_id, 100, &refund_id);

    // Same refund_id, different amount, same payment.
    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &receipt.payment_id,
        200,
        &refund_id,
    )
    .unwrap_err();
    assert_eq!(err, Error::DuplicateRefund);
}

#[test]
fn refund_duplicate_refund_id_rejected_across_different_payments() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 6));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt1 = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    f.env.ledger().set_timestamp(START + MIN_INTERVAL);
    let receipt2 = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let refund_id = bytes32(&f.env, 1);
    refund_success(&f, &mandate_id, &receipt1.payment_id, 100, &refund_id);

    // Same refund_id, a completely different payment under the same mandate —
    // still rejected since UsedRefund(refund_id) has no payment component
    // (global uniqueness, see refund.rs module doc).
    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &receipt2.payment_id,
        100,
        &refund_id,
    )
    .unwrap_err();
    assert_eq!(err, Error::DuplicateRefund);
}

// ============================================================
// Invalid amount
// ============================================================

#[test]
fn refund_zero_amount_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 7));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &receipt.payment_id,
        0,
        &bytes32(&f.env, 1),
    )
    .unwrap_err();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn refund_negative_amount_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 8));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &receipt.payment_id,
        -1,
        &bytes32(&f.env, 1),
    )
    .unwrap_err();
    assert_eq!(err, Error::InvalidAmount);
}

// ============================================================
// Unknown / mismatched payment
// ============================================================

#[test]
fn refund_unknown_payment_id_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 9));

    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 250),
        100,
        &bytes32(&f.env, 1),
    )
    .unwrap_err();
    assert_eq!(err, Error::PaymentNotFound);
}

#[test]
fn refund_unknown_mandate_id_rejected() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 10));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let bogus_mandate_id = bytes32(&f.env, 250);
    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &bogus_mandate_id,
        &receipt.payment_id,
        100,
        &bytes32(&f.env, 1),
    )
    .unwrap_err();
    assert_eq!(err, Error::MandateNotFound);
}

#[test]
fn refund_payment_belonging_to_different_mandate_rejected() {
    let f = setup();
    let mandate_id_a = create_success(&f, &base_input(&f, 11));
    let mut input_b = base_input(&f, 12);
    input_b.client_nonce = bytes32(&f.env, 13);
    let mandate_id_b = create_success(&f, &input_b);
    fund_and_approve(&f, AMPLE_BALANCE * 2, AMPLE_ALLOWANCE * 2);

    // Payment created under mandate A.
    let receipt_a = charge_success(
        &f,
        &mandate_id_a,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // Attempt to refund payment A's id but against mandate B.
    let err = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id_b,
        &receipt_a.payment_id,
        100,
        &bytes32(&f.env, 1),
    )
    .unwrap_err();
    assert_eq!(err, Error::PaymentNotFound);
}

// ============================================================
// Authorization
// ============================================================

#[test]
#[should_panic]
fn refund_signed_by_payer_instead_of_merchant_fails() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 14));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    refund_as(
        &f,
        &f.payer.clone(),
        &mandate_id,
        &receipt.payment_id,
        100,
        &bytes32(&f.env, 1),
    )
    .unwrap();
}

#[test]
#[should_panic]
fn refund_signed_by_random_third_party_fails() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 15));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let third_party = Address::generate(&f.env);
    refund_as(
        &f,
        &third_party,
        &mandate_id,
        &receipt.payment_id,
        100,
        &bytes32(&f.env, 1),
    )
    .unwrap();
}

// ============================================================
// State independence — refunds work regardless of mandate status
// ============================================================

#[test]
fn refund_succeeds_on_revoked_mandate() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 16));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    revoke_as(&f, &mandate_id);
    assert_eq!(
        client(&f).get_mandate(&mandate_id).status,
        MandateStatus::Revoked
    );

    let refund_receipt = refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 1),
    );
    assert_eq!(refund_receipt.amount, FIXED_AMOUNT);
}

#[test]
fn refund_succeeds_on_paused_mandate() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 17));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    pause_as(&f, &mandate_id);
    assert_eq!(
        client(&f).get_mandate(&mandate_id).status,
        MandateStatus::Paused
    );

    let refund_receipt = refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 1),
    );
    assert_eq!(refund_receipt.amount, FIXED_AMOUNT);
}

#[test]
fn refund_succeeds_on_expired_mandate() {
    let f = setup();
    let mut input = base_input(&f, 18);
    input.expires_at = START + 2 * MIN_INTERVAL;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // Advance past expiry. get_mandate computes Expired lazily.
    f.env.ledger().set_timestamp(input.expires_at + 1);
    assert_eq!(
        client(&f).get_mandate(&mandate_id).status,
        MandateStatus::Expired
    );

    let refund_receipt = refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 1),
    );
    assert_eq!(refund_receipt.amount, FIXED_AMOUNT);
}

#[test]
fn refund_succeeds_on_completed_mandate() {
    let f = setup();
    let mut input = base_input(&f, 19);
    input.max_successful_charges = 1;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(
        client(&f).get_mandate(&mandate_id).status,
        MandateStatus::Completed
    );

    let refund_receipt = refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 1),
    );
    assert_eq!(refund_receipt.amount, FIXED_AMOUNT);
    // Still Completed after the refund — see headroom tests below for the
    // full accounting-untouched proof.
    assert_eq!(
        client(&f).get_mandate(&mandate_id).status,
        MandateStatus::Completed
    );
}

// ============================================================
// Headroom NOT restored — the point of this phase
// ============================================================

#[test]
fn refund_does_not_restore_period_headroom() {
    let f = setup();
    let mut input = base_input(&f, 20);
    input.max_per_period = FIXED_AMOUNT; // one charge exactly saturates a period
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // Fully refund it.
    refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 1),
    );

    // current_period_collected must still reflect the ORIGINAL charge — the
    // refund does not decrement it.
    assert_eq!(
        client(&f).get_mandate(&mandate_id).current_period_collected,
        FIXED_AMOUNT
    );

    // A second charge in the SAME period, of the mandate's own fixed amount
    // (the only amount a Fixed-rule mandate will ever accept past step 8),
    // must still be rejected on the period cap — the refund did not free up
    // any period headroom.
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
    assert_eq!(err, Error::AmountExceedsPeriodLimit);
}

#[test]
fn refund_does_not_uncomplete_mandate_or_decrement_successful_charges() {
    let f = setup();
    let mut input = base_input(&f, 21);
    input.max_successful_charges = 1;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    let mandate_before = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate_before.status, MandateStatus::Completed);
    assert_eq!(mandate_before.successful_charges, 1);

    refund_success(
        &f,
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 1),
    );

    let mandate_after = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate_after.status, MandateStatus::Completed);
    assert_eq!(mandate_after.successful_charges, 1);
    assert_eq!(mandate_after.total_collected, FIXED_AMOUNT);
}

// ============================================================
// Rollback — the critical test
// ============================================================

#[test]
fn refund_transfer_failure_rolls_back_and_allows_retry_with_same_refund_id() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 22));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let refund_id = bytes32(&f.env, 1);

    token(&f).set_fail_transfers(&true);

    expect_panic(|| {
        let _ = refund_as(
            &f,
            &f.merchant.clone(),
            &mandate_id,
            &receipt.payment_id,
            FIXED_AMOUNT,
            &refund_id,
        );
    });

    // RefundedTotal unchanged, no RefundReceipt exists, refund_id not marked
    // used.
    assert_eq!(raw_refunded_total(&f, &receipt.payment_id), 0);
    assert!(raw_refund(&f, &refund_id).is_none());
    assert!(!raw_has_used_refund(&f, &refund_id));
    let payment_err = client(&f).try_get_refund(&refund_id).unwrap_err().unwrap();
    assert_eq!(payment_err, Error::RefundNotFound);

    // Flip the token back to working and retry with the SAME refund_id.
    token(&f).set_fail_transfers(&false);
    let refund_receipt = refund_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &receipt.payment_id,
        FIXED_AMOUNT,
        &refund_id,
    )
    .expect("retry with the same refund_id should now succeed");

    assert_eq!(refund_receipt.refund_id, refund_id);
    assert_eq!(
        client(&f).get_refunded_total(&receipt.payment_id),
        FIXED_AMOUNT
    );
    assert_eq!(token(&f).balance(&f.merchant), 0);
}

// ============================================================
// Refund of an older payment doesn't disturb a newer charge's accounting
// ============================================================

#[test]
fn refund_of_older_payment_does_not_disturb_newer_charge_accounting() {
    let f = setup();
    let mut input = base_input(&f, 23);
    input.max_per_period = FIXED_AMOUNT * 10;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let receipt1 = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    f.env.ledger().set_timestamp(START + MIN_INTERVAL);
    let receipt2 = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let mandate_before = raw_mandate(&f, &mandate_id);
    assert_eq!(mandate_before.total_collected, FIXED_AMOUNT * 2);
    assert_eq!(mandate_before.successful_charges, 2);

    // Refund the OLDER payment (receipt1) fully.
    refund_success(
        &f,
        &mandate_id,
        &receipt1.payment_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 1),
    );

    // Newer payment (receipt2) untouched: still retrievable, refunded_total
    // still 0, and mandate accounting (which never decrements on refund)
    // still reflects both original charges.
    assert_eq!(client(&f).get_payment(&receipt2.payment_id), receipt2);
    assert_eq!(client(&f).get_refunded_total(&receipt2.payment_id), 0);
    assert_eq!(
        client(&f).get_refunded_total(&receipt1.payment_id),
        FIXED_AMOUNT
    );
    let mandate_after = raw_mandate(&f, &mandate_id);
    assert_eq!(mandate_after.total_collected, FIXED_AMOUNT * 2);
    assert_eq!(mandate_after.successful_charges, 2);
}

// ============================================================
// Event
// ============================================================

#[test]
fn refund_emits_event_with_full_fields() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 24));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    let refund_id = bytes32(&f.env, 1);
    let partial = FIXED_AMOUNT / 4;
    refund_success(&f, &mandate_id, &receipt.payment_id, partial, &refund_id);

    let expected = events::RefundSucceeded {
        mandate_id: mandate_id.clone(),
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        refund_id: refund_id.clone(),
        payment_id: receipt.payment_id.clone(),
        asset: f.token_id.clone(),
        amount: partial,
        refunded_total_after: partial,
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
// get_refund / get_refunded_total
// ============================================================

#[test]
fn get_refund_nonexistent_rejected() {
    let f = setup();
    let err = client(&f)
        .try_get_refund(&bytes32(&f.env, 250))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, Error::RefundNotFound);
}

#[test]
fn get_refunded_total_defaults_to_zero() {
    let f = setup();
    assert_eq!(client(&f).get_refunded_total(&bytes32(&f.env, 250)), 0);
}
