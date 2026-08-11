import { describe, expect, it } from "vitest";
import { formatAmount, formatBillingFrequency, formatMinInterval } from "./format";

describe("formatAmount", () => {
  it("trims cosmetic trailing zeros without rounding", () => {
    expect(formatAmount(150_000_000n, 7)).toBe("15");
    expect(formatAmount(150_500_000n, 7)).toBe("15.05");
  });

  it("keeps a zero value as \"0\", not an empty string", () => {
    expect(formatAmount(0n, 7)).toBe("0");
  });

  it("never uses floating point for large amounts", () => {
    // 12,345,678,901,234,567,890 base units at 7 decimals would lose precision as a JS Number
    // (it exceeds Number.MAX_SAFE_INTEGER) — this only passes if the whole path stays bigint.
    const huge = 12_345_678_901_234_567_890n;
    expect(formatAmount(huge, 7)).toBe("1234567890123.456789");
  });
});

describe("formatBillingFrequency", () => {
  it("recognizes common periods with plain-language labels", () => {
    expect(formatBillingFrequency(86_400n)).toBe("Every day");
    expect(formatBillingFrequency(604_800n)).toBe("Every week");
    expect(formatBillingFrequency(2_592_000n)).toBe("Every 30 days");
  });

  it("falls back to a day count for an unrecognized whole-day period", () => {
    expect(formatBillingFrequency(3n * 86_400n)).toBe("Every 3 days");
  });

  it("falls back to a raw seconds count for a non-day-aligned period", () => {
    expect(formatBillingFrequency(90n)).toBe("Every 90 seconds");
  });
});

describe("formatMinInterval", () => {
  it("renders zero as no explicit minimum", () => {
    expect(formatMinInterval(0n)).toBe("No minimum spacing beyond the billing period");
  });

  it("renders a day-aligned interval in plain language", () => {
    expect(formatMinInterval(86_400n)).toBe("At least 1 day between charges");
    expect(formatMinInterval(2n * 86_400n)).toBe("At least 2 days between charges");
  });
});
