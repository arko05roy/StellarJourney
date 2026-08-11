/**
 * Finds due `ChargeRequest`s — `scheduled` rows whose `scheduledFor` has
 * arrived, or `retryable_failed` rows whose `nextAttemptAt` has arrived —
 * and enqueues them with the deterministic job id (`queue.ts`). Safe to run
 * on an interval and safe to run from multiple relayer processes at once:
 * BullMQ's own jobId de-duplication collapses repeat enqueues of the same
 * `ChargeRequest`, and even if two different jobs somehow ran for the same
 * request, the pipeline's DB-level claim guard still allows only one to
 * proceed.
 */
import type { Queue } from "bullmq";
import type { PrismaClient } from "./db.js";
import { enqueueChargeRequest, type ChargeJobData } from "./queue.js";

export async function scheduleDueChargeRequests(prisma: PrismaClient, queue: Queue<ChargeJobData>, now: Date): Promise<number> {
  const due = await prisma.chargeRequest.findMany({
    where: {
      OR: [
        { status: "scheduled", scheduledFor: { lte: now } },
        { status: "retryable_failed", nextAttemptAt: { lte: now } },
      ],
    },
    select: { id: true },
  });
  for (const row of due) {
    await enqueueChargeRequest(queue, row.id);
  }
  return due.length;
}

/** Starts a `setInterval`-driven scheduler loop; returns a function that stops it. */
export function startScheduler(prisma: PrismaClient, queue: Queue<ChargeJobData>, intervalMs = 30_000): () => void {
  const tick = (): void => {
    scheduleDueChargeRequests(prisma, queue, new Date()).catch((error: unknown) => {
      console.error("[relayer.scheduler] failed to schedule due charge requests:", error);
    });
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
