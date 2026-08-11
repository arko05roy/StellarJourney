/**
 * BullMQ worker wiring around `pipeline.ts::processChargeRequest`. BullMQ's
 * own lock/stalled-job handling is a reasonable *first* line of defense
 * against double-processing, but this system does not rely on it — the
 * pipeline's DB-guarded `scheduled|retryable_failed -> processing`
 * transition is the actual at-most-one-success guarantee, which is why the
 * required test drives two concurrent calls to `processChargeRequest`
 * directly (simulating two workers that somehow both picked up the same
 * job) rather than only trusting BullMQ's de-duplication.
 */
import { Worker, type ConnectionOptions } from "bullmq";
import type { PrismaClient } from "./db.js";
import type { ChainGateway } from "./chain-gateway.js";
import { processChargeRequest, type Logger } from "./pipeline.js";
import { CHARGE_QUEUE_NAME, type ChargeJobData } from "./queue.js";
import type { Observability } from "./observability.js";

export interface CreateChargeWorkerOptions {
  connection: ConnectionOptions;
  prisma: PrismaClient;
  gateway: ChainGateway;
  now?: () => Date;
  logger?: Logger;
  observability?: Observability;
  authorizationEncryptionKey?: string;
  concurrency?: number;
}

export function createChargeWorker(options: CreateChargeWorkerOptions): Worker<ChargeJobData> {
  return new Worker<ChargeJobData>(
    CHARGE_QUEUE_NAME,
    async (job) => {
      await processChargeRequest(
        {
          prisma: options.prisma,
          gateway: options.gateway,
          now: options.now ?? (() => new Date()),
          ...(options.logger ? { logger: options.logger } : {}),
          ...(options.observability ? { observability: options.observability } : {}),
          ...(options.authorizationEncryptionKey
            ? { authorizationEncryptionKey: options.authorizationEncryptionKey }
            : {}),
        },
        job.data.chargeRequestId,
      );
    },
    { connection: options.connection, concurrency: options.concurrency ?? 5 },
  );
}
