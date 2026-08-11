/**
 * Maps failures from every step of the checkout flow to a specific,
 * consumer-readable message — never a generic "something went wrong"
 * (CLAUDE.md's error-surfacing requirement for this phase). Contract
 * failures go through `@paymap/stellar`'s frozen error table so the
 * underlying code is never lost (useful for support), while the payer sees
 * plain language.
 */
import { decodeMandateErrorName, MandateContractError } from "@paymap/stellar";
import { ApiError } from "./api";

export interface DisplayError {
  /** Plain-language sentence shown to the payer. */
  message: string;
  /** Stable machine code, shown small/secondary — useful for support, never the primary text (CLAUDE.md §8). */
  code: string;
  /** Whether retrying the exact same action could plausibly succeed (e.g. "top up your balance and try again") vs. a dead end (e.g. "this mandate was cancelled"). */
  retryable: boolean;
}

const CONTRACT_ERROR_COPY: Readonly<Record<string, string>> = {
  MandateNotFound: "We could not find that automatic payment on-chain.",
  MandateNotActive: "This automatic payment is not active.",
  MandatePaused: "This automatic payment is paused.",
  MandateRevoked: "This automatic payment has been cancelled.",
  MandateCompleted: "This automatic payment has already reached its maximum number of charges.",
  MandateExpired: "This automatic payment has expired.",
  ChargeBeforeStart: "This automatic payment cannot start yet.",
  ChargeTooSoon: "A charge was attempted too soon after the previous one.",
  InvalidAmount: "The amount was invalid.",
  AmountExceedsChargeLimit: "The amount exceeds the maximum allowed per charge.",
  AmountExceedsPeriodLimit: "The amount would exceed the maximum allowed for this billing period.",
  ChargeCountExceeded: "This automatic payment has reached its maximum number of charges.",
  DuplicateCharge: "This charge was already processed.",
  UnauthorizedMerchant: "Only the merchant on this automatic payment can request a charge.",
  InsufficientAllowance: "Your approved spending limit is too low for this charge.",
  InsufficientBalance: "Your account balance is too low for this charge.",
  PaymentNotFound: "We could not find that payment.",
  RefundExceedsPayment: "The refund would exceed the original payment amount.",
  DuplicateRefund: "This refund was already processed.",
  ArithmeticOverflow: "The amount is too large to process.",
  InvalidMandateInput: "One of the automatic payment's terms was invalid.",
  DuplicateMandate: "An automatic payment with these exact terms already exists.",
  InvalidStateTransition: "This action is not allowed in the automatic payment's current state.",
  RefundNotFound: "We could not find that refund.",
};

function fromContractError(error: MandateContractError): DisplayError {
  return {
    message: CONTRACT_ERROR_COPY[error.info.name] ?? `The Stellar network rejected this request (${error.info.name}).`,
    code: error.info.name,
    retryable: error.info.retryable,
  };
}

/** Converts any error thrown during the checkout flow (wallet, RPC/contract simulation, or our own API) into a {@link DisplayError} — the UI should never render a raw `Error.message` or a generic fallback string. */
export function toDisplayError(error: unknown): DisplayError {
  if (error instanceof MandateContractError) {
    return fromContractError(error);
  }
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code, retryable: false };
  }
  if (error instanceof Error) {
    // Wallet rejection is the one common case with a recognizable shape
    // across Freighter/xBull/etc. ("User declined access"/"rejected") —
    // detected by message content since the wallet kit doesn't expose a
    // typed error class for it.
    if (/reject|declin|cancel/i.test(error.message)) {
      return { message: "You declined the request in your wallet.", code: "WALLET_REJECTED", retryable: true };
    }
    if (/network|fetch|timeout|rpc/i.test(error.message)) {
      return { message: "We could not reach the Stellar network. Check your connection and try again.", code: "NETWORK_ERROR", retryable: true };
    }
    // A contract Result::Err surfaces from simulation as a plain Error
    // whose message is the bare error name (the generated client's
    // `Result.unwrapErr()` shape) before it has been run through
    // `decodeMandateErrorName` by the caller — try that decode here as a
    // last resort so a raw contract rejection is never shown as-is.
    const decoded = decodeMandateErrorName(error.message);
    if (decoded.info.name !== `UnknownContractError(${error.message})`) {
      return fromContractError(decoded);
    }
    return { message: error.message, code: "UNKNOWN_ERROR", retryable: false };
  }
  return { message: "An unexpected error occurred.", code: "UNKNOWN_ERROR", retryable: false };
}
