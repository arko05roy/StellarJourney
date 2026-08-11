/**
 * Pure validation for the "Create product" form (PLAN.md §16.3, this
 * phase's scope: "the plan/mandate-terms form — fixed vs variable, caps,
 * period, interval, expiry, max charges. Validate with the shared Zod
 * schemas; reject over-precision amounts at the boundary"). No React, no
 * network — a plain function over form strings so it's directly unit
 * testable and gives the client form immediate feedback before the
 * round-trip to `POST /v1/products` (which re-validates identically via
 * `apps/api/src/schemas/products.ts` — this is a UX preview of that
 * boundary, never a replacement for it, CLAUDE.md §20).
 */
import { decimalToPositiveBaseUnits, MoneyConversionError } from "@paymap/shared/money";
import { StellarContractAddressSchema } from "@paymap/shared/types";
import type { CreateProductInput } from "./merchant-api";

export interface ProductFormValues {
  name: string;
  description: string;
  assetAddress: string;
  assetDecimals: string;
  amountType: "fixed" | "variable";
  fixedAmount: string;
  maxPerCharge: string;
  maxPerPeriod: string;
  periodSeconds: string;
  minIntervalSeconds: string;
  maxSuccessfulCharges: string;
  defaultDurationSeconds: string;
}

export type ProductFormErrors = Partial<Record<keyof ProductFormValues, string>>;

export type ProductFormResult = { valid: true; input: CreateProductInput } | { valid: false; errors: ProductFormErrors };

/** Mirrors `apps/api/src/schemas/common.ts`'s `BoundedDurationSecondsSchema` ceiling exactly (~10 years) — never let this UI accept a value the API would reject anyway. */
const MAX_BOUNDED_DURATION_SECONDS = 60 * 60 * 24 * 365 * 10;

function parseNonNegativeInt(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function validateProductForm(values: ProductFormValues): ProductFormResult {
  const errors: ProductFormErrors = {};

  const name = values.name.trim();
  if (name.length === 0) {
    errors.name = "Product name is required.";
  } else if (name.length > 200) {
    errors.name = "Product name must be 200 characters or fewer.";
  }

  const assetAddress = values.assetAddress.trim();
  if (!StellarContractAddressSchema.safeParse(assetAddress).success) {
    errors.assetAddress = "Enter a valid Soroban asset contract address (starts with C).";
  }

  const assetDecimals = parseNonNegativeInt(values.assetDecimals);
  if (assetDecimals === undefined || assetDecimals > 24) {
    errors.assetDecimals = "Decimals must be a whole number between 0 and 24.";
  }

  const periodSeconds = parseNonNegativeInt(values.periodSeconds);
  if (periodSeconds === undefined || periodSeconds === 0 || periodSeconds > MAX_BOUNDED_DURATION_SECONDS) {
    errors.periodSeconds = "Billing period must be a positive, bounded number of seconds.";
  }

  const minIntervalSeconds = parseNonNegativeInt(values.minIntervalSeconds);
  if (minIntervalSeconds === undefined) {
    errors.minIntervalSeconds = "Minimum interval must be zero or a positive whole number of seconds.";
  }

  const maxSuccessfulCharges = parseNonNegativeInt(values.maxSuccessfulCharges);
  if (maxSuccessfulCharges === undefined) {
    errors.maxSuccessfulCharges = "Maximum charges must be zero (unlimited) or a positive whole number.";
  }

  const defaultDurationSeconds = parseNonNegativeInt(values.defaultDurationSeconds);
  if (defaultDurationSeconds === undefined || defaultDurationSeconds === 0 || defaultDurationSeconds > MAX_BOUNDED_DURATION_SECONDS) {
    errors.defaultDurationSeconds = "Mandate lifetime must be a positive, bounded number of seconds.";
  }

  // Amount-precision checks only run once `assetDecimals` itself is known good — an invalid
  // decimals value makes every amount check meaningless (CLAUDE.md §9's "reject over-precision"
  // requirement needs a real decimals figure to check precision against).
  if (assetDecimals !== undefined && assetDecimals <= 24) {
    const maxPerPeriod = values.maxPerPeriod.trim();
    try {
      decimalToPositiveBaseUnits(maxPerPeriod, assetDecimals);
    } catch (error) {
      errors.maxPerPeriod = error instanceof MoneyConversionError ? error.message : "Invalid amount.";
    }

    if (values.amountType === "fixed") {
      const fixedAmount = values.fixedAmount.trim();
      try {
        decimalToPositiveBaseUnits(fixedAmount, assetDecimals);
      } catch (error) {
        errors.fixedAmount = error instanceof MoneyConversionError ? error.message : "Invalid amount.";
      }
    } else {
      const maxPerCharge = values.maxPerCharge.trim();
      try {
        decimalToPositiveBaseUnits(maxPerCharge, assetDecimals);
      } catch (error) {
        errors.maxPerCharge = error instanceof MoneyConversionError ? error.message : "Invalid amount.";
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  // Every field this branch reads was proven defined/valid above (no error was recorded for it) —
  // the non-null assertions below are a direct consequence of the `errors` check, not a bypass.
  const base = {
    name,
    ...(values.description.trim() ? { description: values.description.trim() } : {}),
    assetAddress,
    assetDecimals: assetDecimals as number,
    maxPerPeriod: values.maxPerPeriod.trim(),
    periodSeconds: periodSeconds as number,
    minIntervalSeconds: minIntervalSeconds as number,
    maxSuccessfulCharges: maxSuccessfulCharges as number,
    defaultDurationSeconds: defaultDurationSeconds as number,
  };

  const input: CreateProductInput =
    values.amountType === "fixed"
      ? { ...base, amountType: "fixed", fixedAmount: values.fixedAmount.trim() }
      : { ...base, amountType: "variable", maxPerCharge: values.maxPerCharge.trim() };

  return { valid: true, input };
}

export const EMPTY_PRODUCT_FORM_VALUES: ProductFormValues = {
  name: "",
  description: "",
  assetAddress: "",
  assetDecimals: "7",
  amountType: "fixed",
  fixedAmount: "",
  maxPerCharge: "",
  maxPerPeriod: "",
  periodSeconds: String(30 * 24 * 60 * 60),
  minIntervalSeconds: "0",
  maxSuccessfulCharges: "0",
  defaultDurationSeconds: String(365 * 24 * 60 * 60),
};
