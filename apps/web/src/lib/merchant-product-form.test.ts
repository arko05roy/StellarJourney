import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { EMPTY_PRODUCT_FORM_VALUES, validateProductForm, type ProductFormValues } from "./merchant-product-form";

const VALID_ASSET_ADDRESS = StrKey.encodeContract(Buffer.alloc(32, 7));

function values(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    ...EMPTY_PRODUCT_FORM_VALUES,
    name: "Studio Membership",
    assetAddress: VALID_ASSET_ADDRESS,
    assetDecimals: "7",
    amountType: "fixed",
    fixedAmount: "15.00",
    maxPerCharge: "",
    maxPerPeriod: "15.00",
    periodSeconds: String(30 * 24 * 60 * 60),
    minIntervalSeconds: "0",
    maxSuccessfulCharges: "0",
    defaultDurationSeconds: String(365 * 24 * 60 * 60),
    ...overrides,
  };
}

describe("validateProductForm — fixed vs variable branching", () => {
  it("accepts a valid fixed-amount product and never includes maxPerCharge", () => {
    const result = validateProductForm(values());
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect(result.input.amountType).toBe("fixed");
    expect(result.input).toMatchObject({ fixedAmount: "15.00" });
    expect("maxPerCharge" in result.input).toBe(false);
  });

  it("accepts a valid variable-amount product and never includes fixedAmount", () => {
    const result = validateProductForm(values({ amountType: "variable", fixedAmount: "", maxPerCharge: "50.00" }));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect(result.input.amountType).toBe("variable");
    expect(result.input).toMatchObject({ maxPerCharge: "50.00" });
    expect("fixedAmount" in result.input).toBe(false);
  });

  it("rejects a fixed product with a malformed fixedAmount, ignoring the unused maxPerCharge field", () => {
    const result = validateProductForm(values({ fixedAmount: "not-a-number", maxPerCharge: "also-garbage" }));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.fixedAmount).toBeDefined();
    expect(result.errors.maxPerCharge).toBeUndefined();
  });
});

describe("validateProductForm — over-precision rejection (CLAUDE.md §9)", () => {
  it("rejects a fixedAmount with more fractional digits than assetDecimals supports", () => {
    const result = validateProductForm(values({ assetDecimals: "2", fixedAmount: "15.12345" }));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.fixedAmount).toMatch(/fractional digits/);
  });

  it("rejects a maxPerPeriod with more fractional digits than assetDecimals supports", () => {
    const result = validateProductForm(values({ assetDecimals: "2", maxPerPeriod: "15.12345" }));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.maxPerPeriod).toMatch(/fractional digits/);
  });

  it("accepts an amount at exactly the declared precision", () => {
    const result = validateProductForm(values({ assetDecimals: "2", fixedAmount: "15.12", maxPerPeriod: "15.12" }));
    expect(result.valid).toBe(true);
  });
});

describe("validateProductForm — other bounds", () => {
  it("rejects a zero amount", () => {
    const result = validateProductForm(values({ fixedAmount: "0" }));
    expect(result.valid).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = validateProductForm(values({ name: "  " }));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.name).toBeDefined();
  });

  it("rejects a malformed asset contract address", () => {
    const result = validateProductForm(values({ assetAddress: "not-a-real-address" }));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.assetAddress).toBeDefined();
  });

  it("rejects an unbounded (absurdly large) period", () => {
    const result = validateProductForm(values({ periodSeconds: "99999999999999" }));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.periodSeconds).toBeDefined();
  });

  it("accepts maxSuccessfulCharges = 0 (unlimited, the contract's own convention)", () => {
    const result = validateProductForm(values({ maxSuccessfulCharges: "0" }));
    expect(result.valid).toBe(true);
  });

  it("omits description from the input when left blank", () => {
    const result = validateProductForm(values({ description: "   " }));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect("description" in result.input).toBe(false);
  });

  it("includes a trimmed description when provided", () => {
    const result = validateProductForm(values({ description: "  Monthly access  " }));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect(result.input.description).toBe("Monthly access");
  });
});
