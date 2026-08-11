/**
 * Pure business logic for the checkout review screen (CLAUDE.md §13, PLAN.md
 * §16.2/§10.10): deriving the mandate terms a payer is about to sign from a
 * merchant's `Product`, computing the maximum theoretical exposure, and
 * computing the bounded token allowance to request. No React, no network, no
 * wallet — everything here is a plain function over bigints so it can be
 * unit tested directly and never silently duplicates a contract rule (the
 * contract's own `create_mandate`/`charge` validation remains canonical;
 * this only *previews* what the payer is about to authorize).
 *
 * Money: integer base units as `bigint` throughout (CLAUDE.md §9) — no
 * `Number` arithmetic on amounts anywhere in this module, so nothing here
 * can silently lose precision or overflow for a realistic token supply.
 */
import { decimalToBaseUnits } from "@paymap/shared";
import type { PublicProduct } from "./api";

export type AmountRule = { kind: "fixed"; amount: bigint } | { kind: "variable"; maxPerCharge: bigint };

/** The exact terms a `create_mandate` call is about to authorize, derived from a product for a checkout starting now. */
export interface MandateTerms {
  assetAddress: string;
  assetDecimals: number;
  amountRule: AmountRule;
  maxPerPeriod: bigint;
  periodSeconds: bigint;
  minIntervalSeconds: bigint;
  /** 0 = unlimited (mirrors the contract's own convention — CLAUDE.md §6). */
  maxSuccessfulCharges: number;
  startAt: bigint;
  expiresAt: bigint;
}

/**
 * Derives the mandate terms a checkout starting at `nowUnixSeconds` would
 * create from a product. `startAt` is always "now" — the payer is
 * authorizing a mandate that becomes active immediately — and `expiresAt`
 * is `startAt + product.defaultDurationSeconds`, mirroring the same field
 * the merchant API already reuses for the checkout session's own expiry
 * (`apps/api/src/routes/checkout-sessions.ts`).
 */
export function deriveMandateTerms(product: PublicProduct, nowUnixSeconds: bigint): MandateTerms {
  const amountRule: AmountRule =
    product.amountType === "fixed"
      ? { kind: "fixed", amount: decimalToBaseUnits(requireAmount(product.fixedAmount, "fixedAmount"), product.assetDecimals) }
      : { kind: "variable", maxPerCharge: decimalToBaseUnits(requireAmount(product.maxPerCharge, "maxPerCharge"), product.assetDecimals) };

  return {
    assetAddress: product.assetAddress,
    assetDecimals: product.assetDecimals,
    amountRule,
    maxPerPeriod: decimalToBaseUnits(product.maxPerPeriod, product.assetDecimals),
    periodSeconds: BigInt(product.periodSeconds),
    minIntervalSeconds: BigInt(product.minIntervalSeconds),
    maxSuccessfulCharges: product.maxSuccessfulCharges,
    startAt: nowUnixSeconds,
    expiresAt: nowUnixSeconds + BigInt(product.defaultDurationSeconds),
  };
}

/** The public product API only sets `fixedAmount`/`maxPerCharge` for the matching `amountType` (mirrors `apps/api/src/routes/products.ts::toProductResponse`) — this should never actually be undefined for the branch that reads it, but fails loudly rather than silently coercing if the API contract ever drifts. */
function requireAmount(value: string | undefined, field: string): string {
  if (value === undefined) {
    throw new Error(`expected product.${field} to be set for this amountType`);
  }
  return value;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) {
    throw new Error("ceilDiv: divisor must be positive");
  }
  return (a + b - 1n) / b;
}

/**
 * The single most important number on the checkout screen: the maximum
 * total the merchant could ever collect under this mandate, in base units.
 *
 * `min(max_per_charge * max_successful_charges, max_per_period * periods_until_expiry)`
 *
 * `max_successful_charges === 0` means "unlimited charge count" (the
 * contract's own convention, CLAUDE.md §6) — in that case the per-charge x
 * count bound does not apply at all, and the period bound alone is the
 * exposure ceiling. All arithmetic is `bigint`, so this never overflows or
 * loses precision regardless of token supply or period count.
 */
export function computeMaxExposure(terms: Pick<MandateTerms, "amountRule" | "maxPerPeriod" | "periodSeconds" | "maxSuccessfulCharges" | "startAt" | "expiresAt">): bigint {
  const perChargeCeiling = terms.amountRule.kind === "fixed" ? terms.amountRule.amount : terms.amountRule.maxPerCharge;
  const durationSeconds = terms.expiresAt - terms.startAt;
  const periodsUntilExpiry = durationSeconds <= 0n ? 1n : ceilDiv(durationSeconds, terms.periodSeconds);
  const periodBound = terms.maxPerPeriod * periodsUntilExpiry;

  if (terms.maxSuccessfulCharges === 0) {
    return periodBound;
  }
  const chargeCountBound = perChargeCeiling * BigInt(terms.maxSuccessfulCharges);
  return chargeCountBound < periodBound ? chargeCountBound : periodBound;
}

/** Explicit, small, disclosed buffer on top of the theoretical maximum (PLAN.md §10.10's "small explicit fee allowance") — never large enough to look like an unlimited approval, and always shown to the payer before they sign (never silent). 100 basis points (1%), rounded up to the next base unit. */
export const ALLOWANCE_FEE_HEADROOM_BPS = 100n;

export interface BoundedAllowance {
  /** `maxExposure`, unchanged — shown as its own line so the payer can see the headroom is additive, not hidden inside a bigger number. */
  maxExposure: bigint;
  /** The extra amount on top of `maxExposure`, per {@link ALLOWANCE_FEE_HEADROOM_BPS}. */
  feeHeadroom: bigint;
  /** `maxExposure + feeHeadroom` — the exact amount the `approve` transaction will request. Never unlimited (CLAUDE.md §2). */
  total: bigint;
}

/** Computes the bounded allowance to request: the mandate's own maximum exposure plus a small, disclosed headroom. Never unlimited, never silent. */
export function computeBoundedAllowance(maxExposure: bigint): BoundedAllowance {
  if (maxExposure < 0n) {
    throw new Error("maxExposure must be non-negative");
  }
  const feeHeadroom = ceilDiv(maxExposure * ALLOWANCE_FEE_HEADROOM_BPS, 10_000n);
  return { maxExposure, feeHeadroom, total: maxExposure + feeHeadroom };
}
