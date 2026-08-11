/**
 * Fast, no-signature, no-token-call precheck for `POST
 * /v1/mandates/:id/charges` (CLAUDE.md §2/§10 — reject
 * deterministically-doomed charge requests up front with the specific
 * contract error code, rather than queuing work that can't succeed).
 *
 * This mirrors `contracts/mandate-registry/src/charge.rs`'s validation
 * order exactly for every step that only needs the `Mandate` struct itself
 * (steps 2, 3/4, 8, 9, 10, 11-12 in that file's numbering) — CLAUDE.md §20:
 * the contract is canonical, this is a mirror. Two classes of step are
 * deliberately *not* mirrored here, because they need something this
 * precheck doesn't have:
 *
 *   - Step 5 (`mandate.merchant.require_auth()`) and step 6 (duplicate
 *     `charge_id`) require an actual signed transaction / a chosen
 *     `charge_id` — meaningless before either exists.
 *   - Steps 13-14 (token allowance/balance) require a live token-contract
 *     read this precheck does not perform, to avoid duplicating the
 *     relayer's own pre-flight responsibility (Phase 9, CLAUDE.md §11).
 *     A charge that clears this precheck can still fail those two steps at
 *     actual submission time — that failure surfaces through the relayer's
 *     pipeline, not this endpoint.
 *
 * Returns `null` when nothing this function checks would reject the charge.
 */
import { decodeMandateErrorName, type MandateContractError } from "@paymap/stellar";
import type { Mandate, MandateStatus } from "@paymap/contract-client";

const NON_ACTIVE_STATUS_ERROR_NAME: Readonly<Record<Exclude<MandateStatus, "Active">, string>> = {
  Paused: "MandatePaused",
  Revoked: "MandateRevoked",
  Completed: "MandateCompleted",
  Expired: "MandateExpired",
};

export function precheckCharge(mandate: Mandate, amount: bigint, nowSeconds: bigint): MandateContractError | null {
  // Step 2 (computed/effective status — the contract-read `Mandate` already
  // reflects lazy expiry, see `packages/contract-client`'s `getMandate`).
  if (mandate.status !== "Active") {
    return decodeMandateErrorName(NON_ACTIVE_STATUS_ERROR_NAME[mandate.status]);
  }

  // Step 3.
  if (nowSeconds < mandate.startAt) {
    return decodeMandateErrorName("ChargeBeforeStart");
  }
  // Step 4 (defense-in-depth, mirroring the contract's own restatement).
  if (nowSeconds >= mandate.expiresAt) {
    return decodeMandateErrorName("MandateExpired");
  }

  if (amount <= 0n) {
    return decodeMandateErrorName("InvalidAmount");
  }

  // Step 8.
  if (mandate.amountRule.kind === "fixed") {
    if (amount !== mandate.amountRule.amount) {
      return decodeMandateErrorName("AmountExceedsChargeLimit");
    }
  } else if (amount > mandate.amountRule.maxPerCharge) {
    return decodeMandateErrorName("AmountExceedsChargeLimit");
  }

  // Step 9.
  if (mandate.lastChargedAt !== undefined) {
    const nextEligibleAt = mandate.lastChargedAt + mandate.minIntervalSeconds;
    if (nowSeconds < nextEligibleAt) {
      return decodeMandateErrorName("ChargeTooSoon");
    }
  }

  // Step 10.
  if (mandate.maxSuccessfulCharges !== 0 && mandate.successfulCharges >= mandate.maxSuccessfulCharges) {
    return decodeMandateErrorName("ChargeCountExceeded");
  }

  // Steps 11-12: billing-period rollover + remaining allowance, identical
  // boundary-comparison formula to charge.rs (never a derived index).
  const elapsedSinceStart = nowSeconds - mandate.startAt;
  const periodIndex = elapsedSinceStart / mandate.periodSeconds;
  const computedPeriodStart = mandate.startAt + periodIndex * mandate.periodSeconds;
  const effectivePeriodCollected = computedPeriodStart !== mandate.currentPeriodStart ? 0n : mandate.currentPeriodCollected;
  const newPeriodCollected = effectivePeriodCollected + amount;
  if (newPeriodCollected > mandate.maxPerPeriod) {
    return decodeMandateErrorName("AmountExceedsPeriodLimit");
  }

  return null;
}
