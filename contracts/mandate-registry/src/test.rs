//! Phase 1 tests: error-code stability, id derivation, storage round-trips,
//! replay-guard isolation, and checked-arithmetic boundaries. No lifecycle
//! or charge tests here — those land with their respective phases.

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

use crate::{
    error::Error,
    id, math, storage,
    types::{AmountRule, Mandate, MandateStatus, PaymentReceipt},
    MandateRegistry,
};

fn register(env: &Env) -> Address {
    env.register(MandateRegistry, ())
}

fn bytes32(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

// --- ping (carried over from Phase 0) ---

#[test]
fn ping_returns_one() {
    let env = Env::default();
    let contract_id = register(&env);
    let client = crate::MandateRegistryClient::new(&env, &contract_id);
    assert_eq!(client.ping(), 1);
}

// --- Error discriminants are frozen ABI ---

#[test]
fn error_discriminants_are_frozen() {
    let cases: &[(Error, u32)] = &[
        (Error::MandateNotFound, 1),
        (Error::MandateNotActive, 2),
        (Error::MandatePaused, 3),
        (Error::MandateRevoked, 4),
        (Error::MandateCompleted, 5),
        (Error::MandateExpired, 6),
        (Error::ChargeBeforeStart, 7),
        (Error::ChargeTooSoon, 8),
        (Error::InvalidAmount, 9),
        (Error::AmountExceedsChargeLimit, 10),
        (Error::AmountExceedsPeriodLimit, 11),
        (Error::ChargeCountExceeded, 12),
        (Error::DuplicateCharge, 13),
        (Error::UnauthorizedMerchant, 14),
        (Error::InsufficientAllowance, 15),
        (Error::InsufficientBalance, 16),
        (Error::PaymentNotFound, 17),
        (Error::RefundExceedsPayment, 18),
        (Error::DuplicateRefund, 19),
        (Error::ArithmeticOverflow, 20),
    ];

    for (err, expected) in cases {
        assert_eq!(
            *err as u32, *expected,
            "frozen discriminant changed for {err:?} — CLAUDE.md §8 forbids renumbering"
        );
    }
}

// --- mandate_id determinism ---

#[test]
fn mandate_id_is_deterministic_and_input_sensitive() {
    let env = Env::default();
    let contract_id = register(&env);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);
    let asset = Address::generate(&env);
    let nonce = bytes32(&env, 7);

    let base = env.as_contract(&contract_id, || {
        id::derive_mandate_id(&env, &payer, &merchant, &asset, &nonce)
    });

    // Same inputs -> same id.
    let repeat = env.as_contract(&contract_id, || {
        id::derive_mandate_id(&env, &payer, &merchant, &asset, &nonce)
    });
    assert_eq!(base, repeat);

    // Changing the payer alone changes the id.
    let other_payer = Address::generate(&env);
    let diff_payer = env.as_contract(&contract_id, || {
        id::derive_mandate_id(&env, &other_payer, &merchant, &asset, &nonce)
    });
    assert_ne!(base, diff_payer);

    // Changing the merchant alone changes the id.
    let other_merchant = Address::generate(&env);
    let diff_merchant = env.as_contract(&contract_id, || {
        id::derive_mandate_id(&env, &payer, &other_merchant, &asset, &nonce)
    });
    assert_ne!(base, diff_merchant);

    // Changing the asset alone changes the id.
    let other_asset = Address::generate(&env);
    let diff_asset = env.as_contract(&contract_id, || {
        id::derive_mandate_id(&env, &payer, &merchant, &other_asset, &nonce)
    });
    assert_ne!(base, diff_asset);

    // Changing the client_nonce alone changes the id.
    let other_nonce = bytes32(&env, 8);
    let diff_nonce = env.as_contract(&contract_id, || {
        id::derive_mandate_id(&env, &payer, &merchant, &asset, &other_nonce)
    });
    assert_ne!(base, diff_nonce);
}

// --- payment_id determinism ---

#[test]
fn payment_id_is_deterministic_and_input_sensitive() {
    let env = Env::default();
    let contract_id = register(&env);

    let mandate_id = bytes32(&env, 1);
    let charge_id = bytes32(&env, 2);

    let base = env.as_contract(&contract_id, || {
        id::derive_payment_id(&env, &mandate_id, &charge_id)
    });
    let repeat = env.as_contract(&contract_id, || {
        id::derive_payment_id(&env, &mandate_id, &charge_id)
    });
    assert_eq!(base, repeat);

    let other_mandate_id = bytes32(&env, 3);
    let diff_mandate = env.as_contract(&contract_id, || {
        id::derive_payment_id(&env, &other_mandate_id, &charge_id)
    });
    assert_ne!(base, diff_mandate);

    let other_charge_id = bytes32(&env, 4);
    let diff_charge = env.as_contract(&contract_id, || {
        id::derive_payment_id(&env, &mandate_id, &other_charge_id)
    });
    assert_ne!(base, diff_charge);
}

// --- Storage round-trip ---

#[test]
fn storage_round_trips_mandate_and_payment_and_absent_reads_none() {
    let env = Env::default();
    let contract_id = register(&env);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);
    let asset = Address::generate(&env);
    let mandate_id = bytes32(&env, 10);
    let metadata_hash = bytes32(&env, 11);

    let mandate = Mandate {
        id: mandate_id.clone(),
        payer: payer.clone(),
        merchant: merchant.clone(),
        asset: asset.clone(),
        status: MandateStatus::Active,
        amount_rule: AmountRule::Fixed(150_000_000),
        max_per_period: 150_000_000,
        period_seconds: 2_592_000,
        min_interval_seconds: 2_592_000,
        start_at: 1_000,
        expires_at: 100_000_000,
        max_successful_charges: 12,
        successful_charges: 0,
        total_collected: 0,
        current_period_start: 1_000,
        current_period_collected: 0,
        last_charged_at: None,
        created_at: 1_000,
        metadata_hash,
    };

    env.as_contract(&contract_id, || {
        assert!(storage::get_mandate(&env, &mandate_id).is_none());
        storage::set_mandate(&env, &mandate);
        let loaded = storage::get_mandate(&env, &mandate_id).expect("just written");
        assert_eq!(loaded, mandate);

        // An unwritten key must read back as absent, never a default value.
        let other_id = bytes32(&env, 99);
        assert!(storage::get_mandate(&env, &other_id).is_none());
    });

    let payment_id = bytes32(&env, 20);
    let charge_id = bytes32(&env, 21);
    let invoice_hash = bytes32(&env, 22);

    let receipt = PaymentReceipt {
        payment_id: payment_id.clone(),
        mandate_id: mandate_id.clone(),
        charge_id,
        payer,
        merchant,
        asset,
        amount: 150_000_000,
        invoice_hash,
        timestamp: 1_000,
    };

    env.as_contract(&contract_id, || {
        assert!(storage::get_payment(&env, &payment_id).is_none());
        storage::set_payment(&env, &receipt);
        let loaded = storage::get_payment(&env, &payment_id).expect("just written");
        assert_eq!(loaded, receipt);
    });
}

// --- Replay guards ---

#[test]
fn replay_guards_mark_used_and_do_not_collide() {
    let env = Env::default();
    let contract_id = register(&env);

    let mandate_a = bytes32(&env, 1);
    let mandate_b = bytes32(&env, 2);
    let charge_a = bytes32(&env, 3);
    let charge_b = bytes32(&env, 4);

    env.as_contract(&contract_id, || {
        assert!(!storage::has_used_charge(&env, &mandate_a, &charge_a));
        storage::mark_charge_used(&env, &mandate_a, &charge_a);
        assert!(storage::has_used_charge(&env, &mandate_a, &charge_a));

        // Same charge id under a different mandate must not be considered used.
        assert!(!storage::has_used_charge(&env, &mandate_b, &charge_a));
        // A different charge id under the same mandate must not be considered used.
        assert!(!storage::has_used_charge(&env, &mandate_a, &charge_b));
    });

    let refund_a = bytes32(&env, 5);
    let refund_b = bytes32(&env, 6);

    env.as_contract(&contract_id, || {
        assert!(!storage::has_used_refund(&env, &refund_a));
        storage::mark_refund_used(&env, &refund_a);
        assert!(storage::has_used_refund(&env, &refund_a));
        assert!(!storage::has_used_refund(&env, &refund_b));
    });
}

#[test]
fn refunded_total_defaults_to_zero_and_round_trips() {
    let env = Env::default();
    let contract_id = register(&env);
    let payment_id = bytes32(&env, 30);

    env.as_contract(&contract_id, || {
        assert_eq!(storage::get_refunded_total(&env, &payment_id), 0);
        storage::set_refunded_total(&env, &payment_id, 42);
        assert_eq!(storage::get_refunded_total(&env, &payment_id), 42);
    });
}

// --- Checked arithmetic ---

#[test]
fn checked_i128_add_sub_mul_boundaries() {
    assert_eq!(math::checked_add_i128(1, 2), Ok(3));
    assert_eq!(
        math::checked_add_i128(i128::MAX, 1),
        Err(Error::ArithmeticOverflow)
    );
    assert_eq!(math::checked_add_i128(i128::MAX, 0), Ok(i128::MAX));

    assert_eq!(math::checked_sub_i128(5, 3), Ok(2));
    assert_eq!(
        math::checked_sub_i128(i128::MIN, 1),
        Err(Error::ArithmeticOverflow)
    );
    assert_eq!(math::checked_sub_i128(i128::MIN, 0), Ok(i128::MIN));

    assert_eq!(math::checked_mul_i128(3, 4), Ok(12));
    assert_eq!(
        math::checked_mul_i128(i128::MAX, 2),
        Err(Error::ArithmeticOverflow)
    );
    assert_eq!(math::checked_mul_i128(i128::MAX, 1), Ok(i128::MAX));
}

#[test]
fn checked_u64_add_sub_boundaries() {
    assert_eq!(math::checked_add_u64(1, 2), Ok(3));
    assert_eq!(
        math::checked_add_u64(u64::MAX, 1),
        Err(Error::ArithmeticOverflow)
    );
    assert_eq!(math::checked_add_u64(u64::MAX, 0), Ok(u64::MAX));

    assert_eq!(math::checked_sub_u64(5, 3), Ok(2));
    assert_eq!(math::checked_sub_u64(0, 1), Err(Error::ArithmeticOverflow));
    assert_eq!(math::checked_sub_u64(0, 0), Ok(0));
}
