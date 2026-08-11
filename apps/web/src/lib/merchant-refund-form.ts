/**
 * Pure bigint math for the merchant "Refunds" flow (PLAN.md §16.3: "initiate
 * a refund (full or partial)... amount <= remaining refundable"). No React,
 * no network — mirrors the contract's own cumulative-refund check
 * (`contracts/mandate-registry/src/refund.rs`: `refunded + amount <=
 * payment.amount`) as a client-side preview, never a replacement for the
 * API's/contract's own enforcement (CLAUDE.md §20).
 */
import { decimalToBaseUnits, decimalToPositiveBaseUnits, MoneyConversionError } from "@paymap/shared/money";

/** `payment.amount` and `payment.refundedTotal` are both decimal strings at the same asset decimals (`apps/api/src/routes/payments.ts::toPaymentResponse`) — never negative once clamped to `0n`, since a fully-refunded payment's remaining is exactly `0n`, not negative. */
export function computeRefundableRemainingBaseUnits(payment: { amount: string; refundedTotal: string }, decimals: number): bigint {
  const amount = decimalToBaseUnits(payment.amount, decimals);
  const refunded = decimalToBaseUnits(payment.refundedTotal, decimals);
  const remaining = amount - refunded;
  return remaining > 0n ? remaining : 0n;
}

export type RefundAmountValidation = { valid: true; amountBaseUnits: bigint } | { valid: false; error: string };

export function validateRefundAmount(amountDecimal: string, decimals: number, remainingBaseUnits: bigint): RefundAmountValidation {
  let amountBaseUnits: bigint;
  try {
    amountBaseUnits = decimalToPositiveBaseUnits(amountDecimal.trim(), decimals);
  } catch (error) {
    return { valid: false, error: error instanceof MoneyConversionError ? error.message : "Invalid amount." };
  }
  if (amountBaseUnits > remainingBaseUnits) {
    return { valid: false, error: "Refund amount exceeds the remaining refundable amount for this payment." };
  }
  return { valid: true, amountBaseUnits };
}
