/**
 * Contract error code (u32) -> typed TS error, mirroring the frozen 1-24
 * table in `contracts/mandate-registry/src/error.rs` exactly (CLAUDE.md §8).
 * `packages/stellar/src/errors.test.ts` parses that Rust file directly and
 * asserts this table never drifts from it — a silently-wrong ABI map here
 * would misclassify real merchant/relayer failures in production.
 *
 * `retryable` follows CLAUDE.md §11's relayer retry policy:
 *   - permanent (never auto-retry): revoked, expired, duplicate charge/refund,
 *     over per-charge/per-period limit, too-soon, max-charge-count reached,
 *     and every other deterministic policy/programming failure — retrying
 *     the identical request against the identical on-chain state can never
 *     produce a different outcome.
 *   - transient, *subject to merchant retry policy*: insufficient allowance
 *     / balance — these can resolve if the payer tops up before the retry
 *     window closes, so the relayer is permitted (not required) to retry
 *     them. RPC/timeout/not-yet-included failures are transient too, but
 *     those never surface as a contract error code at all (they are
 *     network/infrastructure failures classified separately by the relayer,
 *     Phase 9) — this table only covers on-chain `Result::Err` outcomes.
 */

/** One row of the frozen error ABI. */
export interface MandateErrorInfo {
  readonly code: number;
  readonly name: string;
  readonly retryable: boolean;
}

/** Frozen 1-24 table (`contracts/mandate-registry/src/error.rs`). Append-only above 24. */
const MANDATE_ERROR_TABLE: readonly MandateErrorInfo[] = [
  { code: 1, name: "MandateNotFound", retryable: false },
  { code: 2, name: "MandateNotActive", retryable: false },
  { code: 3, name: "MandatePaused", retryable: false },
  { code: 4, name: "MandateRevoked", retryable: false },
  { code: 5, name: "MandateCompleted", retryable: false },
  { code: 6, name: "MandateExpired", retryable: false },
  { code: 7, name: "ChargeBeforeStart", retryable: false },
  { code: 8, name: "ChargeTooSoon", retryable: false },
  { code: 9, name: "InvalidAmount", retryable: false },
  { code: 10, name: "AmountExceedsChargeLimit", retryable: false },
  { code: 11, name: "AmountExceedsPeriodLimit", retryable: false },
  { code: 12, name: "ChargeCountExceeded", retryable: false },
  { code: 13, name: "DuplicateCharge", retryable: false },
  { code: 14, name: "UnauthorizedMerchant", retryable: false },
  // Transient, per merchant retry policy (CLAUDE.md §11) — the payer may top
  // up before the next attempt.
  { code: 15, name: "InsufficientAllowance", retryable: true },
  { code: 16, name: "InsufficientBalance", retryable: true },
  { code: 17, name: "PaymentNotFound", retryable: false },
  { code: 18, name: "RefundExceedsPayment", retryable: false },
  { code: 19, name: "DuplicateRefund", retryable: false },
  { code: 20, name: "ArithmeticOverflow", retryable: false },
  { code: 21, name: "InvalidMandateInput", retryable: false },
  { code: 22, name: "DuplicateMandate", retryable: false },
  { code: 23, name: "InvalidStateTransition", retryable: false },
  { code: 24, name: "RefundNotFound", retryable: false },
];

const BY_CODE: ReadonlyMap<number, MandateErrorInfo> = new Map(
  MANDATE_ERROR_TABLE.map((entry) => [entry.code, entry]),
);
const BY_NAME: ReadonlyMap<string, MandateErrorInfo> = new Map(
  MANDATE_ERROR_TABLE.map((entry) => [entry.name, entry]),
);

/** Fallback for a code/name this table doesn't recognize (e.g. a contract redeployed with new variants this client hasn't been updated for). Never retryable by default — safest assumption for an unrecognized failure. */
function unknown(identity: number | string): MandateErrorInfo {
  return { code: typeof identity === "number" ? identity : -1, name: `UnknownContractError(${String(identity)})`, retryable: false };
}

/** Thrown/returned by the decoders below. `.info` carries the stable code/name/retryable triple. */
export class MandateContractError extends Error {
  readonly info: MandateErrorInfo;

  constructor(info: MandateErrorInfo) {
    super(`mandate-registry contract error ${String(info.code)}: ${info.name}`);
    this.name = "MandateContractError";
    this.info = info;
  }

  get code(): number {
    return this.info.code;
  }

  get retryable(): boolean {
    return this.info.retryable;
  }
}

/** Decodes a raw contract error code (u32) into a typed error. Total — never throws, falls back to an unrecognized-but-safe entry for an out-of-table code. */
export function decodeMandateErrorCode(code: number): MandateContractError {
  return new MandateContractError(BY_CODE.get(code) ?? unknown(code));
}

/** Decodes the `{message}` shape the generated client's `Result.unwrapErr()` returns (the SDK only carries the error *name*, not the numeric code, once it has been through `Result` conversion) back to the same typed error via the frozen name table. */
export function decodeMandateErrorName(name: string): MandateContractError {
  return new MandateContractError(BY_NAME.get(name) ?? unknown(name));
}

/** Convenience for the common `Result<T>`-shaped case: `result.unwrapErr()` is `{ message: string }`. */
export function decodeMandateErrorFromResult(unwrappedErr: { message: string }): MandateContractError {
  return decodeMandateErrorName(unwrappedErr.message);
}

/** Exposed for the drift-detection test only — do not use as public API. */
export const _MANDATE_ERROR_TABLE_FOR_TEST: readonly MandateErrorInfo[] = MANDATE_ERROR_TABLE;
