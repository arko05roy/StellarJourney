import { describe, expect, it } from "vitest";
import { computeRefundableRemainingBaseUnits, validateRefundAmount } from "./merchant-refund-form";

describe("computeRefundableRemainingBaseUnits", () => {
  it("computes the full amount as refundable when nothing has been refunded yet", () => {
    const remaining = computeRefundableRemainingBaseUnits({ amount: "100.00", refundedTotal: "0.00" }, 2);
    expect(remaining).toBe(10_000n);
  });

  it("subtracts prior partial refunds", () => {
    const remaining = computeRefundableRemainingBaseUnits({ amount: "100.00", refundedTotal: "40.00" }, 2);
    expect(remaining).toBe(6_000n);
  });

  it("clamps to zero rather than going negative for a fully-refunded payment", () => {
    const remaining = computeRefundableRemainingBaseUnits({ amount: "100.00", refundedTotal: "100.00" }, 2);
    expect(remaining).toBe(0n);
  });
});

describe("validateRefundAmount", () => {
  it("accepts an amount at exactly the remaining refundable total", () => {
    const result = validateRefundAmount("60.00", 2, 6_000n);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect(result.amountBaseUnits).toBe(6_000n);
  });

  it("rejects an amount exceeding the remaining refundable total", () => {
    const result = validateRefundAmount("60.01", 2, 6_000n);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.error).toMatch(/exceeds the remaining/);
  });

  it("rejects a zero or negative amount", () => {
    const result = validateRefundAmount("0", 2, 6_000n);
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed amount string", () => {
    const result = validateRefundAmount("not-a-number", 2, 6_000n);
    expect(result.valid).toBe(false);
  });

  it("rejects over-precision relative to the asset's decimals", () => {
    const result = validateRefundAmount("10.12345", 2, 1_000_000n);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.error).toMatch(/fractional digits/);
  });
});
