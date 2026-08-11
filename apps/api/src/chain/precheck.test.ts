import { describe, expect, it } from "vitest";
import { precheckCharge } from "./precheck.js";
import { buildMandate } from "../test/helpers.js";

const NOW = 1_000_000n;

describe("precheckCharge", () => {
  it("accepts a valid fixed-amount charge on an Active mandate", () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n, amountRule: { kind: "fixed", amount: 500n } });
    expect(precheckCharge(mandate, 500n, NOW)).toBeNull();
  });

  for (const status of ["Paused", "Revoked", "Completed", "Expired"] as const) {
    it(`rejects a ${status} mandate with Mandate${status}`, () => {
      const mandate = buildMandate({ status });
      const error = precheckCharge(mandate, 500n, NOW);
      expect(error?.info.name).toBe(`Mandate${status}`);
    });
  }

  it("rejects a charge before start_at with ChargeBeforeStart", () => {
    const mandate = buildMandate({ status: "Active", startAt: NOW + 1n });
    const error = precheckCharge(mandate, 500n, NOW);
    expect(error?.info.name).toBe("ChargeBeforeStart");
  });

  it("rejects a charge at/after expires_at with MandateExpired even if status still says Active", () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n, expiresAt: NOW });
    const error = precheckCharge(mandate, 500n, NOW);
    expect(error?.info.name).toBe("MandateExpired");
  });

  it("rejects zero/negative amount with InvalidAmount", () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n });
    expect(precheckCharge(mandate, 0n, NOW)?.info.name).toBe("InvalidAmount");
    expect(precheckCharge(mandate, -1n, NOW)?.info.name).toBe("InvalidAmount");
  });

  describe("fixed amount rule", () => {
    it("rejects an amount smaller than the fixed amount", () => {
      const mandate = buildMandate({ status: "Active", startAt: 0n, amountRule: { kind: "fixed", amount: 500n } });
      expect(precheckCharge(mandate, 499n, NOW)?.info.name).toBe("AmountExceedsChargeLimit");
    });
    it("rejects an amount larger than the fixed amount", () => {
      const mandate = buildMandate({ status: "Active", startAt: 0n, amountRule: { kind: "fixed", amount: 500n } });
      expect(precheckCharge(mandate, 501n, NOW)?.info.name).toBe("AmountExceedsChargeLimit");
    });
  });

  describe("variable amount rule", () => {
    it("accepts an amount at the cap", () => {
      const mandate = buildMandate({ status: "Active", startAt: 0n, amountRule: { kind: "variable", maxPerCharge: 500n } });
      expect(precheckCharge(mandate, 500n, NOW)).toBeNull();
    });
    it("rejects one unit over the cap", () => {
      const mandate = buildMandate({ status: "Active", startAt: 0n, amountRule: { kind: "variable", maxPerCharge: 500n } });
      expect(precheckCharge(mandate, 501n, NOW)?.info.name).toBe("AmountExceedsChargeLimit");
    });
  });

  it("rejects a charge before min_interval_seconds has elapsed since last_charged_at", () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n, minIntervalSeconds: 100n, lastChargedAt: NOW - 50n });
    expect(precheckCharge(mandate, 500n, NOW)?.info.name).toBe("ChargeTooSoon");
  });

  it("accepts exactly at the min-interval boundary (>=, not >)", () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n, minIntervalSeconds: 100n, lastChargedAt: NOW - 100n });
    expect(precheckCharge(mandate, 500n, NOW)).toBeNull();
  });

  it("rejects once max_successful_charges is reached", () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n, maxSuccessfulCharges: 3, successfulCharges: 3 });
    expect(precheckCharge(mandate, 500n, NOW)?.info.name).toBe("ChargeCountExceeded");
  });

  it("max_successful_charges = 0 means unlimited — never rejects on count", () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n, maxSuccessfulCharges: 0, successfulCharges: 1_000_000 });
    expect(precheckCharge(mandate, 500n, NOW)).toBeNull();
  });

  describe("billing-period rollover + cap", () => {
    it("rejects when the new total would exceed max_per_period within the same period", () => {
      const mandate = buildMandate({
        status: "Active",
        startAt: 0n,
        periodSeconds: 1000n,
        maxPerPeriod: 1000n,
        currentPeriodStart: 0n,
        currentPeriodCollected: 600n,
      });
      expect(precheckCharge(mandate, 500n, 500n)?.info.name).toBe("AmountExceedsPeriodLimit");
    });

    it("accepts two charges summing exactly to the cap in the same period", () => {
      const mandate = buildMandate({
        status: "Active",
        startAt: 0n,
        periodSeconds: 1000n,
        maxPerPeriod: 1000n,
        currentPeriodStart: 0n,
        currentPeriodCollected: 500n,
      });
      expect(precheckCharge(mandate, 500n, 500n)).toBeNull();
    });

    it("resets the effective allowance once the computed period boundary rolls over", () => {
      const mandate = buildMandate({
        status: "Active",
        startAt: 0n,
        periodSeconds: 1000n,
        maxPerPeriod: 1000n,
        currentPeriodStart: 0n,
        currentPeriodCollected: 900n,
      });
      // now = 1000 -> period index 1, boundary 1000 != stored 0 -> reset.
      expect(precheckCharge(mandate, 1000n, 1000n)).toBeNull();
    });

    it("does NOT reset one second before the boundary (still the old period, still capped)", () => {
      const mandate = buildMandate({
        status: "Active",
        startAt: 0n,
        periodSeconds: 1000n,
        maxPerPeriod: 1000n,
        currentPeriodStart: 0n,
        currentPeriodCollected: 900n,
      });
      expect(precheckCharge(mandate, 200n, 999n)?.info.name).toBe("AmountExceedsPeriodLimit");
    });

    it("resolves the correct far-forward boundary after skipping several periods", () => {
      const mandate = buildMandate({
        status: "Active",
        startAt: 0n,
        periodSeconds: 1000n,
        maxPerPeriod: 1000n,
        currentPeriodStart: 0n,
        currentPeriodCollected: 900n,
      });
      // now = 5200 -> period index 5, boundary 5000 != stored 0 -> reset, full allowance available.
      expect(precheckCharge(mandate, 1000n, 5200n)).toBeNull();
    });
  });
});
