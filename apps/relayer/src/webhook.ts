/**
 * Enqueues a `WebhookDelivery` row in `pending` (CLAUDE.md §11 step 10 /
 * §12). Phase 9 only guaranteed the row exists so nothing is lost; Phase
 * 12a's delivery worker (`webhook-delivery.ts`) is what actually signs and
 * POSTs it — see that module's doc for the envelope-assembly point (this
 * function stores only the event `data`, never a redundant copy of the
 * envelope wrapper).
 *
 * `WebhookEventType` is imported (not redeclared) from `@paymap/api`'s
 * schema — the canonical list of the 8 product events (+ `webhook.test`)
 * lives in exactly one place (CLAUDE.md §20).
 */
import { randomUUID } from "node:crypto";
import type { WebhookEventType } from "@paymap/api/dist/schemas/webhooks.js";
import type { Prisma, PrismaClient } from "./db.js";

export interface EnqueueChargeWebhookInput {
  merchantId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
}

export async function enqueueChargeWebhook(
  client: PrismaClient | Prisma.TransactionClient,
  input: EnqueueChargeWebhookInput,
): Promise<void> {
  await client.webhookDelivery.create({
    data: {
      merchantId: input.merchantId,
      eventId: randomUUID(),
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

export interface EnqueueDeterministicWebhookInput {
  merchantId: string;
  /** A stable id derived from the underlying event's own on-chain coordinates — never `randomUUID()` (see `indexer/mandate-index-sync.ts`'s `chain:<rpcEventId>` scheme). */
  eventId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
}

/**
 * Idempotent counterpart to {@link enqueueChargeWebhook}, for producers that
 * can derive a deterministic event id from the underlying event's own
 * coordinates (Phase 12c's on-chain indexer) rather than minting a fresh
 * random one every call. Uses `createMany({ skipDuplicates: true })` so a
 * duplicate `eventId` — the same on-chain event observed twice, e.g. by two
 * indexer instances processing overlapping ledger ranges, or the same
 * instance reprocessing after a restart — is a harmless no-op insert, never
 * a thrown unique-constraint error that would poison an enclosing
 * transaction (see `tasks/lessons.md`'s insert-or-read-existing note).
 */
export async function enqueueDeterministicWebhook(
  client: PrismaClient | Prisma.TransactionClient,
  input: EnqueueDeterministicWebhookInput,
): Promise<void> {
  await client.webhookDelivery.createMany({
    data: [{ merchantId: input.merchantId, eventId: input.eventId, eventType: input.eventType, payload: input.payload as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
}
