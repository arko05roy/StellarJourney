import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeRequestHash, runIdempotent } from "./middleware.js";
import { cleanDatabase, createTestPrisma, createTestMerchant, randomHexId32 } from "../test/helpers.js";
import type { PrismaClient } from "../db.js";

describe("runIdempotent", () => {
  let prisma: PrismaClient;
  let merchantId: string;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
    merchantId = (await createTestMerchant(prisma)).merchantId;
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("computeRequestHash is stable for the same body and differs for a different body", () => {
    expect(computeRequestHash({ a: 1 })).toBe(computeRequestHash({ a: 1 }));
    expect(computeRequestHash({ a: 1 })).not.toBe(computeRequestHash({ a: 2 }));
  });

  it("runs the handler exactly once for a fresh key and returns its result", async () => {
    const key = "idem-1";
    const body = { amount: "10" };
    const hash = computeRequestHash(body);
    let executions = 0;

    const outcome = await runIdempotent(prisma, merchantId, key, hash, async (tx) => {
      executions += 1;
      await tx.chargeRequest.create({
        data: {
          merchantId,
          mandateId: randomHexId32(),
          chargeId: randomHexId32(),
          amount: "1000000",
          invoiceHash: randomHexId32(),
          scheduledFor: new Date(),
        },
      });
      return { status: 201, body: { ok: true } };
    });

    expect(executions).toBe(1);
    expect(outcome).toEqual({ replayed: false, status: 201, body: { ok: true } });
  });

  it("replays the stored response for the same key + same body, without re-executing the handler", async () => {
    const key = "idem-2";
    const body = { amount: "10" };
    const hash = computeRequestHash(body);
    let executions = 0;

    const handler = async (tx: Parameters<Parameters<typeof runIdempotent>[4]>[0]) => {
      executions += 1;
      await tx.chargeRequest.create({
        data: {
          merchantId,
          mandateId: randomHexId32(),
          chargeId: randomHexId32(),
          amount: "1000000",
          invoiceHash: randomHexId32(),
          scheduledFor: new Date(),
        },
      });
      return { status: 201, body: { ok: true, n: executions } };
    };

    const first = await runIdempotent(prisma, merchantId, key, hash, handler);
    const second = await runIdempotent(prisma, merchantId, key, hash, handler);

    expect(executions).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);

    const chargeRequestCount = await prisma.chargeRequest.count({ where: { merchantId } });
    expect(chargeRequestCount).toBe(1);
  });

  it("rejects the same key reused with a different request body (409), without executing the handler", async () => {
    const key = "idem-3";
    let executions = 0;
    const handler = async () => {
      executions += 1;
      return { status: 201, body: { ok: true } };
    };

    await runIdempotent(prisma, merchantId, key, computeRequestHash({ amount: "10" }), handler);
    await expect(runIdempotent(prisma, merchantId, key, computeRequestHash({ amount: "20" }), handler)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    expect(executions).toBe(1);
  });

  it("the same key is independent per merchant", async () => {
    const otherMerchantId = (await createTestMerchant(prisma)).merchantId;
    const key = "idem-shared-key";
    let executions = 0;
    const handler = async () => {
      executions += 1;
      return { status: 201, body: { n: executions } };
    };

    const a = await runIdempotent(prisma, merchantId, key, computeRequestHash({ x: 1 }), handler);
    const b = await runIdempotent(prisma, otherMerchantId, key, computeRequestHash({ x: 1 }), handler);

    expect(executions).toBe(2);
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it("concurrent duplicate requests (same key, same body) produce exactly one execution and identical responses", async () => {
    const key = "idem-concurrent";
    const body = { amount: "10" };
    const hash = computeRequestHash(body);
    let executions = 0;

    const handler = async (tx: Parameters<Parameters<typeof runIdempotent>[4]>[0]) => {
      executions += 1;
      await tx.chargeRequest.create({
        data: {
          merchantId,
          mandateId: randomHexId32(),
          chargeId: randomHexId32(),
          amount: "1000000",
          invoiceHash: randomHexId32(),
          scheduledFor: new Date(),
        },
      });
      return { status: 201, body: { ok: true } };
    };

    const results = await Promise.all(Array.from({ length: 8 }, () => runIdempotent(prisma, merchantId, key, hash, handler)));

    expect(executions).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(7);
    for (const result of results) {
      expect(result.status).toBe(201);
      expect(result.body).toEqual({ ok: true });
    }

    const chargeRequestCount = await prisma.chargeRequest.count({ where: { merchantId } });
    expect(chargeRequestCount).toBe(1);
  });
});
