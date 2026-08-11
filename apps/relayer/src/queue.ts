/**
 * BullMQ queue wiring (decision #1: deterministic job id = `chargeRequest.id`
 * so duplicate enqueues collapse into the same job instead of creating
 * parallel work). This is a *complement* to the pipeline's own DB-level
 * claim guard, never a substitute for it — see `pipeline.ts`'s module doc.
 */
import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";

export const CHARGE_QUEUE_NAME = "charge-requests";

export interface ChargeJobData {
  chargeRequestId: string;
}

/** BullMQ requires `maxRetriesPerRequest: null` on its own Redis connection (blocking commands otherwise time out). */
export function createRedisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

export function createChargeQueue(connection: ConnectionOptions): Queue<ChargeJobData> {
  return new Queue<ChargeJobData>(CHARGE_QUEUE_NAME, { connection });
}

/** Enqueues (or no-ops if already enqueued — same deterministic id) one `ChargeRequest` for processing. */
export async function enqueueChargeRequest(queue: Queue<ChargeJobData>, chargeRequestId: string): Promise<void> {
  await queue.add(
    "charge",
    { chargeRequestId },
    { jobId: chargeRequestId, removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 } },
  );
}
