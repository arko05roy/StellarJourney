/**
 * Finds due `WebhookDelivery` rows — `pending` (never yet attempted) or
 * `retry_scheduled` past `nextAttemptAt` — and enqueues them. Mirrors
 * `scheduler.ts` exactly, including the "safe under multiple relayer
 * processes" reasoning (BullMQ jobId de-dup + the pipeline's own DB claim
 * guard).
 */
import type { Queue } from "bullmq";
import type { PrismaClient } from "./db.js";
import { enqueueWebhookDelivery, type WebhookDeliveryJobData } from "./webhook-queue.js";

export async function scheduleDueWebhookDeliveries(prisma: PrismaClient, queue: Queue<WebhookDeliveryJobData>, now: Date): Promise<number> {
  const due = await prisma.webhookDelivery.findMany({
    where: {
      OR: [{ status: "pending" }, { status: "retry_scheduled", nextAttemptAt: { lte: now } }],
    },
    select: { id: true },
  });
  for (const row of due) {
    await enqueueWebhookDelivery(queue, row.id);
  }
  return due.length;
}

/** Starts a `setInterval`-driven scheduler loop; returns a function that stops it. */
export function startWebhookScheduler(prisma: PrismaClient, queue: Queue<WebhookDeliveryJobData>, intervalMs = 10_000): () => void {
  const tick = (): void => {
    scheduleDueWebhookDeliveries(prisma, queue, new Date()).catch((error: unknown) => {
      console.error("[relayer.webhook-scheduler] failed to schedule due webhook deliveries:", error);
    });
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
