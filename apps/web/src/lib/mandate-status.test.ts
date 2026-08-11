import { describe, expect, it } from "vitest";
import type { Mandate } from "@paymap/contract-client";
import {
  computeEffectivePeriodUsage,
  computeNextEligibleChargeDate,
  deriveControlAvailability,
  deriveEffectiveStatus,
  floorDivBigInt,
} from "./mandate-status";

const DAY = 86_400n;

function baseMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    id: "a".repeat(64),
    payer: "GPAYER",
    merchant: "GMERCHANT",
    asset: `C${"A".repeat(55)}`,
    status: "Active",
    amountRule: { kind: "fixed", amount: 100n },
    maxPerPeriod: 300n,
    periodSeconds: DAY * 30n,
    minIntervalSeconds: DAY,
    startAt: 0n,
    expiresAt: DAY * 365n,
    maxSuccessfulCharges: 0,
    successfulCharges: 0,
    totalCollected: 0n,
    currentPeriodStart: 0n,
    currentPeriodCollected: 0n,
    lastChargedAt: undefined,
    createdAt: 0n,
    metadataHash: "b".repeat(64),
    ...overrides,
  };
}

describe("floorDivBigInt", () => {
  it("matches Math.floor for positive and negative dividends", () => {
    expect(floorDivBigInt(10n, 3n)).toBe(3n);
    expect(floorDivBigInt(-1n, 3n)).toBe(-1n);
    expect(floorDivBigInt(-9n, 3n)).toBe(-3n);
    expect(floorDivBigInt(0n, 3n)).toBe(0n);
  });

  it("throws on a non-positive divisor", () => {
    expect(() => floorDivBigInt(1n, 0n)).toThrow();
  });
});

describe("deriveEffectiveStatus — lazy expiry", () => {
  it("Active before expiresAt stays Active", () => {
    expect(deriveEffectiveStatus({ status: "Active", expiresAt: 1000n }, 500n)).toBe("Active");
  });

  it("Active at/after expiresAt reads as Expired", () => {
    expect(deriveEffectiveStatus({ status: "Active", expiresAt: 1000n }, 1000n)).toBe("Expired");
    expect(deriveEffectiveStatus({ status: "Active", expiresAt: 1000n }, 1001n)).toBe("Expired");
  });

  it("Paused past expiresAt also reads as Expired", () => {
    expect(deriveEffectiveStatus({ status: "Paused", expiresAt: 1000n }, 1000n)).toBe("Expired");
  });

  it("terminal statuses (Revoked, Completed) never flip to Expired", () => {
    expect(deriveEffectiveStatus({ status: "Revoked", expiresAt: 1000n }, 5000n)).toBe("Revoked");
    expect(deriveEffectiveStatus({ status: "Completed", expiresAt: 1000n }, 5000n)).toBe("Completed");
  });
});

describe("computeEffectivePeriodUsage", () => {
  it("returns the stored collected amount when `at` falls in the currently-stored period", () => {
    const mandate = baseMandate({ startAt: 0n, periodSeconds: DAY * 30n, currentPeriodStart: 0n, currentPeriodCollected: 150n, maxPerPeriod: 300n });
    const usage = computeEffectivePeriodUsage(mandate, DAY * 10n);
    expect(usage).toEqual({ periodStart: 0n, collected: 150n, max: 300n });
  });

  it("resets to 0 once the period has rolled over relative to `at`, without waiting for a real charge", () => {
    const mandate = baseMandate({ startAt: 0n, periodSeconds: DAY * 30n, currentPeriodStart: 0n, currentPeriodCollected: 300n, maxPerPeriod: 300n });
    const usage = computeEffectivePeriodUsage(mandate, DAY * 31n);
    expect(usage.periodStart).toBe(DAY * 30n);
    expect(usage.collected).toBe(0n);
  });

  it("clamps to period zero when `at` is before startAt", () => {
    const mandate = baseMandate({ startAt: DAY * 5n, periodSeconds: DAY * 30n, currentPeriodStart: DAY * 5n, currentPeriodCollected: 0n });
    const usage = computeEffectivePeriodUsage(mandate, 0n);
    expect(usage.periodStart).toBe(DAY * 5n);
    expect(usage.collected).toBe(0n);
  });
});

describe("computeNextEligibleChargeDate", () => {
  it("a never-charged mandate is eligible starting at startAt", () => {
    const mandate = baseMandate({ startAt: DAY * 5n, minIntervalSeconds: 0n });
    expect(computeNextEligibleChargeDate(mandate)).toBe(DAY * 5n);
  });

  it("respects minIntervalSeconds after the last charge", () => {
    const mandate = baseMandate({ lastChargedAt: DAY * 10n, minIntervalSeconds: DAY * 3n, currentPeriodStart: 0n, currentPeriodCollected: 0n });
    expect(computeNextEligibleChargeDate(mandate)).toBe(DAY * 13n);
  });

  it("rolls forward to the next period boundary when the interval-eligible date's period is already fully committed (fixed amount)", () => {
    // Fixed amount 100, maxPerPeriod 100 — period [0, 30d) already fully collected.
    const mandate = baseMandate({
      amountRule: { kind: "fixed", amount: 100n },
      maxPerPeriod: 100n,
      periodSeconds: DAY * 30n,
      currentPeriodStart: 0n,
      currentPeriodCollected: 100n,
      lastChargedAt: DAY * 5n,
      minIntervalSeconds: DAY,
      startAt: 0n,
    });
    // Interval-only candidate would be day 6, still inside the exhausted period [0,30) -> rolls to day 30.
    expect(computeNextEligibleChargeDate(mandate)).toBe(DAY * 30n);
  });

  it("variable-amount rule only rolls forward when the period is fully exhausted, not merely partially used", () => {
    const mandate = baseMandate({
      amountRule: { kind: "variable", maxPerCharge: 1_000n },
      maxPerPeriod: 300n,
      currentPeriodStart: 0n,
      currentPeriodCollected: 299n, // 1 unit of headroom left — any positive variable charge above 1 would fail, but we can't know that, so don't force a wait
      lastChargedAt: DAY * 2n,
      minIntervalSeconds: DAY,
      startAt: 0n,
    });
    expect(computeNextEligibleChargeDate(mandate)).toBe(DAY * 3n);
  });

  it("variable-amount rule rolls forward once the period is fully (not partially) exhausted", () => {
    const mandate = baseMandate({
      amountRule: { kind: "variable", maxPerCharge: 1_000n },
      maxPerPeriod: 300n,
      periodSeconds: DAY * 30n,
      currentPeriodStart: 0n,
      currentPeriodCollected: 300n,
      lastChargedAt: DAY * 2n,
      minIntervalSeconds: DAY,
      startAt: 0n,
    });
    expect(computeNextEligibleChargeDate(mandate)).toBe(DAY * 30n);
  });

  it("returns undefined when the mandate is not Active", () => {
    const mandate = baseMandate({ status: "Paused" });
    expect(computeNextEligibleChargeDate(mandate)).toBeUndefined();
  });

  it("returns undefined once the charge count is exhausted", () => {
    const mandate = baseMandate({ maxSuccessfulCharges: 3, successfulCharges: 3 });
    expect(computeNextEligibleChargeDate(mandate)).toBeUndefined();
  });

  it("returns undefined when the computed date would fall at/after expiresAt", () => {
    const mandate = baseMandate({ startAt: 0n, expiresAt: DAY * 2n, lastChargedAt: DAY, minIntervalSeconds: DAY * 5n });
    expect(computeNextEligibleChargeDate(mandate)).toBeUndefined();
  });
});

describe("deriveControlAvailability", () => {
  it("Active: pause and cancel available, resume not", () => {
    expect(deriveControlAvailability("Active")).toEqual({ canPause: true, canResume: false, canCancelAutopay: true });
  });

  it("Paused: resume and cancel available, pause not", () => {
    expect(deriveControlAvailability("Paused")).toEqual({ canPause: false, canResume: true, canCancelAutopay: true });
  });

  for (const terminal of ["Revoked", "Completed", "Expired"] as const) {
    it(`${terminal}: no controls available`, () => {
      expect(deriveControlAvailability(terminal)).toEqual({ canPause: false, canResume: false, canCancelAutopay: false });
    });
  }
});
