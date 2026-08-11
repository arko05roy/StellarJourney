/**
 * Decimal-string <-> integer base-unit conversion for on-chain token amounts
 * (CLAUDE.md §9, PLAN.md §10.10).
 *
 * Invariant this module exists to enforce: on-chain amounts are always
 * integer base units (`bigint`, matching the contract's `i128`); API-facing
 * amounts are always decimal strings (e.g. `"15.00"`). This is the *only*
 * place that conversion between the two happens. No floating-point
 * arithmetic anywhere, and a value with more fractional precision than the
 * asset's declared `decimals` is rejected outright — never silently rounded.
 */

/** Bare non-negative decimal literal: optional fractional part, no sign, no exponent, no whitespace. */
const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;

/** Thrown by every conversion in this module on any malformed or out-of-range input. */
export class MoneyConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyConversionError";
  }
}

function assertValidDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new MoneyConversionError(`decimals must be a non-negative integer, got ${String(decimals)}`);
  }
}

/**
 * Parses a non-negative decimal string into integer base units for an asset
 * with the given number of declared decimals.
 *
 * Rejects, never rounds:
 *   - malformed strings (empty, signs, exponents, multiple dots, whitespace,
 *     non-digit characters)
 *   - a fractional part with more digits than `decimals` supports (e.g.
 *     `"1.2345678"` against a 7-decimal asset)
 */
export function decimalToBaseUnits(decimal: string, decimals: number): bigint {
  assertValidDecimals(decimals);
  if (!DECIMAL_STRING_PATTERN.test(decimal)) {
    throw new MoneyConversionError(
      `"${decimal}" is not a valid non-negative decimal amount (expected digits, optionally one "." and more digits)`,
    );
  }
  const dotIndex = decimal.indexOf(".");
  const wholePart = dotIndex === -1 ? decimal : decimal.slice(0, dotIndex);
  const fractionalPart = dotIndex === -1 ? "" : decimal.slice(dotIndex + 1);
  if (fractionalPart.length > decimals) {
    throw new MoneyConversionError(
      `"${decimal}" has ${String(fractionalPart.length)} fractional digits, but this asset supports only ${String(decimals)}`,
    );
  }
  const paddedFractional = fractionalPart.padEnd(decimals, "0");
  return BigInt(`${wholePart}${paddedFractional}`);
}

/**
 * Renders integer base units as a full-precision, non-negative decimal
 * string for the given number of declared decimals. Never trims trailing
 * zeros — this is the exact-inverse counterpart of {@link decimalToBaseUnits},
 * and round-tripping through both must be lossless.
 */
export function baseUnitsToDecimalString(amount: bigint, decimals: number): string {
  assertValidDecimals(decimals);
  if (amount < 0n) {
    throw new MoneyConversionError(`amount must be non-negative, got ${amount.toString()}`);
  }
  const digits = amount.toString().padStart(decimals + 1, "0");
  if (decimals === 0) {
    return digits;
  }
  const wholePart = digits.slice(0, digits.length - decimals);
  const fractionalPart = digits.slice(digits.length - decimals);
  return `${wholePart}.${fractionalPart}`;
}

/**
 * Convenience guard for charge/refund amounts (CLAUDE.md §10 — reject
 * negative or zero charge amounts at the API boundary). Returns the parsed
 * base units, throwing {@link MoneyConversionError} for zero or malformed
 * input on top of {@link decimalToBaseUnits}'s own checks.
 */
export function decimalToPositiveBaseUnits(decimal: string, decimals: number): bigint {
  const amount = decimalToBaseUnits(decimal, decimals);
  if (amount <= 0n) {
    throw new MoneyConversionError(`amount must be positive, got "${decimal}"`);
  }
  return amount;
}
