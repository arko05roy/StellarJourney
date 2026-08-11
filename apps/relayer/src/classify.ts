/**
 * The relayer's single failure-classification table (CLAUDE.md §11, PLAN.md
 * §15): every failure the pipeline can observe maps to exactly one of
 * `"permanent"` (never auto-retry) or `"transient"` (retry per the schedule
 * in `retry-schedule.ts`).
 *
 * Two failure universes feed this table:
 *
 *   1. Decoded mandate-registry contract errors (all 24 frozen codes,
 *      `contracts/mandate-registry/src/error.rs`). This table does **not**
 *      re-derive permanent/transient per code — it consumes
 *      `packages/stellar`'s own `retryable` flag (the lead's decision #5:
 *      "don't re-derive it"), which itself is drift-tested against the Rust
 *      source in `packages/stellar/src/errors.test.ts`. This module's own
 *      job is narrower but load-bearing: assert every one of the 24 frozen
 *      codes is classifiable, and — the task's explicit requirement — fail
 *      loudly on any code that table doesn't recognize, rather than quietly
 *      defaulting an unmapped failure to a retry.
 *   2. Relayer/infra-observed conditions that never produce a contract error
 *      at all (RPC unavailable, submission timeout, transaction not
 *      included within the polling window). These are always transient —
 *      none of them is a policy verdict from the contract.
 */
import { decodeMandateErrorName, _MANDATE_ERROR_TABLE_FOR_TEST } from "@paymap/stellar";

export type FailureClass = "permanent" | "transient";

export interface ClassifiedFailure {
  readonly failureClass: FailureClass;
  /** Stable machine-readable reason: the contract error name, or one of `INFRA_TRANSIENT_REASONS`. */
  readonly reason: string;
}

/**
 * Relayer/infra-observed conditions (PLAN.md §15's "potentially recoverable
 * failures" that are not contract error codes at all):
 *   - RPC_UNAVAILABLE: the Soroban RPC endpoint could not be reached at all
 *     (simulation or `sendTransaction` request itself failed).
 *   - SEND_FAILED: `sendTransaction` returned a non-`PENDING` status (e.g. a
 *     bad sequence number, insufficient fee) — a submission-layer failure,
 *     not a contract rejection.
 *   - TX_NOT_INCLUDED: the transaction was broadcast but did not reach a
 *     final status within the polling window (`SentTransaction`'s
 *     `TransactionStillPending`).
 */
export const INFRA_TRANSIENT_REASONS = ["RPC_UNAVAILABLE", "SEND_FAILED", "TX_NOT_INCLUDED"] as const;
export type InfraTransientReason = (typeof INFRA_TRANSIENT_REASONS)[number];

export function classifyInfraFailure(reason: InfraTransientReason): ClassifiedFailure {
  return { failureClass: "transient", reason };
}

/** Thrown when a contract error name isn't one of the 24 frozen codes this classifier recognizes — a deliberate loud failure, never a silent default to "retry". */
export class UnclassifiableContractError extends Error {
  constructor(name: string) {
    super(`Unmapped contract error "${name}" — refusing to classify (would otherwise silently default to a retry).`);
    this.name = "UnclassifiableContractError";
  }
}

/**
 * Classifies a decoded contract error by name. Throws {@link UnclassifiableContractError}
 * for anything outside the frozen 24-code table (e.g. a redeployed contract
 * with a variant this relayer build doesn't know about) instead of ever
 * defaulting such a code to a retry.
 */
export function classifyContractErrorName(name: string): ClassifiedFailure {
  const decoded = decodeMandateErrorName(name);
  if (decoded.info.name.startsWith("UnknownContractError(")) {
    throw new UnclassifiableContractError(name);
  }
  return { failureClass: decoded.retryable ? "transient" : "permanent", reason: decoded.info.name };
}

/** Every frozen contract error name — used by the exhaustive classification test (one assertion per code) and by anything that needs to enumerate the full table. */
export const ALL_CONTRACT_ERROR_NAMES: readonly string[] = _MANDATE_ERROR_TABLE_FOR_TEST.map((entry) => entry.name);
