//! Phase 2 tests: mandate lifecycle (`create_mandate`, `pause_mandate`,
//! `resume_mandate`, `revoke_mandate`, `get_mandate`). Authorization tests
//! use `env.mock_auths` / `MockAuth` — never `mock_all_auths` — so a
//! wrong-signer call genuinely fails because no authorization entry matches
//! the address the contract actually calls `require_auth()` on.

use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    Address, BytesN, Env, Event as _, IntoVal, Symbol,
};

use crate::{
    error::Error,
    events, storage,
    types::{AmountRule, Mandate, MandateInput, MandateStatus},
    MandateRegistry, MandateRegistryClient,
};

const DAY: u64 = 24 * 60 * 60;
const START: u64 = 1_000;
const PERIOD: u64 = 30 * DAY;
const EXPIRES: u64 = START + 365 * DAY;
const FIXED_AMOUNT: i128 = 150_000_000;

struct Fixture {
    env: Env,
    contract_id: Address,
    payer: Address,
    merchant: Address,
    asset: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.ledger().set_timestamp(START);
    let contract_id = env.register(MandateRegistry, ());
    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);
    let asset = Address::generate(&env);
    Fixture {
        env,
        contract_id,
        payer,
        merchant,
        asset,
    }
}

fn bytes32(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

fn base_input(f: &Fixture, nonce: u8) -> MandateInput {
    MandateInput {
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.asset.clone(),
        amount_rule: AmountRule::Fixed(FIXED_AMOUNT),
        max_per_period: FIXED_AMOUNT,
        period_seconds: PERIOD,
        min_interval_seconds: PERIOD,
        start_at: START,
        expires_at: EXPIRES,
        max_successful_charges: 12,
        metadata_hash: bytes32(&f.env, 0xAA),
        client_nonce: bytes32(&f.env, nonce),
    }
}

fn client(f: &Fixture) -> MandateRegistryClient<'_> {
    MandateRegistryClient::new(&f.env, &f.contract_id)
}

/// Call `create_mandate` with a mocked authorization for `signer` (not
/// necessarily the payer — used to prove wrong-signer rejection).
fn create_as(f: &Fixture, signer: &Address, input: &MandateInput) -> Result<BytesN<32>, Error> {
    let result = client(f)
        .mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "create_mandate",
                args: (input.clone(),).into_val(&f.env),
                sub_invokes: &[],
            },
        }])
        .try_create_mandate(input);
    result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
}

fn create_success(f: &Fixture, input: &MandateInput) -> BytesN<32> {
    create_as(f, &f.payer, input).expect("create_mandate should succeed with payer auth")
}

/// Call a single-`BytesN<32>`-argument lifecycle method (`pause_mandate`,
/// `resume_mandate`, `revoke_mandate`) with a mocked authorization for
/// `signer`.
fn call_as(
    f: &Fixture,
    fn_name: &'static str,
    signer: &Address,
    mandate_id: &BytesN<32>,
) -> Result<(), Error> {
    let invoke = MockAuthInvoke {
        contract: &f.contract_id,
        fn_name,
        args: (mandate_id.clone(),).into_val(&f.env),
        sub_invokes: &[],
    };
    let auths = [MockAuth {
        address: signer,
        invoke: &invoke,
    }];
    let mocked = client(f).mock_auths(&auths);
    let result = match fn_name {
        "pause_mandate" => mocked.try_pause_mandate(mandate_id),
        "resume_mandate" => mocked.try_resume_mandate(mandate_id),
        "revoke_mandate" => mocked.try_revoke_mandate(mandate_id),
        other => panic!("unexpected fn_name in test helper: {other}"),
    };
    result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
}

fn pause_as(f: &Fixture, signer: &Address, mandate_id: &BytesN<32>) -> Result<(), Error> {
    call_as(f, "pause_mandate", signer, mandate_id)
}
fn resume_as(f: &Fixture, signer: &Address, mandate_id: &BytesN<32>) -> Result<(), Error> {
    call_as(f, "resume_mandate", signer, mandate_id)
}
fn revoke_as(f: &Fixture, signer: &Address, mandate_id: &BytesN<32>) -> Result<(), Error> {
    call_as(f, "revoke_mandate", signer, mandate_id)
}

/// Directly write a mandate into storage bypassing `create_mandate`, so
/// tests can exercise the `Completed` transition-table branches even though
/// no Phase-2 code path can ever produce `Completed` itself (that only
/// happens once `charge` lands in Phase 3).
fn store_mandate_with_status(f: &Fixture, mandate_id: &BytesN<32>, status: MandateStatus) {
    let mandate = Mandate {
        id: mandate_id.clone(),
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.asset.clone(),
        status,
        amount_rule: AmountRule::Fixed(FIXED_AMOUNT),
        max_per_period: FIXED_AMOUNT,
        period_seconds: PERIOD,
        min_interval_seconds: PERIOD,
        start_at: START,
        expires_at: EXPIRES,
        max_successful_charges: 12,
        successful_charges: 12,
        total_collected: FIXED_AMOUNT * 12,
        current_period_start: START,
        current_period_collected: 0,
        last_charged_at: Some(START),
        created_at: START,
        metadata_hash: bytes32(&f.env, 0xAA),
    };
    f.env
        .as_contract(&f.contract_id, || storage::set_mandate(&f.env, &mandate));
}

// ============================================================
// create_mandate — success
// ============================================================

#[test]
fn create_mandate_success_activates_and_returns_id() {
    let f = setup();
    let input = base_input(&f, 1);
    let id = create_success(&f, &input);

    let stored = client(&f).get_mandate(&id);
    assert_eq!(stored.id, id);
    assert_eq!(stored.status, MandateStatus::Active);
    assert_eq!(stored.successful_charges, 0);
    assert_eq!(stored.total_collected, 0);
    assert_eq!(stored.current_period_start, START);
    assert_eq!(stored.current_period_collected, 0);
    assert_eq!(stored.last_charged_at, None);
    assert_eq!(stored.created_at, START);
}

#[test]
fn create_mandate_requires_payer_auth_and_records_it() {
    let f = setup();
    let input = base_input(&f, 2);
    create_success(&f, &input);

    assert_eq!(
        f.env.auths(),
        std::vec![(
            f.payer.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    f.contract_id.clone(),
                    Symbol::new(&f.env, "create_mandate"),
                    (input.clone(),).into_val(&f.env),
                )),
                sub_invocations: std::vec![],
            },
        )]
    );
}

#[test]
fn create_mandate_allows_zero_min_interval() {
    let f = setup();
    let mut input = base_input(&f, 3);
    input.min_interval_seconds = 0;
    let id = create_success(&f, &input);
    assert_eq!(client(&f).get_mandate(&id).min_interval_seconds, 0);
}

#[test]
fn create_mandate_allows_min_interval_exceeding_period() {
    let f = setup();
    let mut input = base_input(&f, 4);
    input.min_interval_seconds = PERIOD * 10;
    let id = create_success(&f, &input);
    assert_eq!(
        client(&f).get_mandate(&id).min_interval_seconds,
        PERIOD * 10
    );
}

#[test]
fn create_mandate_allows_zero_max_successful_charges_as_unlimited() {
    let f = setup();
    let mut input = base_input(&f, 5);
    input.max_successful_charges = 0;
    let id = create_success(&f, &input);
    assert_eq!(client(&f).get_mandate(&id).max_successful_charges, 0);
}

#[test]
fn two_mandates_same_parties_different_nonce_get_distinct_ids() {
    let f = setup();
    let input_a = base_input(&f, 10);
    let input_b = base_input(&f, 11);
    let id_a = create_success(&f, &input_a);
    let id_b = create_success(&f, &input_b);
    assert_ne!(id_a, id_b);
    // Both must be independently readable — creating the second did not
    // clobber the first.
    assert_eq!(client(&f).get_mandate(&id_a).status, MandateStatus::Active);
    assert_eq!(client(&f).get_mandate(&id_b).status, MandateStatus::Active);
}

#[test]
fn create_mandate_emits_event_with_full_fields() {
    let f = setup();
    let input = base_input(&f, 6);
    let id = create_success(&f, &input);

    let expected = events::MandateCreated {
        mandate_id: id,
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
        asset: f.asset.clone(),
        amount_rule: input.amount_rule.clone(),
        max_per_period: input.max_per_period,
        period_seconds: input.period_seconds,
        min_interval_seconds: input.min_interval_seconds,
        start_at: input.start_at,
        expires_at: input.expires_at,
        max_successful_charges: input.max_successful_charges,
        metadata_hash: input.metadata_hash.clone(),
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
// create_mandate — authorization
// ============================================================

#[test]
#[should_panic]
fn create_mandate_with_merchant_auth_instead_of_payer_fails() {
    let f = setup();
    let input = base_input(&f, 20);
    create_as(&f, &f.merchant.clone(), &input).unwrap();
}

// ============================================================
// create_mandate — rejections
// ============================================================

#[test]
fn create_mandate_duplicate_id_rejected() {
    let f = setup();
    let input = base_input(&f, 30);
    create_success(&f, &input);
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::DuplicateMandate);
}

#[test]
fn create_mandate_rejects_fixed_amount_zero() {
    let f = setup();
    let mut input = base_input(&f, 31);
    input.amount_rule = AmountRule::Fixed(0);
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn create_mandate_rejects_fixed_amount_negative() {
    let f = setup();
    let mut input = base_input(&f, 32);
    input.amount_rule = AmountRule::Fixed(-1);
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn create_mandate_rejects_variable_max_zero() {
    let f = setup();
    let mut input = base_input(&f, 33);
    input.amount_rule = AmountRule::Variable(0);
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidAmount);
}

#[test]
fn create_mandate_rejects_max_per_period_zero() {
    let f = setup();
    let mut input = base_input(&f, 34);
    input.max_per_period = 0;
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidMandateInput);
}

#[test]
fn create_mandate_rejects_max_per_period_below_charge_cap() {
    let f = setup();
    let mut input = base_input(&f, 35);
    input.amount_rule = AmountRule::Variable(100);
    input.max_per_period = 99;
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidMandateInput);
}

#[test]
fn create_mandate_allows_max_per_period_equal_to_charge_cap() {
    let f = setup();
    let mut input = base_input(&f, 36);
    input.amount_rule = AmountRule::Variable(100);
    input.max_per_period = 100;
    create_success(&f, &input);
}

#[test]
fn create_mandate_rejects_period_seconds_zero() {
    let f = setup();
    let mut input = base_input(&f, 37);
    input.period_seconds = 0;
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidMandateInput);
}

#[test]
fn create_mandate_rejects_expires_at_equal_start_at() {
    let f = setup();
    let mut input = base_input(&f, 38);
    input.expires_at = input.start_at;
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidMandateInput);
}

#[test]
fn create_mandate_rejects_expires_at_before_start_at() {
    let f = setup();
    let mut input = base_input(&f, 39);
    input.start_at = 5_000;
    input.expires_at = 4_000;
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidMandateInput);
}

#[test]
fn create_mandate_rejects_expires_at_in_the_past() {
    let f = setup();
    let mut input = base_input(&f, 40);
    input.start_at = 1;
    input.expires_at = START; // == now, so already dead on arrival
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidMandateInput);
}

#[test]
fn create_mandate_rejects_self_mandate() {
    let f = setup();
    let mut input = base_input(&f, 41);
    input.merchant = f.payer.clone();
    let err = create_as(&f, &f.payer.clone(), &input).unwrap_err();
    assert_eq!(err, Error::InvalidMandateInput);
}

// ============================================================
// pause_mandate
// ============================================================

#[test]
fn pause_mandate_success() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 50));
    pause_as(&f, &f.payer.clone(), &id).expect("pause should succeed");
    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Paused);
}

#[test]
fn pause_mandate_emits_event() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 51));
    pause_as(&f, &f.payer.clone(), &id).unwrap();

    let expected = events::MandatePaused {
        mandate_id: id,
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
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

#[test]
#[should_panic]
fn pause_mandate_wrong_signer_merchant_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 52));
    pause_as(&f, &f.merchant.clone(), &id).unwrap();
}

#[test]
#[should_panic]
fn pause_mandate_wrong_signer_third_party_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 53));
    let third_party = Address::generate(&f.env);
    pause_as(&f, &third_party, &id).unwrap();
}

#[test]
#[should_panic]
fn pause_mandate_wrong_signer_relayer_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 54));
    // The relayer has no on-chain identity distinct from "some other
    // address" — it holds no special spending or lifecycle authority
    // (CLAUDE.md §11). Modeled here as just another unrelated address.
    let relayer = Address::generate(&f.env);
    pause_as(&f, &relayer, &id).unwrap();
}

#[test]
fn pause_mandate_on_paused_rejected_not_active() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 55));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    let err = pause_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateNotActive);
}

#[test]
fn pause_mandate_on_revoked_rejected() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 56));
    revoke_as(&f, &f.payer.clone(), &id).unwrap();
    let err = pause_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateRevoked);
}

#[test]
fn pause_mandate_on_completed_rejected() {
    let f = setup();
    let id = bytes32(&f.env, 99);
    store_mandate_with_status(&f, &id, MandateStatus::Completed);
    let err = pause_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateCompleted);
}

#[test]
fn pause_mandate_on_expired_rejected() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 57));
    f.env.ledger().set_timestamp(EXPIRES);
    let err = pause_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateExpired);
}

#[test]
fn pause_mandate_nonexistent_rejected() {
    let f = setup();
    let id = bytes32(&f.env, 200);
    let err = pause_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateNotFound);
}

#[test]
fn pause_mandate_rejected_call_emits_no_event() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 58));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    // Second pause is rejected (MandateNotActive) — no event should fire.
    let _ = pause_as(&f, &f.payer.clone(), &id);
    assert!(f.env.events().all().events().is_empty());
}

// ============================================================
// resume_mandate
// ============================================================

#[test]
fn resume_mandate_success() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 60));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    resume_as(&f, &f.payer.clone(), &id).expect("resume should succeed");
    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Active);
}

#[test]
fn resume_mandate_emits_event() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 61));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    resume_as(&f, &f.payer.clone(), &id).unwrap();

    let expected = events::MandateResumed {
        mandate_id: id,
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
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

#[test]
#[should_panic]
fn resume_mandate_wrong_signer_merchant_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 62));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    resume_as(&f, &f.merchant.clone(), &id).unwrap();
}

#[test]
#[should_panic]
fn resume_mandate_wrong_signer_third_party_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 63));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    let third_party = Address::generate(&f.env);
    resume_as(&f, &third_party, &id).unwrap();
}

#[test]
#[should_panic]
fn resume_mandate_wrong_signer_relayer_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 64));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    let relayer = Address::generate(&f.env);
    resume_as(&f, &relayer, &id).unwrap();
}

#[test]
fn resume_mandate_on_active_rejected_invalid_state_transition() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 65));
    let err = resume_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::InvalidStateTransition);
}

#[test]
fn resume_mandate_on_revoked_rejected() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 66));
    revoke_as(&f, &f.payer.clone(), &id).unwrap();
    let err = resume_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateRevoked);
}

#[test]
fn resume_mandate_on_completed_rejected() {
    let f = setup();
    let id = bytes32(&f.env, 98);
    store_mandate_with_status(&f, &id, MandateStatus::Completed);
    let err = resume_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateCompleted);
}

#[test]
fn resume_mandate_on_expired_rejected() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 67));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    f.env.ledger().set_timestamp(EXPIRES);
    let err = resume_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateExpired);
}

#[test]
fn resume_mandate_nonexistent_rejected() {
    let f = setup();
    let id = bytes32(&f.env, 201);
    let err = resume_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateNotFound);
}

// ============================================================
// revoke_mandate
// ============================================================

#[test]
fn revoke_mandate_success_from_active() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 70));
    revoke_as(&f, &f.payer.clone(), &id).expect("revoke should succeed");
    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Revoked);
}

#[test]
fn revoke_mandate_success_from_paused() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 71));
    pause_as(&f, &f.payer.clone(), &id).unwrap();
    revoke_as(&f, &f.payer.clone(), &id).expect("revoke of a paused mandate should succeed");
    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Revoked);
}

#[test]
fn revoke_mandate_success_from_expired() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 72));
    f.env.ledger().set_timestamp(EXPIRES);
    // Revocation is the payer's unconditional right — it must succeed even
    // though the mandate now computes as Expired.
    revoke_as(&f, &f.payer.clone(), &id).expect("revoke of an expired mandate must succeed");
    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Revoked);
}

#[test]
fn revoke_mandate_emits_event() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 73));
    revoke_as(&f, &f.payer.clone(), &id).unwrap();

    let expected = events::MandateRevoked {
        mandate_id: id,
        payer: f.payer.clone(),
        merchant: f.merchant.clone(),
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

#[test]
#[should_panic]
fn revoke_mandate_wrong_signer_merchant_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 74));
    revoke_as(&f, &f.merchant.clone(), &id).unwrap();
}

#[test]
#[should_panic]
fn revoke_mandate_wrong_signer_third_party_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 75));
    let third_party = Address::generate(&f.env);
    revoke_as(&f, &third_party, &id).unwrap();
}

#[test]
#[should_panic]
fn revoke_mandate_wrong_signer_relayer_fails() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 76));
    let relayer = Address::generate(&f.env);
    revoke_as(&f, &relayer, &id).unwrap();
}

#[test]
fn revoke_mandate_on_revoked_rejected() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 77));
    revoke_as(&f, &f.payer.clone(), &id).unwrap();
    let err = revoke_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateRevoked);
}

#[test]
fn revoke_mandate_on_completed_rejected() {
    let f = setup();
    let id = bytes32(&f.env, 97);
    store_mandate_with_status(&f, &id, MandateStatus::Completed);
    let err = revoke_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateCompleted);
}

#[test]
fn revoke_mandate_nonexistent_rejected() {
    let f = setup();
    let id = bytes32(&f.env, 202);
    let err = revoke_as(&f, &f.payer.clone(), &id).unwrap_err();
    assert_eq!(err, Error::MandateNotFound);
}

// ============================================================
// get_mandate
// ============================================================

#[test]
fn get_mandate_nonexistent_rejected() {
    let f = setup();
    let id = bytes32(&f.env, 203);
    let err = client(&f).try_get_mandate(&id).unwrap_err().unwrap();
    assert_eq!(err, Error::MandateNotFound);
}

#[test]
fn get_mandate_active_before_expiry_reports_active() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 80));
    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Active);
}

#[test]
fn get_mandate_after_expiry_reports_expired_without_mutating_storage() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 81));
    f.env.ledger().set_timestamp(EXPIRES);

    let read = client(&f).get_mandate(&id);
    assert_eq!(read.status, MandateStatus::Expired);

    // The getter must not have written anything: storage still holds the
    // pre-expiry `Active` status.
    let raw = f
        .env
        .as_contract(&f.contract_id, || storage::get_mandate(&f.env, &id))
        .expect("mandate must still be present");
    assert_eq!(raw.status, MandateStatus::Active);
}

#[test]
fn get_mandate_revoked_stays_revoked_even_after_expiry() {
    let f = setup();
    let id = create_success(&f, &base_input(&f, 82));
    revoke_as(&f, &f.payer.clone(), &id).unwrap();
    f.env.ledger().set_timestamp(EXPIRES);

    // A terminal status must not be masked by the lazily-computed Expired.
    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Revoked);
}

#[test]
fn get_mandate_completed_stays_completed_even_after_expiry() {
    let f = setup();
    let id = bytes32(&f.env, 96);
    store_mandate_with_status(&f, &id, MandateStatus::Completed);
    f.env.ledger().set_timestamp(EXPIRES);

    assert_eq!(client(&f).get_mandate(&id).status, MandateStatus::Completed);
}
