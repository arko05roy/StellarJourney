/**
 * `ChargeRequest` (and, by reuse, `RefundRequest`) state machine guard
 * (CLAUDE.md §17). Phase 8 only ever writes `scheduled` — every other
 * transition is Phase 9's relayer — but the guard table and the atomic
 * transition helper ship now so an illegal transition is impossible to
 * write by construction, not just by convention.
 *
 * Legal edges, exactly as CLAUDE.md §17 draws them:
 *
 *   scheduled  -> processing
 *   processing -> simulated | retryable_failed | permanently_failed
 *   simulated  -> submitted
 *   submitted  -> succeeded | retryable_failed | permanently_failed
 *
 * `succeeded` is terminal (CLAUDE.md §17: "a succeeded charge is
 * terminal"). CLAUDE.md's diagram draws no outgoing edge from
 * `retryable_failed` either — Phase 9 owns whatever retry-scheduling
 * transition eventually re-enters `processing`; Phase 8 does not invent
 * one.
 */
import { ApiError } from "./errors.js";
import type { ChargeRequestStatus } from "./db.js";
import type { Prisma, PrismaClient } from "./db.js";

type Status = ChargeRequestStatus;

export const CHARGE_REQUEST_LEGAL_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  scheduled: ["processing"],
  processing: ["simulated", "retryable_failed", "permanently_failed"],
  simulated: ["submitted"],
  submitted: ["succeeded", "retryable_failed", "permanently_failed"],
  succeeded: [],
  retryable_failed: [],
  permanently_failed: [],
};

export const ALL_CHARGE_REQUEST_STATUSES: readonly Status[] = Object.keys(CHARGE_REQUEST_LEGAL_TRANSITIONS) as Status[];

/** Throws a 409 `InvalidStateTransition` `ApiError` if `to` is not a legal successor of `from`. Pure — does not touch the database. */
export function assertLegalChargeRequestTransition(from: Status, to: Status): void {
  const allowed = CHARGE_REQUEST_LEGAL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ApiError(409, "InvalidStateTransition", `Illegal ChargeRequest transition: "${from}" -> "${to}".`);
  }
}

/**
 * Atomically transitions a `ChargeRequest` row: validates the edge is legal,
 * then performs a guarded `updateMany` scoped to the expected current
 * status so two concurrent callers can never both apply the same
 * transition (the loser's `updateMany` matches zero rows once the winner's
 * has committed).
 */
export async function transitionChargeRequest(
  client: PrismaClient | Prisma.TransactionClient,
  id: string,
  from: Status,
  to: Status,
  data: Record<string, unknown> = {},
): Promise<void> {
  assertLegalChargeRequestTransition(from, to);
  const result = await client.chargeRequest.updateMany({
    where: { id, status: from },
    data: { status: to, ...data },
  });
  if (result.count !== 1) {
    throw new ApiError(409, "InvalidStateTransition", `ChargeRequest ${id} is not currently "${from}" — cannot transition to "${to}".`);
  }
}
