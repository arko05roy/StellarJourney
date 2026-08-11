/**
 * Enqueues a `WebhookDelivery` row in `pending` (CLAUDE.md §11 step 10 /
 * §12). Delivery itself (HMAC signing, HTTP send, retry/backoff) is Phase
 * 12 — this phase only guarantees the row exists so nothing is lost.
 */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "./db.js";

export type ChargeWebhookEventType = "payment.succeeded" | "payment.failed";

export interface EnqueueChargeWebhookInput {
  merchantId: string;
  eventType: ChargeWebhookEventType;
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
