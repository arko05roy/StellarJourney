/**
 * `WebhookDelivery` state machine guard (CLAUDE.md §17), mirroring
 * `state-machine.ts::CHARGE_REQUEST_LEGAL_TRANSITIONS`/`transitionChargeRequest`
 * exactly — same guarded-`updateMany` atomicity, same "co-locate the table
 * with the model that owns the enum, let the consuming app (`apps/relayer`)
 * deep-import it" convention `pipeline.ts` already established for
 * `transitionChargeRequest`/`ApiError`.
 *
 * Legal edges (CLAUDE.md §17 exactly, plus the one addition this phase
 * makes — `retry_scheduled -> delivering`, the delivery worker's retry
 * re-entry, mirroring `retryable_failed -> processing` on the charge side):
 *
 *   pending         -> delivering
 *   delivering      -> delivered | retry_scheduled | dead_letter
 *   retry_scheduled -> delivering   (Phase 12a: scheduler-driven retry)
 *
 * `delivered` and `dead_letter` are terminal.
 */
import { ApiError } from "./errors.js";
import type { WebhookDeliveryStatus } from "./db.js";
import type { Prisma, PrismaClient } from "./db.js";

type Status = WebhookDeliveryStatus;

export const WEBHOOK_DELIVERY_LEGAL_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  pending: ["delivering"],
  delivering: ["delivered", "retry_scheduled", "dead_letter"],
  retry_scheduled: ["delivering"],
  delivered: [],
  dead_letter: [],
};

export const ALL_WEBHOOK_DELIVERY_STATUSES: readonly Status[] = Object.keys(WEBHOOK_DELIVERY_LEGAL_TRANSITIONS) as Status[];

/** Throws a 409 `InvalidStateTransition` `ApiError` if `to` is not a legal successor of `from`. Pure — does not touch the database. */
export function assertLegalWebhookDeliveryTransition(from: Status, to: Status): void {
  const allowed = WEBHOOK_DELIVERY_LEGAL_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new ApiError(409, "InvalidStateTransition", `Illegal WebhookDelivery transition: "${from}" -> "${to}".`);
  }
}

/**
 * Atomically transitions a `WebhookDelivery` row: validates the edge is
 * legal, then performs a guarded `updateMany` scoped to the expected
 * current status so two concurrent callers (e.g. two BullMQ workers that
 * somehow both picked up the same delivery job) can never both apply the
 * same transition — the loser's `updateMany` matches zero rows once the
 * winner's has committed, which is the entire "duplicate delivery -> at
 * most one POST" guarantee (mirrors `transitionChargeRequest`'s identical
 * role for `ChargeRequest`).
 */
export async function transitionWebhookDelivery(
  client: PrismaClient | Prisma.TransactionClient,
  id: string,
  from: Status,
  to: Status,
  data: Record<string, unknown> = {},
): Promise<void> {
  assertLegalWebhookDeliveryTransition(from, to);
  const result = await client.webhookDelivery.updateMany({
    where: { id, status: from },
    data: { status: to, ...data },
  });
  if (result.count !== 1) {
    throw new ApiError(409, "InvalidStateTransition", `WebhookDelivery ${id} is not currently "${from}" — cannot transition to "${to}".`);
  }
}
