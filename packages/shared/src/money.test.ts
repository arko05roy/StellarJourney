import { describe, expect, it } from "vitest";
import {
  baseUnitsToDecimalString,
  decimalToBaseUnits,
  decimalToPositiveBaseUnits,
  MoneyConversionError,
} from "./money.js";

describe("decimalToBaseUnits", () => {
  it("converts a whole number", () => {
    expect(decimalToBaseUnits("15", 7)).toBe(150_000_000n);
  });

  it("converts a fractional amount padded to the asset's decimals", () => {
    expect(decimalToBaseUnits("15.5", 7)).toBe(155_000_000n);
    expect(decimalToBaseUnits("0.0000001", 7)).toBe(1n);
  });

  it("converts exactly at the precision boundary", () => {
    expect(decimalToBaseUnits("1.2345678", 7)).toBe(12_345_678n);
  });

  it("handles decimals=0 assets", () => {
    expect(decimalToBaseUnits("42", 0)).toBe(42n);
  });

  it("handles zero", () => {
    expect(decimalToBaseUnits("0", 7)).toBe(0n);
    expect(decimalToBaseUnits("0.0", 7)).toBe(0n);
  });

  it("handles large values without precision loss (beyond Number.MAX_SAFE_INTEGER)", () => {
    // i128 max is far beyond what a float can represent exactly.
    expect(decimalToBaseUnits("92233720368.5477580", 7)).toBe(922_337_203_685_477_580n);
  });

  it("rejects more precision than the asset supports, never rounds", () => {
    expect(() => decimalToBaseUnits("1.23456789", 7)).toThrow(MoneyConversionError);
    expect(() => decimalToBaseUnits("0.1", 0)).toThrow(MoneyConversionError);
  });

  it("rejects negative amounts", () => {
    expect(() => decimalToBaseUnits("-1.5", 7)).toThrow(MoneyConversionError);
  });

  it("rejects malformed strings", () => {
    for (const bad of ["", "abc", "1.2.3", "1e10", " 1", "1.5 ", "+1", "1.", ".5", "1_000", "NaN", "Infinity"]) {
      expect(() => decimalToBaseUnits(bad, 7), `expected "${bad}" to be rejected`).toThrow(MoneyConversionError);
    }
  });

  it("rejects an invalid decimals argument", () => {
    expect(() => decimalToBaseUnits("1", -1)).toThrow(MoneyConversionError);
    expect(() => decimalToBaseUnits("1", 1.5)).toThrow(MoneyConversionError);
  });
});

describe("baseUnitsToDecimalString", () => {
  it("renders a whole number with full-precision trailing zeros", () => {
    expect(baseUnitsToDecimalString(150_000_000n, 7)).toBe("15.0000000");
  });

  it("renders a fractional amount", () => {
    expect(baseUnitsToDecimalString(1n, 7)).toBe("0.0000001");
  });

  it("handles decimals=0 assets", () => {
    expect(baseUnitsToDecimalString(42n, 0)).toBe("42");
  });

  it("handles zero", () => {
    expect(baseUnitsToDecimalString(0n, 7)).toBe("0.0000000");
  });

  it("rejects a negative amount", () => {
    expect(() => baseUnitsToDecimalString(-1n, 7)).toThrow(MoneyConversionError);
  });

  it("rejects an invalid decimals argument", () => {
    expect(() => baseUnitsToDecimalString(1n, -1)).toThrow(MoneyConversionError);
  });
});

describe("round-trip identity", () => {
  const cases: Array<{ decimal: string; decimals: number }> = [
    { decimal: "0.0000000", decimals: 7 },
    { decimal: "15.0000000", decimals: 7 },
    { decimal: "0.0000001", decimals: 7 },
    { decimal: "1234567890.1234567", decimals: 7 },
    { decimal: "1.00", decimals: 2 },
    { decimal: "42", decimals: 0 },
    { decimal: "170141183460469.231731687303715884", decimals: 18 },
  ];

  for (const { decimal, decimals } of cases) {
    it(`round-trips "${decimal}" at ${decimals} decimals`, () => {
      const baseUnits = decimalToBaseUnits(decimal, decimals);
      expect(baseUnitsToDecimalString(baseUnits, decimals)).toBe(decimal);
    });
  }
});

describe("decimalToPositiveBaseUnits", () => {
  it("accepts a positive amount", () => {
    expect(decimalToPositiveBaseUnits("1.5", 7)).toBe(15_000_000n);
  });

  it("rejects zero", () => {
    expect(() => decimalToPositiveBaseUnits("0", 7)).toThrow(MoneyConversionError);
    expect(() => decimalToPositiveBaseUnits("0.0", 7)).toThrow(MoneyConversionError);
  });

  it("rejects negative", () => {
    expect(() => decimalToPositiveBaseUnits("-1", 7)).toThrow(MoneyConversionError);
  });
});
