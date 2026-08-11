//! Phase 6 property/invariant harness (PLAN.md §20.2, CLAUDE.md §7 & §14).
//!
//! Random action sequences (`create_mandate` (duplicate-attempt only, see
//! below) / `charge` / `pause` / `resume` / `revoke` / `refund` /
//! `advance_time`) driven by a hand-rolled, seeded PRNG (xorshift64, no
//! external fuzzing dependency per the lead decision). Every sequence
//! maintains a **shadow model** — a plain Rust re-implementation of the
//! exact CLAUDE.md §6 validation order for `charge`/`refund` and the
//! lifecycle state-transition tables for `pause`/`resume`/`revoke` — and,
//! after every single operation (accepted or rejected), asserts:
//!
//! 1. The real contract's outcome (success, or the *exact* typed `Error`)
//!    matches the shadow's prediction.
//! 2. Every PLAN.md §18 invariant checked in `assert_invariants` below still
//!    holds against the real, on-chain `Mandate`/receipts/token balances.
//!
//! On any mismatch, the assertion message embeds the seed, sequence index,
//! step index, and predicted-vs-actual outcome, so a failure is directly
//! replayable by re-running `run_sequence(that_seed, that_op_count)`.
//!
//! # Scope decision: one mandate per sequence
//!
//! Each sequence creates exactly one mandate. A `create_mandate` op does
//! appear in the random walk, but it always **replays the exact same
//! input** used at sequence setup (same `client_nonce`), so it is
//! deterministically predicted to fail with `DuplicateMandate` — this
//! specifically proves a replayed `create_mandate` neither corrupts nor
//! duplicates the existing mandate. Multi-mandate sequences (a fresh nonce
//! producing a second, independent mandate) were considered and rejected:
//! they would multiply the shadow model's state space for comparatively
//! little additional coverage, since `charge`/`refund`/lifecycle logic is
//! entirely mandate-scoped in the contract (no cross-mandate state) and is
//! already exercised per-mandate by every other op.
//!
//! # Wrong-signer handling
//!
//! A `require_auth()` mismatch is a genuine host/test-harness panic in this
//! SDK version (matching the existing `#[should_panic]` convention in
//! `test_lifecycle.rs`/`test_charge.rs`/`test_refund.rs`), not a typed
//! `Result::Err`. Every op call below is wrapped in `catch_unwind` (with the
//! panic hook silenced, restored immediately after — same pattern
//! `tasks/lessons.md` documents for post-panic storage inspection) so a
//! wrong-signer attempt doesn't abort the whole sequence; it is classified
//! as `Predicted::RejectedUntyped`, the same bucket used for a typed-error
//! decode that isn't a `contracterror` (there should be none of those in
//! practice, but the classifier doesn't need to assume that to stay safe).

use std::panic::{self, AssertUnwindSafe};

use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _, MockAuth, MockAuthInvoke},
    Address, BytesN, ConversionError, Env, IntoVal, InvokeError,
};

use mock_token::{MockToken, MockTokenClient};

use crate::{
    error::Error,
    id,
    types::{AmountRule, MandateInput, MandateStatus},
    MandateRegistry, MandateRegistryClient,
};

// --- Seeded PRNG (xorshift64, deterministic, reproducible) ---

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(if seed == 0 { 0x9E3779B97F4A7C15 } else { seed })
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Inclusive range `[lo, hi]`.
    fn range_u64(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next_u64() % (hi - lo + 1))
    }

    /// Inclusive range `[lo, hi]`. Callers keep spans small (well under
    /// `u64::MAX`) so the `u64` modulus below never truncates meaningfully.
    fn range_i128(&mut self, lo: i128, hi: i128) -> i128 {
        if hi <= lo {
            return lo;
        }
        let span = (hi - lo) as u64;
        lo + (self.next_u64() % (span + 1)) as i128
    }

    fn bool_with_prob_pct(&mut self, pct: u64) -> bool {
        self.range_u64(0, 99) < pct
    }

    fn pick(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

fn bytes32_seq(env: &Env, n: u32) -> BytesN<32> {
    let mut buf = [0u8; 32];
    buf[0..4].copy_from_slice(&n.to_le_bytes());
    BytesN::from_array(env, &buf)
}

// --- Outcome classification ---

#[derive(Debug, Clone, PartialEq)]
enum Predicted {
    Success,
    RejectedTyped(Error),
    /// A rejection that isn't a typed contract `Error` — in practice always
    /// a `require_auth()` mismatch (see module doc).
    RejectedUntyped,
}

fn classify<T>(raw: Result<Result<T, ConversionError>, Result<Error, InvokeError>>) -> Predicted {
    match raw {
        Ok(Ok(_)) => Predicted::Success,
        Ok(Err(e)) => panic!("conversion error decoding a successful call: {e:?}"),
        Err(Ok(err)) => Predicted::RejectedTyped(err),
        Err(Err(_invoke_err)) => Predicted::RejectedUntyped,
    }
}

/// Run `f` with the panic hook silenced and any panic caught, so a
/// wrong-signer `require_auth()` failure (a genuine Rust panic in this SDK,
/// not a typed `Result::Err` — see module doc) doesn't abort the whole
/// sequence.
fn guarded<F, T>(f: F) -> Predicted
where
    F: FnOnce() -> Result<Result<T, ConversionError>, Result<Error, InvokeError>>,
{
    let prev_hook = panic::take_hook();
    panic::set_hook(std::boxed::Box::new(|_| {}));
    let result = panic::catch_unwind(AssertUnwindSafe(f));
    panic::set_hook(prev_hook);
    match result {
        Ok(raw) => classify(raw),
        Err(_) => Predicted::RejectedUntyped,
    }
}

// --- Shadow model ---

#[derive(Clone, Debug)]
struct ShadowReceipt {
    payment_id: BytesN<32>,
    amount: i128,
    timestamp: u64,
}

#[derive(Clone, Debug)]
struct Shadow {
    amount_rule: AmountRule,
    max_per_period: i128,
    period_seconds: u64,
    min_interval_seconds: u64,
    start_at: u64,
    expires_at: u64,
    max_successful_charges: u32,

    status: MandateStatus,
    successful_charges: u32,
    total_collected: i128,
    current_period_start: u64,
    current_period_collected: i128,
    last_charged_at: Option<u64>,

    receipts: std::vec::Vec<ShadowReceipt>,
    used_charge_ids: std::vec::Vec<BytesN<32>>,
    used_refund_ids: std::vec::Vec<BytesN<32>>,
    /// `(payment_id, cumulative refunded)`.
    refunded_total: std::vec::Vec<(BytesN<32>, i128)>,

    /// Set the moment a `revoke` succeeds, to the receipt count observed at
    /// that instant. `assert_invariants` checks this count never grows
    /// afterward.
    revoked_receipt_count_snapshot: Option<usize>,
}

impl Shadow {
    fn refunded_so_far(&self, payment_id: &BytesN<32>) -> i128 {
        self.refunded_total
            .iter()
            .find(|(p, _)| p == payment_id)
            .map(|(_, t)| *t)
            .unwrap_or(0)
    }

    fn record_refund(&mut self, payment_id: &BytesN<32>, amount: i128) {
        if let Some(entry) = self
            .refunded_total
            .iter_mut()
            .find(|(p, _)| p == payment_id)
        {
            entry.1 += amount;
        } else {
            self.refunded_total.push((payment_id.clone(), amount));
        }
    }
}

/// Mirrors `lifecycle::effective_status` exactly: only a stored
/// `Active`/`Paused` mandate can lazily become `Expired`.
fn effective_status(s: &Shadow, now: u64) -> MandateStatus {
    match s.status {
        MandateStatus::Active | MandateStatus::Paused if now >= s.expires_at => {
            MandateStatus::Expired
        }
        ref other => other.clone(),
    }
}

/// Mirrors `charge.rs`'s exact CLAUDE.md §6 validation order (steps 2-14;
/// step 1 "mandate exists" is assumed true — this harness never charges a
/// nonexistent mandate).
#[allow(clippy::too_many_arguments)]
fn predict_charge(
    s: &Shadow,
    now: u64,
    signer_is_merchant: bool,
    charge_id: &BytesN<32>,
    amount: i128,
    allowance: i128,
    balance: i128,
) -> Predicted {
    // 2. status
    match effective_status(s, now) {
        MandateStatus::Active => {}
        MandateStatus::Paused => return Predicted::RejectedTyped(Error::MandatePaused),
        MandateStatus::Revoked => return Predicted::RejectedTyped(Error::MandateRevoked),
        MandateStatus::Completed => return Predicted::RejectedTyped(Error::MandateCompleted),
        MandateStatus::Expired => return Predicted::RejectedTyped(Error::MandateExpired),
    }
    // 3
    if now < s.start_at {
        return Predicted::RejectedTyped(Error::ChargeBeforeStart);
    }
    // 4
    if now >= s.expires_at {
        return Predicted::RejectedTyped(Error::MandateExpired);
    }
    // 5. auth — after status/time, before everything below (charge.rs order).
    if !signer_is_merchant {
        return Predicted::RejectedUntyped;
    }
    // 6
    if s.used_charge_ids.iter().any(|c| c == charge_id) {
        return Predicted::RejectedTyped(Error::DuplicateCharge);
    }
    // 7
    if amount <= 0 {
        return Predicted::RejectedTyped(Error::InvalidAmount);
    }
    // 8
    match s.amount_rule {
        AmountRule::Fixed(fixed) => {
            if amount != fixed {
                return Predicted::RejectedTyped(Error::AmountExceedsChargeLimit);
            }
        }
        AmountRule::Variable(max_per_charge) => {
            if amount > max_per_charge {
                return Predicted::RejectedTyped(Error::AmountExceedsChargeLimit);
            }
        }
    }
    // 9
    if let Some(last) = s.last_charged_at {
        if now < last + s.min_interval_seconds {
            return Predicted::RejectedTyped(Error::ChargeTooSoon);
        }
    }
    // 10
    if s.max_successful_charges != 0 && s.successful_charges >= s.max_successful_charges {
        return Predicted::RejectedTyped(Error::ChargeCountExceeded);
    }
    // 11-12
    let (_, new_period_collected) = period_state(s, now, amount);
    if new_period_collected > s.max_per_period {
        return Predicted::RejectedTyped(Error::AmountExceedsPeriodLimit);
    }
    // 13
    if allowance < amount {
        return Predicted::RejectedTyped(Error::InsufficientAllowance);
    }
    // 14
    if balance < amount {
        return Predicted::RejectedTyped(Error::InsufficientBalance);
    }
    Predicted::Success
}

/// Mirrors `charge.rs`'s billing-period boundary/rollover computation
/// exactly. Returns `(computed_period_start, new_period_collected)` — the
/// values the real contract would write on a successful charge of `amount`
/// at `now`.
fn period_state(s: &Shadow, now: u64, amount: i128) -> (u64, i128) {
    let elapsed = now - s.start_at;
    let period_index = elapsed / s.period_seconds;
    let computed_period_start = s.start_at + period_index * s.period_seconds;
    let effective_collected = if computed_period_start != s.current_period_start {
        0
    } else {
        s.current_period_collected
    };
    (computed_period_start, effective_collected + amount)
}

/// Mirrors `lifecycle::pause_mandate`'s order: auth *before* status.
fn predict_pause(s: &Shadow, now: u64, signer_is_payer: bool) -> Predicted {
    if !signer_is_payer {
        return Predicted::RejectedUntyped;
    }
    match effective_status(s, now) {
        MandateStatus::Active => Predicted::Success,
        MandateStatus::Paused => Predicted::RejectedTyped(Error::MandateNotActive),
        MandateStatus::Revoked => Predicted::RejectedTyped(Error::MandateRevoked),
        MandateStatus::Completed => Predicted::RejectedTyped(Error::MandateCompleted),
        MandateStatus::Expired => Predicted::RejectedTyped(Error::MandateExpired),
    }
}

/// Mirrors `lifecycle::resume_mandate`'s order: auth before status.
fn predict_resume(s: &Shadow, now: u64, signer_is_payer: bool) -> Predicted {
    if !signer_is_payer {
        return Predicted::RejectedUntyped;
    }
    match effective_status(s, now) {
        MandateStatus::Paused => Predicted::Success,
        MandateStatus::Active => Predicted::RejectedTyped(Error::InvalidStateTransition),
        MandateStatus::Revoked => Predicted::RejectedTyped(Error::MandateRevoked),
        MandateStatus::Completed => Predicted::RejectedTyped(Error::MandateCompleted),
        MandateStatus::Expired => Predicted::RejectedTyped(Error::MandateExpired),
    }
}

/// Mirrors `lifecycle::revoke_mandate`'s order: auth before status.
fn predict_revoke(s: &Shadow, now: u64, signer_is_payer: bool) -> Predicted {
    if !signer_is_payer {
        return Predicted::RejectedUntyped;
    }
    match effective_status(s, now) {
        MandateStatus::Active | MandateStatus::Paused | MandateStatus::Expired => {
            Predicted::Success
        }
        MandateStatus::Revoked => Predicted::RejectedTyped(Error::MandateRevoked),
        MandateStatus::Completed => Predicted::RejectedTyped(Error::MandateCompleted),
    }
}

/// Mirrors `refund.rs`'s order: payment-exists, THEN auth, THEN
/// refund_id/amount/exceeds/balance. `payment` is `None` for a garbage
/// `payment_id`.
fn predict_refund(
    signer_is_merchant: bool,
    payment: Option<(i128, i128)>, // (payment.amount, refunded_so_far)
    amount: i128,
    refund_id_used: bool,
    merchant_balance: i128,
) -> Predicted {
    let (payment_amount, refunded_so_far) = match payment {
        Some(p) => p,
        None => return Predicted::RejectedTyped(Error::PaymentNotFound),
    };
    if !signer_is_merchant {
        return Predicted::RejectedUntyped;
    }
    if refund_id_used {
        return Predicted::RejectedTyped(Error::DuplicateRefund);
    }
    if amount <= 0 {
        return Predicted::RejectedTyped(Error::InvalidAmount);
    }
    if refunded_so_far + amount > payment_amount {
        return Predicted::RejectedTyped(Error::RefundExceedsPayment);
    }
    if merchant_balance < amount {
        return Predicted::RejectedTyped(Error::InsufficientBalance);
    }
    Predicted::Success
}

// --- Invariant assertions (PLAN.md §18, run after every op) ---

#[allow(clippy::too_many_arguments)]
fn assert_invariants(
    client: &MandateRegistryClient,
    token: &MockTokenClient,
    contract_id: &Address,
    mandate_id: &BytesN<32>,
    shadow: &Shadow,
    now: u64,
    ctx: &str,
) {
    let real = client.get_mandate(mandate_id);

    assert_eq!(real.status, effective_status(shadow, now), "status: {ctx}");
    assert_eq!(
        real.successful_charges, shadow.successful_charges,
        "successful_charges: {ctx}"
    );
    assert_eq!(
        real.total_collected, shadow.total_collected,
        "total_collected: {ctx}"
    );
    assert_eq!(
        real.current_period_start, shadow.current_period_start,
        "current_period_start: {ctx}"
    );
    assert_eq!(
        real.current_period_collected, shadow.current_period_collected,
        "current_period_collected: {ctx}"
    );
    assert_eq!(
        real.last_charged_at, shadow.last_charged_at,
        "last_charged_at: {ctx}"
    );

    // Key oracle: successful_charges == count(stored receipts).
    assert_eq!(
        real.successful_charges as usize,
        shadow.receipts.len(),
        "receipt count: {ctx}"
    );

    // total_collected == sum(receipt amounts).
    let sum: i128 = shadow.receipts.iter().map(|r| r.amount).sum();
    assert_eq!(sum, real.total_collected, "sum(receipts): {ctx}");

    // Key oracle: sum(receipts in the current period) <= max_per_period, and
    // equals the stored current_period_collected exactly.
    let period_sum: i128 = shadow
        .receipts
        .iter()
        .filter(|r| r.timestamp >= real.current_period_start)
        .map(|r| r.amount)
        .sum();
    assert!(
        period_sum <= shadow.max_per_period,
        "period cap exceeded: {ctx}"
    );
    assert_eq!(
        period_sum, real.current_period_collected,
        "period sum drift: {ctx}"
    );

    // Key oracle: the contract must never hold payment funds.
    assert_eq!(
        token.balance(contract_id),
        0,
        "contract balance != 0: {ctx}"
    );

    // successful_charges <= max_successful_charges when capped.
    if shadow.max_successful_charges != 0 {
        assert!(
            real.successful_charges <= shadow.max_successful_charges,
            "charge count cap exceeded: {ctx}"
        );
    }

    // No charge before start_at or at/after expiry; min_interval respected.
    for r in &shadow.receipts {
        assert!(
            r.timestamp >= shadow.start_at,
            "charge before start_at: {ctx}"
        );
        assert!(
            r.timestamp < shadow.expires_at,
            "charge at/after expiry: {ctx}"
        );
    }
    for pair in shadow.receipts.windows(2) {
        assert!(
            pair[1].timestamp >= pair[0].timestamp + shadow.min_interval_seconds,
            "charges closer than min_interval_seconds: {ctx}"
        );
    }

    // refunded_total[payment] <= payment.amount for every payment; receipts
    // are immutable (amount never drifts from what was stored at charge time).
    for r in &shadow.receipts {
        let refunded = client.get_refunded_total(&r.payment_id);
        assert!(refunded <= r.amount, "refund exceeds payment: {ctx}");
        let stored = client.get_payment(&r.payment_id);
        assert_eq!(
            stored.amount, r.amount,
            "stored receipt amount drifted: {ctx}"
        );
    }

    // A revoked mandate never gains a new receipt afterward.
    if let Some(snapshot) = shadow.revoked_receipt_count_snapshot {
        assert_eq!(
            shadow.receipts.len(),
            snapshot,
            "revoked mandate gained a receipt: {ctx}"
        );
    }
}

// --- Sequence driver ---

const BASE_SEED: u64 = 0x00C0_FFEE_1234_5678;
const NUM_SEQUENCES: u64 = 250;
const OPS_PER_SEQUENCE: u32 = 20;
const DEEP_NUM_SEQUENCES: u64 = 3_000;
const DEEP_OPS_PER_SEQUENCE: u32 = 40;

#[test]
fn property_suite_default() {
    for i in 0..NUM_SEQUENCES {
        let seed = BASE_SEED ^ i.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1);
        run_sequence(seed, OPS_PER_SEQUENCE);
    }
}

/// Deep run for manual invocation: `cargo test --workspace -- --ignored
/// property_suite_deep` (per the lead decision, not part of the default
/// `cargo test --workspace` gate since it would push wall-clock time past
/// the "well under 2 minutes" budget).
#[test]
#[ignore]
fn property_suite_deep() {
    for i in 0..DEEP_NUM_SEQUENCES {
        let seed = (BASE_SEED ^ 0xD00D_D00D_D00D_D00D)
            ^ i.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(1);
        run_sequence(seed, DEEP_OPS_PER_SEQUENCE);
    }
}

fn pick_wrong(rng: &mut Rng, a: &Address, b: &Address) -> Address {
    if rng.bool_with_prob_pct(50) {
        a.clone()
    } else {
        b.clone()
    }
}

fn run_sequence(seed: u64, ops: u32) {
    let mut rng = Rng::new(seed);

    // The property suite intentionally spins up hundreds of short-lived
    // `Env`s per test run (one per sequence). Each `Env` drop would
    // otherwise write a `test_snapshots/...json` file (soroban-sdk's
    // "commit this and watch it for behavior changes" feature, on by
    // default and exactly what the rest of this crate's directed tests
    // rely on) — appropriate for a handful of deterministic scenarios, not
    // for hundreds of throwaway randomized ones. Disabled here only; the
    // adversarial matrix and every other test module keep the default.
    let mut env = Env::default();
    env.set_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let start = 1_000u64;
    env.ledger().set_timestamp(start);

    let contract_id = env.register(MandateRegistry, ());
    let token_id = env.register(MockToken, ());
    let client = MandateRegistryClient::new(&env, &contract_id);
    let token = MockTokenClient::new(&env, &token_id);

    let payer = Address::generate(&env);
    let merchant = Address::generate(&env);
    let attacker = Address::generate(&env);

    // --- Randomize mandate terms ---
    let per_charge_cap = rng.range_i128(1, 1_000_000);
    let amount_rule = if rng.bool_with_prob_pct(50) {
        AmountRule::Fixed(per_charge_cap)
    } else {
        AmountRule::Variable(per_charge_cap)
    };
    let period_multiplier = rng.range_i128(1, 5);
    let max_per_period = per_charge_cap * period_multiplier;
    let period_seconds = [60u64, 3_600, 86_400][rng.pick(3)];
    let min_interval_seconds = [0u64, 1, 60, 3_600][rng.pick(4)];
    let duration = rng.range_u64(10, 20) * period_seconds;
    let expires_at = start + duration;
    let max_successful_charges = [0u32, 1, 2, 3, 5][rng.pick(5)];
    let metadata_hash = bytes32_seq(&env, 0xAAAA_0000u32.wrapping_add((seed & 0xFFFF) as u32));
    let nonce = bytes32_seq(&env, 1);

    let input = MandateInput {
        payer: payer.clone(),
        merchant: merchant.clone(),
        asset: token_id.clone(),
        amount_rule: amount_rule.clone(),
        max_per_period,
        period_seconds,
        min_interval_seconds,
        start_at: start,
        expires_at,
        max_successful_charges,
        metadata_hash,
        client_nonce: nonce,
    };

    let create_invoke = MockAuthInvoke {
        contract: &contract_id,
        fn_name: "create_mandate",
        args: (input.clone(),).into_val(&env),
        sub_invokes: &[],
    };
    let create_result = client
        .mock_auths(&[MockAuth {
            address: &payer,
            invoke: &create_invoke,
        }])
        .try_create_mandate(&input);
    let mandate_id: BytesN<32> = create_result
        .map_err(|e| e.expect("host trapped instead of returning a typed Error"))
        .map(|inner| inner.expect("conversion error"))
        .unwrap_or_else(|e| {
            panic!("seed={seed}: create_mandate should succeed for a validly-constructed input, got {e:?}")
        });

    // --- Fund payer, approve the mandate contract as spender ---
    let payer_balance = max_per_period * 60 + per_charge_cap * 10 + 10_000;
    token.mint(&payer, &payer_balance);

    let allowance = if rng.bool_with_prob_pct(75) {
        payer_balance
    } else {
        per_charge_cap * 2
    };
    let approve_invoke = MockAuthInvoke {
        contract: &token_id,
        fn_name: "approve",
        args: (payer.clone(), contract_id.clone(), allowance, 0u32).into_val(&env),
        sub_invokes: &[],
    };
    token
        .mock_auths(&[MockAuth {
            address: &payer,
            invoke: &approve_invoke,
        }])
        .approve(&payer, &contract_id, &allowance, &0u32);

    let mut shadow = Shadow {
        amount_rule: amount_rule.clone(),
        max_per_period,
        period_seconds,
        min_interval_seconds,
        start_at: start,
        expires_at,
        max_successful_charges,
        status: MandateStatus::Active,
        successful_charges: 0,
        total_collected: 0,
        current_period_start: start,
        current_period_collected: 0,
        last_charged_at: None,
        receipts: std::vec::Vec::new(),
        used_charge_ids: std::vec::Vec::new(),
        used_refund_ids: std::vec::Vec::new(),
        refunded_total: std::vec::Vec::new(),
        revoked_receipt_count_snapshot: None,
    };

    assert_invariants(
        &client,
        &token,
        &contract_id,
        &mandate_id,
        &shadow,
        start,
        &std::format!("seed={seed} step=setup"),
    );

    let mut now = start;

    for step in 0..ops {
        let payer_before = token.balance(&payer);
        let merchant_before = token.balance(&merchant);

        let op_kind = rng.pick(7);
        match op_kind {
            0 => {
                // charge
                let signer = if rng.bool_with_prob_pct(15) {
                    pick_wrong(&mut rng, &payer, &attacker)
                } else {
                    merchant.clone()
                };
                let charge_id = if !shadow.used_charge_ids.is_empty() && rng.bool_with_prob_pct(20)
                {
                    shadow.used_charge_ids[rng.pick(shadow.used_charge_ids.len())].clone()
                } else {
                    bytes32_seq(&env, 0x1000_0000u32.wrapping_add(step))
                };
                let invoice_hash = bytes32_seq(&env, 0x2000_0000u32.wrapping_add(step));

                let (_, new_period_collected_at_zero) = period_state(&shadow, now, 0);
                let remaining_headroom = shadow.max_per_period - new_period_collected_at_zero;
                let per_charge_cap_now = match shadow.amount_rule {
                    AmountRule::Fixed(f) => f,
                    AmountRule::Variable(v) => v,
                };

                let mut candidates = std::vec![
                    0,
                    1,
                    per_charge_cap_now,
                    per_charge_cap_now + 1,
                    remaining_headroom,
                    remaining_headroom + 1
                ];
                if per_charge_cap_now > 1 {
                    candidates.push(per_charge_cap_now - 1);
                }
                candidates.push(rng.range_i128(1, per_charge_cap_now.saturating_mul(2).max(2)));
                let amount = candidates[rng.pick(candidates.len())];

                let allowance_now = token.allowance(&payer, &contract_id);
                let balance_now = token.balance(&payer);

                let predicted = predict_charge(
                    &shadow,
                    now,
                    signer == merchant,
                    &charge_id,
                    amount,
                    allowance_now,
                    balance_now,
                );

                let charge_invoke = MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "charge",
                    args: (
                        mandate_id.clone(),
                        charge_id.clone(),
                        amount,
                        invoice_hash.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[],
                };
                let auths = [MockAuth {
                    address: &signer,
                    invoke: &charge_invoke,
                }];
                let actual = guarded(|| {
                    client.mock_auths(&auths).try_charge(
                        &mandate_id,
                        &charge_id,
                        &amount,
                        &invoice_hash,
                    )
                });

                let ctx = std::format!(
                    "seed={seed} step={step} op=charge amount={amount} now={now} predicted={predicted:?} actual={actual:?}"
                );
                assert_eq!(actual, predicted, "{ctx}");

                if predicted == Predicted::Success {
                    let (computed_period_start, new_period_collected) =
                        period_state(&shadow, now, amount);
                    shadow.successful_charges += 1;
                    shadow.total_collected += amount;
                    shadow.current_period_start = computed_period_start;
                    shadow.current_period_collected = new_period_collected;
                    shadow.last_charged_at = Some(now);
                    shadow.used_charge_ids.push(charge_id.clone());
                    let payment_id = id::derive_payment_id(&env, &mandate_id, &charge_id);
                    shadow.receipts.push(ShadowReceipt {
                        payment_id,
                        amount,
                        timestamp: now,
                    });
                    if shadow.max_successful_charges != 0
                        && shadow.successful_charges == shadow.max_successful_charges
                    {
                        shadow.status = MandateStatus::Completed;
                    }
                }
            }
            1 => {
                // pause
                let signer = if rng.bool_with_prob_pct(15) {
                    pick_wrong(&mut rng, &merchant, &attacker)
                } else {
                    payer.clone()
                };
                let predicted = predict_pause(&shadow, now, signer == payer);
                let invoke = MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "pause_mandate",
                    args: (mandate_id.clone(),).into_val(&env),
                    sub_invokes: &[],
                };
                let actual = guarded(|| {
                    client
                        .mock_auths(&[MockAuth {
                            address: &signer,
                            invoke: &invoke,
                        }])
                        .try_pause_mandate(&mandate_id)
                });
                let ctx = std::format!(
                    "seed={seed} step={step} op=pause now={now} predicted={predicted:?} actual={actual:?}"
                );
                assert_eq!(actual, predicted, "{ctx}");
                if predicted == Predicted::Success {
                    shadow.status = MandateStatus::Paused;
                }
            }
            2 => {
                // resume
                let signer = if rng.bool_with_prob_pct(15) {
                    pick_wrong(&mut rng, &merchant, &attacker)
                } else {
                    payer.clone()
                };
                let predicted = predict_resume(&shadow, now, signer == payer);
                let invoke = MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "resume_mandate",
                    args: (mandate_id.clone(),).into_val(&env),
                    sub_invokes: &[],
                };
                let actual = guarded(|| {
                    client
                        .mock_auths(&[MockAuth {
                            address: &signer,
                            invoke: &invoke,
                        }])
                        .try_resume_mandate(&mandate_id)
                });
                let ctx = std::format!(
                    "seed={seed} step={step} op=resume now={now} predicted={predicted:?} actual={actual:?}"
                );
                assert_eq!(actual, predicted, "{ctx}");
                if predicted == Predicted::Success {
                    shadow.status = MandateStatus::Active;
                }
            }
            3 => {
                // revoke
                let signer = if rng.bool_with_prob_pct(15) {
                    pick_wrong(&mut rng, &merchant, &attacker)
                } else {
                    payer.clone()
                };
                let predicted = predict_revoke(&shadow, now, signer == payer);
                let invoke = MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "revoke_mandate",
                    args: (mandate_id.clone(),).into_val(&env),
                    sub_invokes: &[],
                };
                let actual = guarded(|| {
                    client
                        .mock_auths(&[MockAuth {
                            address: &signer,
                            invoke: &invoke,
                        }])
                        .try_revoke_mandate(&mandate_id)
                });
                let ctx = std::format!(
                    "seed={seed} step={step} op=revoke now={now} predicted={predicted:?} actual={actual:?}"
                );
                assert_eq!(actual, predicted, "{ctx}");
                if predicted == Predicted::Success {
                    shadow.status = MandateStatus::Revoked;
                    if shadow.revoked_receipt_count_snapshot.is_none() {
                        shadow.revoked_receipt_count_snapshot = Some(shadow.receipts.len());
                    }
                }
            }
            4 => {
                // refund
                let signer = if rng.bool_with_prob_pct(15) {
                    pick_wrong(&mut rng, &payer, &attacker)
                } else {
                    merchant.clone()
                };

                let (payment_id, shadow_payment) =
                    if !shadow.receipts.is_empty() && rng.bool_with_prob_pct(85) {
                        let r = &shadow.receipts[rng.pick(shadow.receipts.len())];
                        let refunded = shadow.refunded_so_far(&r.payment_id);
                        (r.payment_id.clone(), Some((r.amount, refunded)))
                    } else {
                        (bytes32_seq(&env, 0x3000_0000u32.wrapping_add(step)), None)
                    };

                let refund_id = if !shadow.used_refund_ids.is_empty() && rng.bool_with_prob_pct(20)
                {
                    shadow.used_refund_ids[rng.pick(shadow.used_refund_ids.len())].clone()
                } else {
                    bytes32_seq(&env, 0x4000_0000u32.wrapping_add(step))
                };
                let refund_id_used = shadow.used_refund_ids.iter().any(|x| x == &refund_id);

                let amount = match shadow_payment {
                    Some((paid, refunded)) => {
                        let remaining = paid - refunded;
                        let mut cands = std::vec![0, 1, remaining, remaining + 1];
                        if remaining > 1 {
                            cands.push(remaining - 1);
                        }
                        cands.push(rng.range_i128(1, paid.saturating_mul(2).max(2)));
                        cands[rng.pick(cands.len())]
                    }
                    None => rng.range_i128(1, 1_000),
                };

                let merchant_balance_now = token.balance(&merchant);
                let predicted = predict_refund(
                    signer == merchant,
                    shadow_payment,
                    amount,
                    refund_id_used,
                    merchant_balance_now,
                );

                let transfer_invoke = MockAuthInvoke {
                    contract: &token_id,
                    fn_name: "transfer",
                    args: (merchant.clone(), payer.clone(), amount).into_val(&env),
                    sub_invokes: &[],
                };
                let refund_invoke = MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "refund",
                    args: (
                        mandate_id.clone(),
                        payment_id.clone(),
                        amount,
                        refund_id.clone(),
                    )
                        .into_val(&env),
                    sub_invokes: &[transfer_invoke],
                };
                let actual = guarded(|| {
                    client
                        .mock_auths(&[MockAuth {
                            address: &signer,
                            invoke: &refund_invoke,
                        }])
                        .try_refund(&mandate_id, &payment_id, &amount, &refund_id)
                });

                let ctx = std::format!(
                    "seed={seed} step={step} op=refund amount={amount} predicted={predicted:?} actual={actual:?}"
                );
                assert_eq!(actual, predicted, "{ctx}");

                if predicted == Predicted::Success {
                    shadow.used_refund_ids.push(refund_id.clone());
                    shadow.record_refund(&payment_id, amount);
                }
            }
            5 => {
                // advance_time
                let choices = [
                    0u64,
                    1,
                    shadow.min_interval_seconds.max(1),
                    shadow.period_seconds,
                    shadow.period_seconds.saturating_sub(1),
                    10,
                ];
                let delta = choices[rng.pick(choices.len())];
                now = now.saturating_add(delta);
                env.ledger().set_timestamp(now);
            }
            _ => {
                // create_mandate replay — always the identical input, so
                // always deterministically DuplicateMandate (or an auth
                // rejection first, if signer is wrong — see module doc).
                let signer = if rng.bool_with_prob_pct(15) {
                    pick_wrong(&mut rng, &merchant, &attacker)
                } else {
                    payer.clone()
                };
                let dup_invoke = MockAuthInvoke {
                    contract: &contract_id,
                    fn_name: "create_mandate",
                    args: (input.clone(),).into_val(&env),
                    sub_invokes: &[],
                };
                let actual = guarded(|| {
                    client
                        .mock_auths(&[MockAuth {
                            address: &signer,
                            invoke: &dup_invoke,
                        }])
                        .try_create_mandate(&input)
                });
                let predicted = if signer != payer {
                    Predicted::RejectedUntyped
                } else {
                    Predicted::RejectedTyped(Error::DuplicateMandate)
                };
                let ctx = std::format!(
                    "seed={seed} step={step} op=create_dup predicted={predicted:?} actual={actual:?}"
                );
                assert_eq!(actual, predicted, "{ctx}");
                // Never mutates shadow: always rejected.
            }
        }

        let payer_after = token.balance(&payer);
        let merchant_after = token.balance(&merchant);
        assert_eq!(
            (payer_after - payer_before) + (merchant_after - merchant_before),
            0,
            "token conservation violated: seed={seed} step={step}"
        );

        assert_invariants(
            &client,
            &token,
            &contract_id,
            &mandate_id,
            &shadow,
            now,
            &std::format!("seed={seed} step={step}"),
        );
    }
}
