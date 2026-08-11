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
