//! Mandate lifecycle: `create_mandate`, `pause_mandate`, `resume_mandate`,
//! `revoke_mandate`, `get_mandate` (PLAN.md §10.4, §10.5, §10.8, §10.9;
//! CLAUDE.md §6 method scope, §7 authorization/state invariants).
//!
//! No money movement happens in this module — `charge` (Phase 3) is the
//! first point token transfer occurs. Every write here goes through
//! `storage.rs`; every amount/time computation that could over/underflow
//! goes through `math.rs` (none are needed yet: this phase only compares and
//! copies values, it never adds or subtracts amounts).
//!
//! ## Computed-only expiry
//!
//! `MandateStatus::Expired` is never persisted. `effective_status` derives
//! it on every read (`get_mandate`) and on every write-path status check
//! (`pause_mandate`, `resume_mandate`, `revoke_mandate`) as
//! `now >= expires_at` for a stored `Active` or `Paused` mandate. A stored
//! `Revoked` or `Completed` mandate keeps its terminal status regardless of
//! `expires_at` — those are already final and must not be masked by
//! `Expired`. Getters stay side-effect free (no storage write); write paths
//! that reject an expired mandate (`pause`/`resume`) also write nothing,
//! since they return before touching storage. `revoke_mandate` is the one
//! write path that *succeeds* against a computed-`Expired` mandate — see the
//! module-level doc on that function for why.

use soroban_sdk::{BytesN, Env};

use crate::{
    error::Error,
    events, id, storage,
    types::{AmountRule, Mandate, MandateInput, MandateStatus},
};

/// Derive the status a caller should observe right now, without persisting
/// anything. Only `Active`/`Paused` can lazily become `Expired`; `Revoked`
/// and `Completed` are already terminal and are returned unchanged.
fn effective_status(mandate: &Mandate, now: u64) -> MandateStatus {
    match mandate.status {
        MandateStatus::Active | MandateStatus::Paused if now >= mandate.expires_at => {
            MandateStatus::Expired
        }
        ref other => other.clone(),
    }
}

/// Validate every `create_mandate` input bound (CLAUDE.md §6 scope, the
/// Phase 2 lead decisions). Each bound maps to the most specific existing
/// error where one fits (`InvalidAmount` for a non-positive amount rule
/// value); anything else uses the new `InvalidMandateInput` (see
/// `error.rs`). `min_interval_seconds` and `max_successful_charges` are
/// intentionally unchecked here — `0` is a legitimate value for both ("no
/// interval constraint" / "unlimited charges"), and no upper bound is
/// mandated by the product rules.
fn validate_input(env: &Env, input: &MandateInput) -> Result<(), Error> {
    let per_charge_cap = match input.amount_rule {
        AmountRule::Fixed(amount) => {
            if amount <= 0 {
                return Err(Error::InvalidAmount);
            }
            amount
        }
        AmountRule::Variable(max_per_charge) => {
            if max_per_charge <= 0 {
                return Err(Error::InvalidAmount);
            }
            max_per_charge
        }
    };

    if input.max_per_period <= 0 {
        return Err(Error::InvalidMandateInput);
    }
    // A period cap below the per-charge cap can never be charged even once —
    // reject it outright rather than allowing a mandate that is dead on
    // arrival.
    if input.max_per_period < per_charge_cap {
        return Err(Error::InvalidMandateInput);
    }
    if input.period_seconds == 0 {
        return Err(Error::InvalidMandateInput);
    }
    if input.expires_at <= input.start_at {
        return Err(Error::InvalidMandateInput);
    }
    let now = env.ledger().timestamp();
    if input.expires_at <= now {
        return Err(Error::InvalidMandateInput);
    }
    if input.payer == input.merchant {
        return Err(Error::InvalidMandateInput);
    }

    Ok(())
}

/// `payer.require_auth()` — payer authorization only (PLAN.md §10.5). The
/// merchant and the relayer never authorize mandate creation.
pub fn create_mandate(env: &Env, input: MandateInput) -> Result<BytesN<32>, Error> {
    input.payer.require_auth();

    let mandate_id = id::derive_mandate_id(
        env,
        &input.payer,
        &input.merchant,
        &input.asset,
        &input.client_nonce,
    );

    if storage::get_mandate(env, &mandate_id).is_some() {
        return Err(Error::DuplicateMandate);
    }

    validate_input(env, &input)?;

    let now = env.ledger().timestamp();

    let mandate = Mandate {
        id: mandate_id.clone(),
        payer: input.payer.clone(),
        merchant: input.merchant.clone(),
        asset: input.asset.clone(),
        status: MandateStatus::Active,
        amount_rule: input.amount_rule.clone(),
        max_per_period: input.max_per_period,
        period_seconds: input.period_seconds,
        min_interval_seconds: input.min_interval_seconds,
        start_at: input.start_at,
        expires_at: input.expires_at,
        max_successful_charges: input.max_successful_charges,
        successful_charges: 0,
        total_collected: 0,
        current_period_start: input.start_at,
        current_period_collected: 0,
        last_charged_at: None,
        created_at: now,
        metadata_hash: input.metadata_hash.clone(),
    };

    storage::set_mandate(env, &mandate);

    events::MandateCreated {
        mandate_id: mandate_id.clone(),
        payer: input.payer,
        merchant: input.merchant,
        asset: input.asset,
        amount_rule: input.amount_rule,
        max_per_period: input.max_per_period,
        period_seconds: input.period_seconds,
        min_interval_seconds: input.min_interval_seconds,
        start_at: input.start_at,
        expires_at: input.expires_at,
        max_successful_charges: input.max_successful_charges,
        metadata_hash: input.metadata_hash,
        timestamp: now,
    }
    .publish(env);

    Ok(mandate_id)
}

/// `Active -> Paused`. Every other observed status is a rejection with the
/// most specific error: `Paused` itself rejects with `MandateNotActive`
/// rather than silently succeeding a second time — an idempotent no-op here
/// would hide a caller bug that thinks it's pausing an active mandate.
pub fn pause_mandate(env: &Env, mandate_id: &BytesN<32>) -> Result<(), Error> {
    let mut mandate = storage::get_mandate(env, mandate_id).ok_or(Error::MandateNotFound)?;
    mandate.payer.require_auth();

    let now = env.ledger().timestamp();
    match effective_status(&mandate, now) {
        MandateStatus::Active => {}
        MandateStatus::Paused => return Err(Error::MandateNotActive),
        MandateStatus::Revoked => return Err(Error::MandateRevoked),
        MandateStatus::Completed => return Err(Error::MandateCompleted),
        MandateStatus::Expired => return Err(Error::MandateExpired),
    }

    mandate.status = MandateStatus::Paused;
    storage::set_mandate(env, &mandate);

    events::MandatePaused {
        mandate_id: mandate_id.clone(),
        payer: mandate.payer,
        merchant: mandate.merchant,
        timestamp: now,
    }
    .publish(env);

    Ok(())
}

/// `Paused -> Active`. `Active` itself rejects with `InvalidStateTransition`
/// (there is no more specific status error for "already active" the way
/// `MandateRevoked`/`MandateCompleted`/`MandateExpired` cover their states).
pub fn resume_mandate(env: &Env, mandate_id: &BytesN<32>) -> Result<(), Error> {
    let mut mandate = storage::get_mandate(env, mandate_id).ok_or(Error::MandateNotFound)?;
    mandate.payer.require_auth();

    let now = env.ledger().timestamp();
    match effective_status(&mandate, now) {
        MandateStatus::Paused => {}
        MandateStatus::Active => return Err(Error::InvalidStateTransition),
        MandateStatus::Revoked => return Err(Error::MandateRevoked),
        MandateStatus::Completed => return Err(Error::MandateCompleted),
        MandateStatus::Expired => return Err(Error::MandateExpired),
    }

    mandate.status = MandateStatus::Active;
    storage::set_mandate(env, &mandate);

    events::MandateResumed {
        mandate_id: mandate_id.clone(),
        payer: mandate.payer,
        merchant: mandate.merchant,
        timestamp: now,
    }
    .publish(env);

    Ok(())
}

/// `Active -> Revoked`, `Paused -> Revoked`, and — deliberately —
/// `Expired -> Revoked`. Revocation is the payer's unconditional right
/// (CLAUDE.md §7, PLAN.md §10.9): it must never require merchant approval
/// and must never be blocked by a status the payer doesn't control, expiry
/// included. An already-`Revoked` mandate rejects with `MandateRevoked`
/// (revocation is not idempotent-success, matching the pause/resume
/// no-silent-no-op rule); a `Completed` mandate rejects with
/// `MandateCompleted` (nothing left to revoke). Receipts are never touched.
pub fn revoke_mandate(env: &Env, mandate_id: &BytesN<32>) -> Result<(), Error> {
    let mut mandate = storage::get_mandate(env, mandate_id).ok_or(Error::MandateNotFound)?;
    mandate.payer.require_auth();

    let now = env.ledger().timestamp();
    match effective_status(&mandate, now) {
        MandateStatus::Active | MandateStatus::Paused | MandateStatus::Expired => {}
        MandateStatus::Revoked => return Err(Error::MandateRevoked),
        MandateStatus::Completed => return Err(Error::MandateCompleted),
    }

    mandate.status = MandateStatus::Revoked;
    storage::set_mandate(env, &mandate);

    events::MandateRevoked {
        mandate_id: mandate_id.clone(),
        payer: mandate.payer,
        merchant: mandate.merchant,
        timestamp: now,
    }
    .publish(env);

    Ok(())
}

/// Read-only. Returns a copy of the stored mandate with `status` overridden
/// to the computed value from `effective_status` — never writes storage, so
/// repeated calls after expiry keep reporting `Expired` without the stored
/// record ever actually changing (proved by a Phase 2 test that inspects
/// storage directly after a `get_mandate` call).
pub fn get_mandate(env: &Env, mandate_id: &BytesN<32>) -> Result<Mandate, Error> {
    let mandate = storage::get_mandate(env, mandate_id).ok_or(Error::MandateNotFound)?;
    let now = env.ledger().timestamp();
    let status = effective_status(&mandate, now);
    Ok(Mandate { status, ..mandate })
}
