/**
 * BullMQ worker wiring around `webhook-delivery.ts::processWebhookDelivery`
 * — mirrors `worker.ts` exactly, including the same "BullMQ's locking is a
 * first line of defense, not the actual correctness guarantee" note (the
 * DB-guarded `pending|retry_scheduled -> delivering` transition is what
 * makes duplicate delivery safe).
 */
import { Worker, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "./db.js";
import type { HostResolver } from "@paymap/shared";
import { processWebhookDelivery, type WebhookLogger } from "./webhook-delivery.js";
import { WEBHOOK_DELIVERY_QUEUE_NAME, type WebhookDeliveryJobData } from "./webhook-queue.js";
import type { sendWebhook } from "./webhook-http.js";

export interface CreateWebhookDeliveryWorkerOptions {
  connection: ConnectionOptions;
  prisma: PrismaClient;
  webhookEncryptionKey: string;
  allowInsecureWebhookHttp?: boolean;
  resolveWebhookHost?: HostResolver;
  now?: () => Date;
  logger?: WebhookLogger;
  concurrency?: number;
  send?: typeof sendWebhook;
}

export function createWebhookDeliveryWorker(options: CreateWebhookDeliveryWorkerOptions): Worker<WebhookDeliveryJobData> {
  return new Worker<WebhookDeliveryJobData>(
    WEBHOOK_DELIVERY_QUEUE_NAME,
    async (job) => {
      await processWebhookDelivery(
        {
          prisma: options.prisma,
          now: options.now ?? (() => new Date()),
          webhookEncryptionKey: options.webhookEncryptionKey,
          allowInsecureWebhookHttp: options.allowInsecureWebhookHttp ?? false,
          ...(options.resolveWebhookHost ? { resolveWebhookHost: options.resolveWebhookHost } : {}),
          ...(options.logger ? { logger: options.logger } : {}),
          ...(options.send ? { send: options.send } : {}),
        },
        job.data.webhookDeliveryId,
      );
    },
    { connection: options.connection, concurrency: options.concurrency ?? 10 },
  );
}
