import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scheduleDueWebhookDeliveries } from "./webhook-scheduler.js";
import { createWebhookDeliveryQueue } from "./webhook-queue.js";
import { createRedisConnection } from "./queue.js";
import { cleanDatabase, createMerchantWithWebhook, createTestPrisma } from "./test/helpers.js";
import type { PrismaClient } from "./db.js";
import type { Queue } from "bullmq";
import type IORedis from "ioredis";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("scheduleDueWebhookDeliveries (real Postgres + real Redis)", () => {
  let prisma: PrismaClient;
  let connection: IORedis;
  let queue: Queue<{ webhookDeliveryId: string }>;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
    connection = createRedisConnection(REDIS_URL);
    queue = createWebhookDeliveryQueue(connection);
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterEach(async () => {
    await queue.close();
    await connection.quit();
    await prisma.$disconnect();
  });

  it("enqueues every pending row (no due-time gate — pending is always due)", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const pending = await prisma.webhookDelivery.create({
      data: { merchantId: merchant.merchantId, eventId: "evt_1", eventType: "payment.succeeded", payload: {} },
    });

    const count = await scheduleDueWebhookDeliveries(prisma, queue, NOW);

    expect(count).toBe(1);
    expect(await queue.getJob(pending.id)).toBeDefined();
  });

  it("enqueues `retry_scheduled` rows past nextAttemptAt, skips ones not yet due", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const due = await prisma.webhookDelivery.create({
      data: {
        merchantId: merchant.merchantId,
        eventId: "evt_due",
        eventType: "payment.succeeded",
        payload: {},
        status: "retry_scheduled",
        nextAttemptAt: new Date(NOW.getTime() - 1000),
      },
    });
    const notYet = await prisma.webhookDelivery.create({
      data: {
        merchantId: merchant.merchantId,
        eventId: "evt_not_yet",
        eventType: "payment.succeeded",
        payload: {},
        status: "retry_scheduled",
        nextAttemptAt: new Date(NOW.getTime() + 3_600_000),
      },
    });

    const count = await scheduleDueWebhookDeliveries(prisma, queue, NOW);

    expect(count).toBe(1);
    expect(await queue.getJob(due.id)).toBeDefined();
    expect(await queue.getJob(notYet.id)).toBeUndefined();
  });

  it("skips delivered/dead_letter rows entirely", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    await prisma.webhookDelivery.create({
      data: { merchantId: merchant.merchantId, eventId: "evt_done", eventType: "payment.succeeded", payload: {}, status: "delivered" },
    });
    await prisma.webhookDelivery.create({
      data: { merchantId: merchant.merchantId, eventId: "evt_dead", eventType: "payment.succeeded", payload: {}, status: "dead_letter" },
    });

    const count = await scheduleDueWebhookDeliveries(prisma, queue, NOW);
    expect(count).toBe(0);
  });

  it("uses the deterministic job id (webhookDelivery.id) — re-scheduling the same due row does not create a second job", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const pending = await prisma.webhookDelivery.create({
      data: { merchantId: merchant.merchantId, eventId: "evt_1", eventType: "payment.succeeded", payload: {} },
    });

    await scheduleDueWebhookDeliveries(prisma, queue, NOW);
    await scheduleDueWebhookDeliveries(prisma, queue, NOW);

    const counts = await queue.getJobCounts();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
    expect((await queue.getJob(pending.id))?.id).toBe(pending.id);
  });
});
