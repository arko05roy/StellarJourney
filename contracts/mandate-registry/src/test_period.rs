//! Phase 4 tests: billing-period rollover, `max_per_period` enforcement, and
//! the `Completed` transition (`charge.rs` steps 11-12 plus the post-transfer
//! completion check). Helpers are duplicated from `test_charge.rs` rather
//! than shared, matching this crate's existing per-test-module convention
//! (see that file's own note on the same pattern).
//!
//! Unless a test overrides it, the default mandate here is a `Fixed`-rule
//! mandate whose `max_per_period` exactly equals the fixed amount — i.e. one
//! charge fully saturates a period. That makes rollover/boundary/skip tests
//! easy to reason about: a second charge in the *same* period always
//! violates the cap (proving "still old period"), while a charge in a *new*
//! period always succeeds with a freshly reset allowance.

use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, Event as _, IntoVal,
};

use mock_token::{MockToken, MockTokenClient};

use crate::{
    error::Error,
    events, storage,
    types::{AmountRule, Mandate, MandateInput, MandateStatus, PaymentReceipt},
    MandateRegistry, MandateRegistryClient,
};

const START: u64 = 1_000;
const PERIOD_SECONDS: u64 = 1_000;
const MIN_INTERVAL: u64 = 10;
const EXPIRES: u64 = START + 1_000 * PERIOD_SECONDS;
const FIXED_AMOUNT: i128 = 100_000_000;
const AMPLE_BALANCE: i128 = FIXED_AMOUNT * 1_000;
const AMPLE_ALLOWANCE: i128 = FIXED_AMOUNT * 1_000;

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

/// Default: `Fixed(FIXED_AMOUNT)` with `max_per_period == FIXED_AMOUNT` — one
/// charge exactly saturates a period. Override `amount_rule`/`max_per_period`
/// for tests that need a variable rule or headroom for multiple charges.
fn base_input(f: &Fixture, nonce: u8) -> MandateInput {
    MandateInput {
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.token_id.clone(),
        amount_rule: AmountRule::Fixed(FIXED_AMOUNT),
        max_per_period: FIXED_AMOUNT,
        period_seconds: PERIOD_SECONDS,
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
    // Deliberately makes no further contract calls after `try_charge` (not
    // even the balance invariant check) — `env.events().all()`/`env.auths()`
    // only reflect the *last* contract invocation, so a helper call made
    // here would silently erase them for any caller that wants to inspect
    // the charge's own events/auths afterward. Callers that don't need
    // that call `assert_contract_holds_nothing` explicitly afterward
    // instead (CLAUDE.md §7 Tokens invariant spot-check).
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

/// Invariant spot-check (CLAUDE.md §7 Tokens): the contract must never
/// retain payment funds even transiently. Call this *after* any
/// `env.events()`/`env.auths()` inspection of the preceding charge, since
/// this itself is a contract invocation that would otherwise clobber them.
fn assert_contract_holds_nothing(f: &Fixture) {
    assert_eq!(token(f).balance(&f.contract_id), 0);
}

/// Directly write a mandate into storage, bypassing `create_mandate`'s own
/// input validation, so tests can exercise period states (e.g. `max_per_period
/// < max_per_charge`) that the public API would never allow to be created —
/// proving `charge`'s step-12 check is a real, independent defense layer and
/// not merely unreachable because step 8 already caught it. Matches the
/// `store_mandate_with_status` precedent in `test_charge.rs`.
#[allow(clippy::too_many_arguments)]
fn store_mandate_custom(
    f: &Fixture,
    mandate_id: &BytesN<32>,
    amount_rule: AmountRule,
    max_per_period: i128,
    max_successful_charges: u32,
    successful_charges: u32,
    current_period_start: u64,
    current_period_collected: i128,
    last_charged_at: Option<u64>,
) {
    let mandate = Mandate {
        id: mandate_id.clone(),
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.token_id.clone(),
        status: MandateStatus::Active,
        amount_rule,
        max_per_period,
        period_seconds: PERIOD_SECONDS,
        min_interval_seconds: MIN_INTERVAL,
        start_at: START,
        expires_at: EXPIRES,
        max_successful_charges,
        successful_charges,
        total_collected: current_period_collected,
        current_period_start,
        current_period_collected,
        last_charged_at,
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
// max_per_period enforcement
// ============================================================

#[test]
fn period_two_charges_summing_to_cap_both_succeed_third_rejected() {
    let f = setup();
    let mut input = base_input(&f, 1);
    input.amount_rule = AmountRule::Variable(100);
    input.max_per_period = 150;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // First charge: 100 (fresh period, effective collected 0 -> 100).
    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        100,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(
        client(&f).get_mandate(&mandate_id).current_period_collected,
        100
    );
    assert_contract_holds_nothing(&f);

    // Second charge: 50, still same period -> exactly the cap (150).
    f.env.ledger().set_timestamp(START + MIN_INTERVAL);
    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        50,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(
        client(&f).get_mandate(&mandate_id).current_period_collected,
        150
    );
    assert_contract_holds_nothing(&f);

    // Third charge: any positive amount now exceeds the cap.
    f.env.ledger().set_timestamp(START + 2 * MIN_INTERVAL);
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 3),
        1,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::AmountExceedsPeriodLimit);
}

#[test]
fn period_single_charge_exceeding_cap_rejected() {
    // A single charge whose per-charge cap is legal (<= max_per_charge) but
    // whose amount alone exceeds max_per_period. The public create_mandate
    // API can never produce this combination (it requires max_per_period >=
    // the per-charge cap), so this mandate is written directly into storage
    // to prove charge.rs's own step-12 check independently enforces the cap.
    let f = setup();
    let mandate_id = bytes32(&f.env, 250);
    store_mandate_custom(
        &f,
        &mandate_id,
        AmountRule::Variable(1_000),
        500,
        0,
        0,
        START,
        0,
        None,
    );
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 1),
        600,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::AmountExceedsPeriodLimit);
}

// ============================================================
// Rollover
// ============================================================

#[test]
fn period_rollover_resets_allowance_and_sets_boundary_not_now() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 2));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // First charge saturates period 0 exactly (max_per_period == FIXED_AMOUNT).
    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(
        client(&f).get_mandate(&mandate_id).current_period_start,
        START
    );
    assert_contract_holds_nothing(&f);

    // Advance to some point strictly inside period 1 (not the exact
    // boundary — that's covered by the dedicated boundary test below).
    let now = START + PERIOD_SECONDS + 5;
    f.env.ledger().set_timestamp(now);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(receipt.timestamp, now);

    let mandate = client(&f).get_mandate(&mandate_id);
    // Reset to just the new charge, not accumulated with period 0's amount.
    assert_eq!(mandate.current_period_collected, FIXED_AMOUNT);
    // The boundary the contract computes (start_at + 1*period_seconds), NOT
    // `now` — this is the whole point of the "boundary not now" rule.
    assert_eq!(mandate.current_period_start, START + PERIOD_SECONDS);
    assert_ne!(mandate.current_period_start, now);
    assert_contract_holds_nothing(&f);
}

// ============================================================
// Boundary — explicitly required (>=, not >)
// ============================================================

#[test]
fn period_boundary_second_before_still_old_period_exact_boundary_is_new_period() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 3));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // Charge 1 saturates period 0 at t = START.
    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // One second before the boundary: still period 0 -> the cap is already
    // saturated, so any further positive charge is rejected.
    let boundary = START + PERIOD_SECONDS;
    f.env.ledger().set_timestamp(boundary - 1);
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

    // Exactly at the boundary: treated as the new period (>=, not >) -> a
    // fresh allowance, so the same amount now succeeds.
    f.env.ledger().set_timestamp(boundary);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 3),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(receipt.timestamp, boundary);
    let mandate = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate.current_period_start, boundary);
    assert_eq!(mandate.current_period_collected, FIXED_AMOUNT);
    assert_contract_holds_nothing(&f);
}

// ============================================================
// Skipped periods
// ============================================================

#[test]
fn period_skipped_periods_land_in_correct_far_forward_boundary() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 4));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // Charge 1 in period 0.
    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // Skip 5 whole periods plus some slack — land inside period 5 without
    // ever charging in periods 1-4.
    let now = START + 5 * PERIOD_SECONDS + 500;
    f.env.ledger().set_timestamp(now);

    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(receipt.timestamp, now);

    let mandate = client(&f).get_mandate(&mandate_id);
    // Fully reset, not a double-accumulation from a naive "advance one
    // period at a time" implementation.
    assert_eq!(mandate.current_period_collected, FIXED_AMOUNT);
    // The correct far-forward boundary (period 5's start), not
    // start_at + 1*period_seconds (period 1's start) and not `now`.
    let expected_boundary = START + 5 * PERIOD_SECONDS;
    assert_eq!(mandate.current_period_start, expected_boundary);
    assert_ne!(mandate.current_period_start, START + PERIOD_SECONDS);
    assert_contract_holds_nothing(&f);
}

// ============================================================
// Completion
// ============================================================

#[test]
fn completion_reaches_max_charges_transitions_and_rejects_next_charge() {
    let f = setup();
    let mut input = base_input(&f, 5);
    // Give ample period headroom so max_per_period doesn't interfere with
    // isolating the completion logic.
    input.max_per_period = FIXED_AMOUNT * 10;
    input.max_successful_charges = 2;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    // get_mandate is itself a contract call, so any events()/auths()
    // inspection of charge 1 would need to happen before this — not needed
    // here, only the status check is.
    assert_eq!(
        client(&f).get_mandate(&mandate_id).status,
        MandateStatus::Active
    );

    f.env.ledger().set_timestamp(START + MIN_INTERVAL);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );

    // Inspect events() *immediately* after the charge, before any other
    // contract call (including get_mandate) — env.events().all() only
    // reflects the last invocation.
    let expected_completed = events::MandateCompleted {
        mandate_id: mandate_id.clone(),
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        successful_charges: 2,
        timestamp: START + MIN_INTERVAL,
    };
    let expected_charge_succeeded = events::ChargeSucceeded {
        mandate_id: mandate_id.clone(),
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        payment_id: receipt.payment_id.clone(),
        charge_id: bytes32(&f.env, 2),
        asset: f.token_id.clone(),
        amount: FIXED_AMOUNT,
        invoice_hash: bytes32(&f.env, 0xBB),
        period_index: 0,
        successful_charge_number: 2,
        timestamp: START + MIN_INTERVAL,
    };
    let recorded = f.env.events().all();
    assert_eq!(
        recorded,
        soroban_sdk::vec![
            &f.env,
            (
                f.contract_id.clone(),
                expected_charge_succeeded.topics(&f.env),
                expected_charge_succeeded.data(&f.env),
            ),
            (
                f.contract_id.clone(),
                expected_completed.topics(&f.env),
                expected_completed.data(&f.env),
            ),
        ]
    );

    // Now safe to make further contract calls.
    let mandate = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate.status, MandateStatus::Completed);
    assert_eq!(mandate.successful_charges, 2);
    assert_contract_holds_nothing(&f);

    // Next charge attempt fails: MandateCompleted, not e.g. ChargeCountExceeded.
    f.env.ledger().set_timestamp(START + 2 * MIN_INTERVAL);
    let err = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &bytes32(&f.env, 3),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .unwrap_err();
    assert_eq!(err, Error::MandateCompleted);
}

/// Defense-in-depth: step 10's `ChargeCountExceeded` check remains real even
/// though, through the public API, hitting the cap now completes the
/// mandate atomically (see the test above) and step 2 rejects the next
/// charge with `MandateCompleted` first. This constructs — via a direct
/// storage write, since `create_mandate` can never itself produce this
/// combination — a mandate whose `successful_charges` already equals
/// `max_successful_charges` while `status` is still `Active`, proving step
/// 10 independently rejects it rather than relying on step 2 alone.
#[test]
fn charge_count_exceeded_still_enforced_via_bypassed_active_state() {
    let f = setup();
    let mandate_id = bytes32(&f.env, 251);
    store_mandate_custom(
        &f,
        &mandate_id,
        AmountRule::Fixed(FIXED_AMOUNT),
        FIXED_AMOUNT * 10,
        1,
        1,
        START,
        0,
        None,
    );
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
    assert_eq!(err, Error::ChargeCountExceeded);
}

#[test]
fn completion_unlimited_max_charges_zero_never_completes() {
    let f = setup();
    let mut input = base_input(&f, 6);
    input.max_per_period = FIXED_AMOUNT * 10;
    input.max_successful_charges = 0; // unlimited
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    for i in 1..=5u8 {
        f.env
            .ledger()
            .set_timestamp(START + u64::from(i - 1) * MIN_INTERVAL);
        charge_success(
            &f,
            &mandate_id,
            &bytes32(&f.env, i),
            FIXED_AMOUNT,
            &bytes32(&f.env, 0xBB),
        );
        assert_contract_holds_nothing(&f);
    }

    let mandate = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate.successful_charges, 5);
    assert_eq!(mandate.status, MandateStatus::Active);
    assert_contract_holds_nothing(&f);
}

// ============================================================
// Interaction: min_interval_seconds vs period rollover
// ============================================================

#[test]
fn min_interval_still_enforced_across_a_period_rollover() {
    let f = setup();
    // period_seconds shorter than min_interval_seconds, so a rollover can
    // happen well before the interval is satisfied.
    let short_period = 100u64;
    let long_interval = 150u64;
    let mut input = base_input(&f, 7);
    input.period_seconds = short_period;
    input.min_interval_seconds = long_interval;
    input.max_per_period = FIXED_AMOUNT; // one charge saturates a period
    input.expires_at = START + 10_000;
    let mandate_id = create_success(&f, &input);
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_contract_holds_nothing(&f);

    // t = START + 120: past the period boundary (period rolled to index 1),
    // but only 120s since the last charge - short of the 150s min interval.
    // The interval check (step 9) must still fire even though a rollover
    // would otherwise grant a fresh allowance.
    f.env.ledger().set_timestamp(START + 120);
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

    // t = START + 150: interval satisfied, still period index 1 -> succeeds
    // with the fresh (rolled-over) allowance.
    f.env.ledger().set_timestamp(START + long_interval);
    let receipt = charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 2),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    assert_eq!(receipt.timestamp, START + long_interval);
    let mandate = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate.current_period_collected, FIXED_AMOUNT);
    assert_eq!(mandate.current_period_start, START + short_period);
}

// ============================================================
// Rollback still holds through a would-be rollover
// ============================================================

#[test]
fn rollover_reverts_on_failed_transfer_leaves_period_state_unchanged() {
    let f = setup();
    let mandate_id = create_success(&f, &base_input(&f, 8));
    fund_and_approve(&f, AMPLE_BALANCE, AMPLE_ALLOWANCE);

    // Charge 1 saturates period 0.
    charge_success(
        &f,
        &mandate_id,
        &bytes32(&f.env, 1),
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    );
    let mandate_before = raw_mandate(&f, &mandate_id);
    assert_eq!(mandate_before.current_period_start, START);
    assert_eq!(mandate_before.current_period_collected, FIXED_AMOUNT);

    // Advance into period 1 - this charge, if it succeeded, would roll the
    // period over. Force the token transfer to fail instead.
    let now = START + PERIOD_SECONDS + 10;
    f.env.ledger().set_timestamp(now);
    token(&f).set_fail_transfers(&true);

    let charge_id = bytes32(&f.env, 2);
    expect_panic(|| {
        let _ = charge_as(
            &f,
            &f.merchant.clone(),
            &mandate_id,
            &charge_id,
            FIXED_AMOUNT,
            &bytes32(&f.env, 0xBB),
        );
    });

    // Storage must be byte-for-byte unchanged from before the failed
    // attempt - proving the rolled-over-but-failed period state was never
    // persisted (decision 5: rollover state is only persisted on a
    // successful charge).
    let mandate_after = raw_mandate(&f, &mandate_id);
    assert_eq!(mandate_after, mandate_before);

    // Retry with the token working again: the rollover now genuinely
    // applies.
    token(&f).set_fail_transfers(&false);
    let receipt = charge_as(
        &f,
        &f.merchant.clone(),
        &mandate_id,
        &charge_id,
        FIXED_AMOUNT,
        &bytes32(&f.env, 0xBB),
    )
    .expect("retry after the transfer starts working again should succeed");
    assert_eq!(receipt.timestamp, now);

    let mandate_final = client(&f).get_mandate(&mandate_id);
    assert_eq!(mandate_final.current_period_start, START + PERIOD_SECONDS);
    assert_eq!(mandate_final.current_period_collected, FIXED_AMOUNT);
    assert_eq!(token(&f).balance(&f.contract_id), 0);
}
