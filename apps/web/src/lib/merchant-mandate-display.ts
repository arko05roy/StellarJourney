/**
 * Pure derivations over `MerchantMandate` (the API's string-ified read of a
 * live `get_mandate` — `apps/api/src/routes/mandates.ts`'s `toMandateResponse`),
 * used by the merchant dashboard's mandate/upcoming/failed views. No
 * network, no secrets — safe to import from anywhere, but only ever actually
 * used from Server Components in this app.
 *
 * `toBigintMandate` bridges the API's decimal-string wire format back to the
 * `bigint`-typed shape `lib/mandate-status.ts` already expects (CLAUDE.md
 * §20 — reuse the *same* period/next-charge/effective-status formulas the
 * consumer dashboard uses, never a second copy of these rules).
 */
import type { AmountRule, MandateStatus } from "@paymap/contract-client";
import { formatAmount, formatAssetSymbol } from "./format";
import type { MerchantMandate, MerchantProduct } from "./merchant-api";

function toUnixSeconds(iso: string): bigint {
  return BigInt(Math.floor(new Date(iso).getTime() / 1000));
}

export interface BigintMandateFields {
  status: MandateStatus;
  amountRule: AmountRule;
  maxPerPeriod: bigint;
  periodSeconds: bigint;
  minIntervalSeconds: bigint;
  startAt: bigint;
  expiresAt: bigint;
  maxSuccessfulCharges: number;
  successfulCharges: number;
  totalCollected: bigint;
  currentPeriodStart: bigint;
  currentPeriodCollected: bigint;
  lastChargedAt: bigint | undefined;
}

/** Converts the API's decimal-string mandate response back into the `bigint` shape `lib/mandate-status.ts`'s pure helpers expect. */
export function toBigintMandate(mandate: MerchantMandate): BigintMandateFields {
  return {
    status: mandate.status,
    amountRule:
      mandate.amountRule.kind === "fixed"
        ? { kind: "fixed", amount: BigInt(mandate.amountRule.amountBaseUnits) }
        : { kind: "variable", maxPerCharge: BigInt(mandate.amountRule.maxPerChargeBaseUnits) },
    maxPerPeriod: BigInt(mandate.maxPerPeriodBaseUnits),
    periodSeconds: BigInt(mandate.periodSeconds),
    minIntervalSeconds: BigInt(mandate.minIntervalSeconds),
    startAt: toUnixSeconds(mandate.startAt),
    expiresAt: toUnixSeconds(mandate.expiresAt),
    maxSuccessfulCharges: mandate.maxSuccessfulCharges,
    successfulCharges: mandate.successfulCharges,
    totalCollected: BigInt(mandate.totalCollectedBaseUnits),
    currentPeriodStart: toUnixSeconds(mandate.currentPeriodStart),
    currentPeriodCollected: BigInt(mandate.currentPeriodCollectedBaseUnits),
    lastChargedAt: mandate.lastChargedAt !== undefined ? toUnixSeconds(mandate.lastChargedAt) : undefined,
  };
}

/** The mandate's asset has no `decimals` field on-chain (CLAUDE.md §9) — resolved via the merchant's own product catalog, same join `apps/api`'s `resolveAssetDecimalsForMandate` performs server-side, falling back to 7 (this deployment's PUSD) when the asset isn't any known product's (e.g. a mandate created outside this merchant's own checkout flow). */
export function resolveAssetDecimals(products: readonly MerchantProduct[], assetAddress: string): number {
  return products.find((p) => p.assetAddress === assetAddress)?.assetDecimals ?? 7;
}

export function formatMandateAmountRule(mandate: MerchantMandate, decimals: number): string {
  const amount = mandate.amountRule.kind === "fixed" ? mandate.amountRule.amountBaseUnits : mandate.amountRule.maxPerChargeBaseUnits;
  const prefix = mandate.amountRule.kind === "fixed" ? "" : "Up to ";
  return `${prefix}${formatAmount(BigInt(amount), decimals)}`;
}

export { formatAssetSymbol };
