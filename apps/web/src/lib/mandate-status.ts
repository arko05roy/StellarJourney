/**
 * Pure, unit-tested derivations over a live-read `Mandate` (CLAUDE.md §5,
 * §13): the effective (lazily-expired) status, the next date a charge could
 * legally succeed, and the effective period-usage meter. No React, no
 * network, no wallet.
 *
 * These are *defense-in-depth display helpers*, not a second source of
 * truth — the contract's own `get_mandate` already computes lazy expiry
 * server-side (`docs/contract-invariants.md` Phase 2), so a fresh live read
 * already reflects `deriveEffectiveStatus`'s result. This module exists so
 * the dashboard can (a) safely label a *cached* `MandateIndex` row before a
 * live read resolves, and (b) compute `nextEligibleChargeAt`/period usage,
 * which the contract has no read method for at all — both mirror the exact
 * formulas in `contracts/mandate-registry/src/charge.rs` and
 * `docs/contract-invariants.md`'s Phase 4 section, never inventing new
 * rules.
 *
 * All arithmetic is `bigint` (CLAUDE.md §9) — never `Number` on an amount
 * or a Unix-seconds timestamp beyond what's needed for `Date` display.
 */
import type { AmountRule, Mandate, MandateStatus } from "@paymap/contract-client";

/** Floor division for `bigint`, matching the contract's `floor((now - start_at) / period_seconds)` (native `bigint` `/` truncates toward zero, which only differs from floor for a negative dividend — defensive here since a client "now" earlier than `start_at` is a real, if rare, possibility). */
export function floorDivBigInt(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("floorDivBigInt: divisor must be positive");
  const q = a / b;
  const r = a % b;
  return r !== 0n && a < 0n ? q - 1n : q;
}

/**
 * Mirrors `contracts/mandate-registry/src/lifecycle.rs`'s `effective_status`
 * (`docs/contract-invariants.md` Phase 2): an `Active`/`Paused` mandate past
 * its own `expiresAt` reads as `Expired`, computed only, never persisted.
 * `Revoked`/`Completed` are already terminal and never reconsidered.
 */
export function deriveEffectiveStatus(mandate: Pick<Mandate, "status" | "expiresAt">, nowUnixSeconds: bigint): MandateStatus {
  if ((mandate.status === "Active" || mandate.status === "Paused") && nowUnixSeconds >= mandate.expiresAt) {
    return "Expired";
  }
  return mandate.status;
}

export type MandatePeriodFields = Pick<Mandate, "startAt" | "periodSeconds" | "currentPeriodStart" | "currentPeriodCollected" | "maxPerPeriod">;

export interface EffectivePeriodUsage {
  /** The boundary (Unix seconds) of the billing period containing `atUnixSeconds`. */
  periodStart: bigint;
  /** Amount actually collected in that period so far — `0n` if the stored period has already rolled over relative to `atUnixSeconds`. */
  collected: bigint;
  max: bigint;
}

/**
 * The period usage a viewer should see *right now* (or at any given
 * instant), not the mandate's raw stored `currentPeriodStart`/
 * `currentPeriodCollected` — those only update on the next charge, so a
 * mandate idle for two billing periods would otherwise still show a stale,
 * misleadingly-full meter. Mirrors `charge.rs`'s exact period-boundary
 * math: `period_index = floor((t - start_at) / period_seconds)`.
 */
export function computeEffectivePeriodUsage(mandate: MandatePeriodFields, atUnixSeconds: bigint): EffectivePeriodUsage {
  // A mandate whose billing clock hasn't started yet reads as "period zero,
  // nothing collected" rather than a negative period index.
  const clamped = atUnixSeconds > mandate.startAt ? atUnixSeconds : mandate.startAt;
  const periodIndex = floorDivBigInt(clamped - mandate.startAt, mandate.periodSeconds);
  const periodStart = mandate.startAt + periodIndex * mandate.periodSeconds;
  const collected = periodStart === mandate.currentPeriodStart ? mandate.currentPeriodCollected : 0n;
  return { periodStart, collected, max: mandate.maxPerPeriod };
}

export type NextEligibleChargeFields = Pick<
  Mandate,
  | "status"
  | "amountRule"
  | "startAt"
  | "expiresAt"
  | "lastChargedAt"
  | "minIntervalSeconds"
  | "periodSeconds"
  | "currentPeriodStart"
  | "currentPeriodCollected"
  | "maxPerPeriod"
  | "successfulCharges"
  | "maxSuccessfulCharges"
>;

/**
 * The next Unix-seconds instant at which a charge against this mandate
 * could legally succeed, or `undefined` if no future charge is possible
 * (not `Active`, charge count already exhausted, or the computed date would
 * fall at/after `expiresAt`). Two independent gates, both from
 * `contracts/mandate-registry/src/charge.rs`'s validation order:
 *
 *   1. **Timing** — `max(startAt, (lastChargedAt ?? startAt) + minIntervalSeconds)`.
 *   2. **Period allowance** — if the candidate date's billing period is
 *      already exhausted, the next eligible date rolls forward to the next
 *      period boundary (possibly several times, if a boundary is itself
 *      fully pre-committed — never actually true in practice since a period
 *      only fills as charges happen forward in time, but handled generally).
 *
 * For a `Fixed` mandate the exact next-charge amount is known, so gate 2
 * uses it precisely. For `Variable`, the next charge's amount is the
 * merchant's future choice — gate 2 conservatively only forces a wait when
 * the period is *already fully* consumed (any positive amount would then
 * be rejected), never when there's any remaining headroom at all.
 */
export function computeNextEligibleChargeDate(mandate: NextEligibleChargeFields): bigint | undefined {
  if (mandate.status !== "Active") return undefined;
  if (mandate.maxSuccessfulCharges !== 0 && mandate.successfulCharges >= mandate.maxSuccessfulCharges) return undefined;

  const intervalFloor = mandate.lastChargedAt !== undefined ? mandate.lastChargedAt + mandate.minIntervalSeconds : mandate.startAt;
  let candidate = intervalFloor > mandate.startAt ? intervalFloor : mandate.startAt;

  const knownChargeAmount: bigint | undefined = amountRuleFixedAmount(mandate.amountRule);
  const probeAmount = knownChargeAmount ?? 1n;

  // At most one rollover is ever actually needed (a period only becomes
  // "exhausted at the candidate instant" once, since the next boundary is
  // always fully empty) — the loop bound is defensive, not load-bearing.
  for (let i = 0; i < 4; i++) {
    if (candidate >= mandate.expiresAt) return undefined;
    const usage = computeEffectivePeriodUsage(mandate, candidate);
    if (usage.collected + probeAmount <= usage.max) {
      return candidate;
    }
    candidate = usage.periodStart + mandate.periodSeconds;
  }
  return candidate >= mandate.expiresAt ? undefined : candidate;
}

function amountRuleFixedAmount(rule: AmountRule): bigint | undefined {
  return rule.kind === "fixed" ? rule.amount : undefined;
}

/** Which of the payer-authorized controls are legal to show as enabled for a given effective status (mirrors `contracts/mandate-registry/src/lifecycle.rs`'s legal-transition table — CLAUDE.md §7 State). */
export interface MandateControlAvailability {
  canPause: boolean;
  canResume: boolean;
  /** "Cancel autopay" (revoke) — available on Active and Paused, per the task brief; not on an already-terminal status. */
  canCancelAutopay: boolean;
}

export function deriveControlAvailability(status: MandateStatus): MandateControlAvailability {
  return {
    canPause: status === "Active",
    canResume: status === "Paused",
    canCancelAutopay: status === "Active" || status === "Paused",
  };
}
