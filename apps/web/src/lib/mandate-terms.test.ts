import { describe, expect, it } from "vitest";
import { computeBoundedAllowance, computeMaxExposure, deriveMandateTerms, type MandateTerms } from "./mandate-terms";
import type { PublicProduct } from "./api";

function fixedProduct(overrides: Partial<PublicProduct> = {}): PublicProduct {
  return {
    id: "prod-1",
    name: "Pro Plan",
    assetAddress: "CA".padEnd(56, "A"),
    assetDecimals: 7,
    amountType: "fixed",
    fixedAmount: "15.00",
    maxPerPeriod: "15.00",
    periodSeconds: 2_592_000, // 30 days
    minIntervalSeconds: 0,
    maxSuccessfulCharges: 12,
    defaultDurationSeconds: 31_536_000, // 365 days -> 12 periods of 30 days (with remainder)
    active: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("deriveMandateTerms", () => {
  it("derives fixed-amount terms with startAt = now and expiresAt = now + defaultDurationSeconds", () => {
    const now = 1_800_000_000n;
    const terms = deriveMandateTerms(fixedProduct(), now);
    expect(terms.amountRule).toEqual({ kind: "fixed", amount: 150_000_000n }); // 15.00 * 10^7
    expect(terms.startAt).toBe(now);
    expect(terms.expiresAt).toBe(now + 31_536_000n);
    expect(terms.periodSeconds).toBe(2_592_000n);
  });

  it("derives variable-amount terms from maxPerCharge", () => {
    const now = 0n;
    const terms = deriveMandateTerms(
      fixedProduct({ amountType: "variable", fixedAmount: undefined, maxPerCharge: "50.00" }),
      now,
    );
    expect(terms.amountRule).toEqual({ kind: "variable", maxPerCharge: 500_000_000n });
  });

  it("throws if the amount field for the declared amountType is missing (API contract violation)", () => {
    expect(() => deriveMandateTerms(fixedProduct({ fixedAmount: undefined }), 0n)).toThrow();
  });
});

describe("computeMaxExposure", () => {
  const base: Pick<MandateTerms, "amountRule" | "maxPerPeriod" | "periodSeconds" | "maxSuccessfulCharges" | "startAt" | "expiresAt"> = {
    amountRule: { kind: "fixed", amount: 150_000_000n }, // 15.00
    maxPerPeriod: 150_000_000n,
    periodSeconds: 2_592_000n, // 30 days
    maxSuccessfulCharges: 12,
    startAt: 0n,
    expiresAt: 31_536_000n, // 365 days -> ceil(365/30) = 13 periods
  };

  it("takes the charge-count bound when it is tighter than the period bound", () => {
    // charge-count bound: 15 * 12 = 180; period bound: 15 * 13 periods = 195
    expect(computeMaxExposure(base)).toBe(150_000_000n * 12n);
  });

  it("takes the period bound when it is tighter than the charge-count bound", () => {
    const terms = { ...base, maxSuccessfulCharges: 100 }; // charge-count bound: 1500, period bound stays 195
    expect(computeMaxExposure(terms)).toBe(150_000_000n * 13n);
  });

  it("ignores the charge-count bound entirely when maxSuccessfulCharges is 0 (unlimited)", () => {
    const terms = { ...base, maxSuccessfulCharges: 0 };
    // Only the period bound applies: 15 * 13 periods.
    expect(computeMaxExposure(terms)).toBe(150_000_000n * 13n);
  });

  it("computes periods with ceiling division (a partial trailing period still counts as a full period)", () => {
    // 31 days duration, 30-day period -> ceil(31/30) = 2 periods, not 1.
    const terms = { ...base, expiresAt: 31n * 86_400n, maxSuccessfulCharges: 0 };
    expect(computeMaxExposure(terms)).toBe(150_000_000n * 2n);
  });

  it("never throws or loses precision for amounts far beyond Number.MAX_SAFE_INTEGER (overflow-safe bigint math)", () => {
    const hugeAmount = 10n ** 30n; // far beyond i128... but bigint has no upper bound, so this just proves no Number coercion happens anywhere in the calculation
    const terms = {
      amountRule: { kind: "fixed" as const, amount: hugeAmount },
      maxPerPeriod: hugeAmount,
      periodSeconds: 1n,
      maxSuccessfulCharges: 1_000_000,
      startAt: 0n,
      expiresAt: 1_000_000n,
    };
    const result = computeMaxExposure(terms);
    expect(result).toBe(hugeAmount * 1_000_000n); // charge-count bound is tighter here
    expect(typeof result).toBe("bigint");
  });
});

describe("computeBoundedAllowance", () => {
  it("adds a small, disclosed headroom on top of the exact maximum exposure, rounded up", () => {
    const allowance = computeBoundedAllowance(1_000_000n);
    expect(allowance.maxExposure).toBe(1_000_000n);
    expect(allowance.feeHeadroom).toBe(10_000n); // 1% of 1,000,000
    expect(allowance.total).toBe(1_010_000n);
  });

  it("rounds the headroom up rather than truncating, so it never rounds below what was disclosed", () => {
    const allowance = computeBoundedAllowance(3n); // 1% of 3 = 0.03 -> ceil to 1
    expect(allowance.feeHeadroom).toBe(1n);
    expect(allowance.total).toBe(4n);
  });

  it("never approves an unbounded amount for a zero exposure", () => {
    const allowance = computeBoundedAllowance(0n);
    expect(allowance.total).toBe(0n);
  });

  it("rejects a negative maxExposure", () => {
    expect(() => computeBoundedAllowance(-1n)).toThrow();
  });
});
