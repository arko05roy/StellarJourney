import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scheduleDueChargeRequests } from "./scheduler.js";
import { createChargeQueue, createRedisConnection } from "./queue.js";
import {
  cleanDatabase,
  createChargeRequest,
  createMerchantWithMandateContext,
  createTestPrisma,
} from "./test/helpers.js";
import type { PrismaClient } from "./db.js";
import type { Queue } from "bullmq";
import type IORedis from "ioredis";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("scheduleDueChargeRequests (real Postgres + real Redis)", () => {
  let prisma: PrismaClient;
  let connection: IORedis;
  let queue: Queue<{ chargeRequestId: string }>;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
    connection = createRedisConnection(REDIS_URL);
    queue = createChargeQueue(connection);
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterEach(async () => {
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
  });

  it("enqueues due `scheduled` rows and skips future-scheduled ones", async () => {
    const fixture = await createMerchantWithMandateContext(prisma);
    const due = await createChargeRequest(prisma, fixture, {
      scheduledFor: new Date(NOW.getTime() - 1000),
    });
    const future = await createChargeRequest(prisma, fixture, {
      scheduledFor: new Date(NOW.getTime() + 3_600_000),
    });

    const count = await scheduleDueChargeRequests(prisma, queue, NOW);

    expect(count).toBe(1);
    const jobDue = await queue.getJob(due.id);
    const jobFuture = await queue.getJob(future.id);
    expect(jobDue).toBeDefined();
    expect(jobFuture).toBeUndefined();
  });

  it("enqueues due `retryable_failed` rows past nextAttemptAt", async () => {
    const fixture = await createMerchantWithMandateContext(prisma);
    const dueRetry = await createChargeRequest(prisma, fixture, {
      status: "retryable_failed",
      nextAttemptAt: new Date(NOW.getTime() - 1000),
    });
    const notYet = await createChargeRequest(prisma, fixture, {
      status: "retryable_failed",
      nextAttemptAt: new Date(NOW.getTime() + 3_600_000),
    });

    const count = await scheduleDueChargeRequests(prisma, queue, NOW);

    expect(count).toBe(1);
    expect(await queue.getJob(dueRetry.id)).toBeDefined();
    expect(await queue.getJob(notYet.id)).toBeUndefined();
  });

  it("uses the deterministic job id (chargeRequest.id) — re-scheduling the same due row does not create a second job", async () => {
    const fixture = await createMerchantWithMandateContext(prisma);
    const due = await createChargeRequest(prisma, fixture, {
      scheduledFor: new Date(NOW.getTime() - 1000),
    });

    await scheduleDueChargeRequests(prisma, queue, NOW);
    await scheduleDueChargeRequests(prisma, queue, NOW);

    const counts = await queue.getJobCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
    expect((await queue.getJob(due.id))?.id).toBe(due.id);
    expect((await queue.getJob(due.id))?.opts.removeOnComplete).toBe(true);
  });

  it("recovers stale pre-submission work after a relayer interruption", async () => {
    const fixture = await createMerchantWithMandateContext(prisma);
    const stale = await createChargeRequest(prisma, fixture);
    await prisma.chargeRequest.update({
      where: { id: stale.id },
      data: {
        status: "processing",
        updatedAt: new Date(NOW.getTime() - 11 * 60_000),
      },
    });

    const count = await scheduleDueChargeRequests(prisma, queue, NOW);

    expect(count).toBe(1);
    expect(await queue.getJob(stale.id)).toBeDefined();
    expect(await prisma.chargeRequest.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject(
      {
        status: "retryable_failed",
        failureCode: "WORKER_INTERRUPTED",
        nextAttemptAt: NOW,
      },
    );
  });
});
