/**
 * Decodes a `ChargeRequest.failureCode` (`apps/api/src/routes/consumer.ts`'s
 * `failedAttempts[].failureCode`) into consumer-facing copy for the payment
 * history's failed-attempts list (`tasks/todo.md` Phase 11 requirement).
 *
 * Framing matters here: a failed attempt on this dashboard is proof the
 * protection worked, not an alarming error — every one of the 24 frozen
 * mandate-registry codes (`packages/stellar/src/errors.ts`) gets a
 * "here's what the merchant tried, and here's why we blocked it" sentence
 * where the failure is a policy rejection, distinct from `lib/errors.ts`'s
 * checkout-flow copy (which frames the *payer's own* action failing, not a
 * merchant's charge attempt being blocked on the payer's behalf).
 *
 * The code is never discarded (CLAUDE.md §8) — {@link describeFailureReason}
 * always returns the original machine code alongside the human sentence, for
 * support.
 */
import { _MANDATE_ERROR_TABLE_FOR_TEST as MANDATE_ERROR_TABLE } from "@paymap/stellar";

export interface FailureReason {
  /** Short, scannable label for the list row. */
  headline: string;
  /** One sentence explaining what happened, framed as protection working as intended where applicable. */
  explanation: string;
  /** The original machine-readable code, unchanged — never hidden (CLAUDE.md §8). */
  code: string;
}

/** One entry per frozen contract error name (`packages/stellar/src/errors.ts`'s 24-code table) — every code this protocol can produce as an on-chain policy rejection. */
const CONTRACT_FAILURE_COPY: Readonly<Record<string, { headline: string; explanation: string }>> = {
  MandateNotFound: { headline: "Automatic payment not found", explanation: "The merchant tried to charge an automatic payment that no longer exists on-chain, so we blocked it." },
  MandateNotActive: { headline: "Automatic payment wasn't active", explanation: "The merchant tried to charge an automatic payment that wasn't active at the time, so we blocked it." },
  MandatePaused: { headline: "Blocked while paused", explanation: "The merchant tried to charge while you had this automatic payment paused, so we blocked it." },
  MandateRevoked: { headline: "Blocked after you cancelled", explanation: "The merchant tried to charge after you cancelled this automatic payment, so we blocked it." },
  MandateCompleted: { headline: "Blocked after reaching its limit", explanation: "The merchant tried to charge after this automatic payment already reached its maximum number of charges, so we blocked it." },
  MandateExpired: { headline: "Blocked after expiry", explanation: "The merchant tried to charge after this automatic payment expired, so we blocked it." },
  ChargeBeforeStart: { headline: "Blocked before the start date", explanation: "The merchant tried to charge before this automatic payment's start date, so we blocked it." },
  ChargeTooSoon: { headline: "Blocked for being too soon", explanation: "The merchant tried to charge again sooner than your agreed minimum time between charges, so we blocked it." },
  InvalidAmount: { headline: "Blocked for an invalid amount", explanation: "The merchant tried to charge a zero or invalid amount, so we blocked it." },
  AmountExceedsChargeLimit: { headline: "Blocked for exceeding your maximum charge", explanation: "The merchant tried to charge more than your agreed maximum per charge, so we blocked it." },
  AmountExceedsPeriodLimit: { headline: "Blocked for exceeding your billing-period limit", explanation: "The merchant tried to charge more than your agreed maximum for this billing period, so we blocked it." },
  ChargeCountExceeded: { headline: "Blocked after reaching the charge limit", explanation: "The merchant tried to charge after already reaching the maximum number of charges you agreed to, so we blocked it." },
  DuplicateCharge: { headline: "Blocked as a duplicate", explanation: "This exact charge had already been processed once — a repeat attempt was blocked automatically." },
  UnauthorizedMerchant: { headline: "Blocked from an unauthorized sender", explanation: "A charge request came from someone other than the merchant on this automatic payment, so we blocked it." },
  InsufficientAllowance: { headline: "Your spending approval was too low", explanation: "Your approved spending limit was too low to cover this charge. Nothing was charged." },
  InsufficientBalance: { headline: "Your balance was too low", explanation: "Your account balance was too low to cover this charge. Nothing was charged." },
  PaymentNotFound: { headline: "Payment not found", explanation: "A request referenced a payment that could not be found on-chain." },
  RefundExceedsPayment: { headline: "Refund blocked as too large", explanation: "A refund attempt would have exceeded the original payment amount, so we blocked it." },
  DuplicateRefund: { headline: "Blocked as a duplicate refund", explanation: "This exact refund had already been processed once — a repeat attempt was blocked automatically." },
  ArithmeticOverflow: { headline: "Blocked as an invalid amount", explanation: "The requested amount was too large to process safely, so we blocked it." },
  InvalidMandateInput: { headline: "Blocked as invalid", explanation: "One of this automatic payment's terms was invalid." },
  DuplicateMandate: { headline: "Blocked as a duplicate", explanation: "An automatic payment with these exact terms already existed." },
  InvalidStateTransition: { headline: "Blocked as not allowed", explanation: "That action isn't allowed for this automatic payment's current status." },
  RefundNotFound: { headline: "Refund not found", explanation: "A request referenced a refund that could not be found on-chain." },
};

/** Non-contract, relayer/infra-observed reasons (`apps/relayer/src/classify.ts`'s `INFRA_TRANSIENT_REASONS`) — never a policy verdict, always a temporary submission problem the relayer retried or is retrying. */
const INFRA_FAILURE_COPY: Readonly<Record<string, { headline: string; explanation: string }>> = {
  RPC_UNAVAILABLE: { headline: "Temporary network issue", explanation: "We couldn't reach the Stellar network to submit this charge. This wasn't a policy rejection, and it may be retried automatically." },
  SEND_FAILED: { headline: "Temporary submission issue", explanation: "Submitting this charge to the network failed. This wasn't a policy rejection, and it may be retried automatically." },
  TX_NOT_INCLUDED: { headline: "Submission didn't complete in time", explanation: "This charge was submitted but didn't reach a final result in time. This wasn't a policy rejection, and it may be retried automatically." },
};

/** All codes this module can decode with dedicated copy — used by the exhaustive test to prove every frozen contract error name and every infra reason is covered. */
export const ALL_KNOWN_FAILURE_CODES: readonly string[] = [
  ...MANDATE_ERROR_TABLE.map((entry) => entry.name),
  ...Object.keys(INFRA_FAILURE_COPY),
];

/** Decodes a `failureCode` string into consumer-facing copy. Total — never throws; an unrecognized code (e.g. a newer relayer/contract build) still returns the code itself with a plain, honest fallback sentence rather than hiding it. */
export function describeFailureReason(code: string): FailureReason {
  const contractCopy = CONTRACT_FAILURE_COPY[code];
  if (contractCopy) return { ...contractCopy, code };
  const infraCopy = INFRA_FAILURE_COPY[code];
  if (infraCopy) return { ...infraCopy, code };
  return { headline: "Charge attempt blocked", explanation: `This charge attempt did not go through (code: ${code}).`, code };
}
