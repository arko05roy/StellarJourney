/**
 * BullMQ queue wiring for webhook deliveries — mirrors `queue.ts` exactly
 * (deterministic job id = `webhookDelivery.id`, so duplicate enqueues
 * collapse into the same job; the real at-most-one-POST guarantee is the
 * DB-level claim guard in `webhook-delivery.ts`, this is only a
 * complementary de-dup layer). A separate queue name/instance from
 * `charge-requests` — different job shape, different concurrency profile
 * (HTTP calls to arbitrary merchant servers, not Soroban RPC).
 */
import { Queue, type ConnectionOptions } from "bullmq";

export const WEBHOOK_DELIVERY_QUEUE_NAME = "webhook-deliveries";

export interface WebhookDeliveryJobData {
  webhookDeliveryId: string;
}

export function createWebhookDeliveryQueue(connection: ConnectionOptions): Queue<WebhookDeliveryJobData> {
  return new Queue<WebhookDeliveryJobData>(WEBHOOK_DELIVERY_QUEUE_NAME, { connection });
}

/** Enqueues (or no-ops if already enqueued — same deterministic id) one `WebhookDelivery` for processing. */
export async function enqueueWebhookDelivery(queue: Queue<WebhookDeliveryJobData>, webhookDeliveryId: string): Promise<void> {
  await queue.add(
    "deliver",
    { webhookDeliveryId },
    { jobId: webhookDeliveryId, removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 } },
  );
}
