/**
 * Typed SDK errors (this phase's decision #9 — "typed error codes
 * surfacing the contract's frozen 1-24 codes without loss").
 *
 * `MandateContractErrorCode` is a *literal type-level mirror* of
 * `contracts/mandate-registry/src/error.rs`'s frozen 24-code table — not a
 * runtime dependency on `@paymap/stellar` (which would pull `@stellar/
 * stellar-sdk` and `@paymap/contract-client` into this otherwise-small
 * merchant SDK's install size for what is, at runtime, just a string).
 * `errors.test.ts` (a *devDependency*-only import of `@paymap/stellar`,
 * never shipped) asserts this list never drifts from the real table
 * (CLAUDE.md §20) — so there is exactly one authored copy of the 24 names,
 * even though there are two *type-level* mentions of it.
 */

export const MANDATE_CONTRACT_ERROR_CODES = [
  "MandateNotFound",
  "MandateNotActive",
  "MandatePaused",
  "MandateRevoked",
  "MandateCompleted",
  "MandateExpired",
  "ChargeBeforeStart",
  "ChargeTooSoon",
  "InvalidAmount",
  "AmountExceedsChargeLimit",
  "AmountExceedsPeriodLimit",
  "ChargeCountExceeded",
  "DuplicateCharge",
  "UnauthorizedMerchant",
  "InsufficientAllowance",
  "InsufficientBalance",
  "PaymentNotFound",
  "RefundExceedsPayment",
  "DuplicateRefund",
  "ArithmeticOverflow",
  "InvalidMandateInput",
  "DuplicateMandate",
  "InvalidStateTransition",
  "RefundNotFound",
] as const;

export type MandateContractErrorCode = (typeof MANDATE_CONTRACT_ERROR_CODES)[number];

/**
 * Thrown for every non-2xx API response. `code` preserves the API's own
 * stable code string verbatim — for a contract-originated failure, this is
 * exactly one of {@link MandateContractErrorCode} (CLAUDE.md §8: "backend
 * errors map contract errors without losing the original code"); for
 * everything else (validation, auth, idempotency conflicts, rate limits)
 * it's the API's own stable code (`"VALIDATION_ERROR"`,
 * `"MISSING_IDEMPOTENCY_KEY"`, `"IDEMPOTENCY_KEY_REUSED"`, `"RATE_LIMITED"`,
 * ...) — never silently collapsed to a generic message.
 */
export class StellarMandatesApiError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly details: unknown;

  constructor(httpStatus: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "StellarMandatesApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.details = details;
  }

  /** True when `code` is one of the 24 frozen mandate-contract error names (narrows `code` to {@link MandateContractErrorCode} for callers that check this first). */
  isContractError(): this is StellarMandatesApiError & { code: MandateContractErrorCode } {
    return (MANDATE_CONTRACT_ERROR_CODES as readonly string[]).includes(this.code);
  }
}

/** Thrown when the request itself couldn't complete (DNS/connect failure, timeout) — distinct from {@link StellarMandatesApiError}, which means a response *was* received. */
export class StellarMandatesNetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StellarMandatesNetworkError";
  }
}
