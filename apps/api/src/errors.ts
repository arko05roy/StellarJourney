/**
 * Stable, machine-readable API errors (CLAUDE.md §8). Every deterministic
 * failure — validation, auth, idempotency conflicts, and every contract
 * error — carries a stable `code` string; only a genuinely unexpected bug
 * falls back to `INTERNAL_ERROR`.
 */
import type { MandateContractError } from "@paymap/stellar";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly details: unknown;

  constructor(httpStatus: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

export const badRequest = (code: string, message: string, details?: unknown): ApiError => new ApiError(400, code, message, details);
export const unauthorizedError = (code: string, message: string): ApiError => new ApiError(401, code, message);
export const forbiddenError = (code: string, message: string): ApiError => new ApiError(403, code, message);
export const notFoundError = (code: string, message: string): ApiError => new ApiError(404, code, message);
export const conflictError = (code: string, message: string): ApiError => new ApiError(409, code, message);
export const unprocessableError = (code: string, message: string): ApiError => new ApiError(422, code, message);

/**
 * Frozen mandate-registry error name -> HTTP status. Every one of the 24
 * codes in `contracts/mandate-registry/src/error.rs` (mirrored in
 * `packages/stellar/src/errors.ts`) is listed explicitly — no fallback
 * bucket, so a newly-added contract error that this table hasn't been
 * updated for fails loudly (502) instead of silently mapping to 500.
 */
const CONTRACT_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  MandateNotFound: 404,
  MandateNotActive: 409,
  MandatePaused: 409,
  MandateRevoked: 409,
  MandateCompleted: 409,
  MandateExpired: 409,
  ChargeBeforeStart: 409,
  ChargeTooSoon: 409,
  InvalidAmount: 422,
  AmountExceedsChargeLimit: 422,
  AmountExceedsPeriodLimit: 422,
  ChargeCountExceeded: 409,
  DuplicateCharge: 409,
  UnauthorizedMerchant: 403,
  // Advisory/transient on-chain conditions (packages/stellar marks these
  // `retryable: true`) — 402 Payment Required communicates "this specific
  // attempt can't move funds right now" without implying the request itself
  // was invalid.
  InsufficientAllowance: 402,
  InsufficientBalance: 402,
  PaymentNotFound: 404,
  RefundExceedsPayment: 422,
  DuplicateRefund: 409,
  ArithmeticOverflow: 500,
  InvalidMandateInput: 400,
  DuplicateMandate: 409,
  InvalidStateTransition: 409,
  RefundNotFound: 404,
};

/**
 * Maps a decoded contract error to an `ApiError`, preserving the original
 * contract error *name* as the API `code` verbatim (CLAUDE.md §8 — "Backend
 * errors should map contract errors without losing the original code").
 */
export function mandateErrorToApiError(error: MandateContractError): ApiError {
  const httpStatus = CONTRACT_ERROR_HTTP_STATUS[error.info.name] ?? 502;
  return new ApiError(httpStatus, error.info.name, `Contract rejected the request: ${error.info.name}.`);
}
