/**
 * Integration tests for `processWebhookDelivery` against a real Postgres
 * (`docker-compose.yml`). Most tests inject a fake `send` so no real HTTP
 * call happens — the pipeline logic (claim guard, classification-driven
 * transitions, secret decryption, envelope assembly) is what's under test.
 * A dedicated `describe` block near the bottom uses the *real* `sendWebhook`
 * against a real local `node:http` server — the gate's required "a sample
 * merchant app receives payment.succeeded" proof.
 */
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyWebhookSignature, WEBHOOK_SIGNATURE_HEADER } from "@paymap/shared";
import { processWebhookDelivery } from "./webhook-delivery.js";
import { sendWebhook } from "./webhook-http.js";
import { MAX_WEBHOOK_ATTEMPTS } from "./webhook-retry-schedule.js";
import { cleanDatabase, createMerchantWithWebhook, createTestPrisma, TEST_WEBHOOK_ENCRYPTION_KEY } from "./test/helpers.js";
import type { PrismaClient } from "./db.js";
import type { WebhookDeliveryOutcome } from "./webhook-classify.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

async function createPendingDelivery(prisma: PrismaClient, merchantId: string, overrides: { status?: "pending" | "retry_scheduled"; attemptCount?: number } = {}) {
  return prisma.webhookDelivery.create({
    data: {
      merchantId,
      eventId: `evt_${Math.random().toString(36).slice(2)}`,
      eventType: "payment.succeeded",
      payload: { chargeRequestId: "cr_1", paymentId: "pay_1" },
      ...(overrides.status ? { status: overrides.status } : {}),
      ...(overrides.attemptCount !== undefined ? { attemptCount: overrides.attemptCount } : {}),
    },
  });
}

describe("processWebhookDelivery (fake send — pipeline logic)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("delivers successfully: pending -> delivering -> delivered, exactly one send call", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const delivery = await createPendingDelivery(prisma, merchant.merchantId);

    let calls = 0;
    const fakeSend = async (): Promise<WebhookDeliveryOutcome> => {
      calls++;
      return { kind: "http", status: 200 };
    };

    const outcome = await processWebhookDelivery(
      { prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend },
      delivery.id,
    );

    expect(outcome).toEqual({ kind: "delivered" });
    expect(calls).toBe(1);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("delivered");
    expect(row.attemptCount).toBe(1);
  });

  it("a retryable outcome (5xx) schedules a retry at the documented delay", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const delivery = await createPendingDelivery(prisma, merchant.merchantId);

    const fakeSend = async (): Promise<WebhookDeliveryOutcome> => ({ kind: "http", status: 503 });

    const outcome = await processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend }, delivery.id);

    expect(outcome.kind).toBe("retry_scheduled");
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("retry_scheduled");
    expect(row.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000)); // attempt 1 -> +1m
  });

  it("a permanent outcome (4xx) dead-letters immediately, even on the first attempt", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const delivery = await createPendingDelivery(prisma, merchant.merchantId);

    const fakeSend = async (): Promise<WebhookDeliveryOutcome> => ({ kind: "http", status: 404 });

    const outcome = await processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend }, delivery.id);

    expect(outcome.kind).toBe("dead_letter");
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("dead_letter");
  });

  it("exhausting the retry schedule dead-letters instead of scheduling a 7th attempt", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const delivery = await createPendingDelivery(prisma, merchant.merchantId, { status: "retry_scheduled", attemptCount: MAX_WEBHOOK_ATTEMPTS - 1 });

    const fakeSend = async (): Promise<WebhookDeliveryOutcome> => ({ kind: "timeout" });
    const outcome = await processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend }, delivery.id);

    expect(outcome.kind).toBe("dead_letter");
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("dead_letter");
    expect(row.attemptCount).toBe(MAX_WEBHOOK_ATTEMPTS);
  });

  it("a merchant with no webhook endpoint configured dead-letters without ever calling send", async () => {
    const merchant = await prisma.merchant.create({ data: { name: "Unconfigured", walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWX234" } });
    const delivery = await createPendingDelivery(prisma, merchant.id);

    let calls = 0;
    const fakeSend = async (): Promise<WebhookDeliveryOutcome> => {
      calls++;
      return { kind: "http", status: 200 };
    };

    const outcome = await processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend }, delivery.id);

    expect(outcome).toEqual({ kind: "dead_letter", reason: "WEBHOOK_ENDPOINT_NOT_CONFIGURED" });
    expect(calls).toBe(0);
  });

  it("a wrong encryption key (decrypt failure) dead-letters without calling send", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const delivery = await createPendingDelivery(prisma, merchant.merchantId);

    let calls = 0;
    const fakeSend = async (): Promise<WebhookDeliveryOutcome> => {
      calls++;
      return { kind: "http", status: 200 };
    };

    const outcome = await processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: "a-totally-different-key", send: fakeSend }, delivery.id);

    expect(outcome).toEqual({ kind: "dead_letter", reason: "WEBHOOK_SECRET_DECRYPT_FAILED" });
    expect(calls).toBe(0);
  });

  it("duplicate delivery of the same job: two concurrent callers, exactly one send call, one wins the claim", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const delivery = await createPendingDelivery(prisma, merchant.merchantId);

    let calls = 0;
    const fakeSend = async (): Promise<WebhookDeliveryOutcome> => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { kind: "http", status: 200 };
    };

    const [a, b] = await Promise.all([
      processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend }, delivery.id),
      processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend }, delivery.id),
    ]);

    expect(calls).toBe(1);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["delivered", "skipped_not_claimable"]);
  });

  it("event id is stable across a retry attempt (same row re-delivered)", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const delivery = await createPendingDelivery(prisma, merchant.merchantId);

    const seenEventIds: string[] = [];
    const fakeSendFail = async (): Promise<WebhookDeliveryOutcome> => ({ kind: "http", status: 503 });
    await processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSendFail }, delivery.id);

    // Re-enter as the scheduler would once nextAttemptAt elapses.
    const later = new Date(NOW.getTime() + 61_000);
    const fakeSendCapture = async (args: Parameters<typeof sendWebhook>[0]): Promise<WebhookDeliveryOutcome> => {
      seenEventIds.push(args.eventId);
      return { kind: "http", status: 200 };
    };
    await processWebhookDelivery({ prisma, now: () => later, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSendCapture }, delivery.id);

    expect(seenEventIds).toEqual([delivery.eventId]);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.eventId).toBe(delivery.eventId);
    expect(row.status).toBe("delivered");
  });

  it("the signed payload never contains the merchant's API key or webhook secret", async () => {
    const merchant = await createMerchantWithWebhook(prisma, "https://merchant.example.com/hooks");
    const rawApiKey = "sk_live_super-secret-api-key-value";
    await prisma.apiKey.create({
      data: { merchantId: merchant.merchantId, keyPrefix: rawApiKey.slice(0, 16), keyHash: "irrelevant-hash-for-this-test" },
    });
    const delivery = await createPendingDelivery(prisma, merchant.merchantId);

    let capturedBody = "";
    const fakeSend = async (args: Parameters<typeof sendWebhook>[0]): Promise<WebhookDeliveryOutcome> => {
      capturedBody = args.rawBody;
      return { kind: "http", status: 200 };
    };

    await processWebhookDelivery({ prisma, now: () => NOW, webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY, send: fakeSend }, delivery.id);

    expect(capturedBody).not.toContain(rawApiKey);
    expect(capturedBody).not.toContain(merchant.rawSecret);
    expect(capturedBody).not.toContain(TEST_WEBHOOK_ENCRYPTION_KEY);
  });
});

describe("processWebhookDelivery + sendWebhook (real HTTP, no fake) — sample merchant app receives payment.succeeded", () => {
  let prisma: PrismaClient;
  let server: Server;
  let port: number;
  let received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
    received = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected a real server address");
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  });

  it("actually POSTs a signed payment.succeeded webhook to a real local receiver, which verifies it", async () => {
    const webhookUrl = `http://127.0.0.1:${String(port)}/webhooks/paymap`;
    const merchant = await createMerchantWithWebhook(prisma, webhookUrl);
    const delivery = await prisma.webhookDelivery.create({
      data: {
        merchantId: merchant.merchantId,
        eventId: "evt_sample_receiver_test",
        eventType: "payment.succeeded",
        payload: { chargeRequestId: "cr_demo", paymentId: "pay_demo", mandateId: "m_demo", chargeId: "c_demo", transactionHash: "tx_demo" },
      },
    });

    const outcome = await processWebhookDelivery(
      {
        prisma,
        now: () => NOW,
        webhookEncryptionKey: TEST_WEBHOOK_ENCRYPTION_KEY,
        // http:// + loopback are both disallowed by default (CLAUDE.md
        // §12's SSRF decision) — explicitly opted into here, and only
        // here, to run a real receiver in this sandboxed environment. See
        // `assertSafeWebhookUrl`'s doc for why this is safe to expose as a
        // narrow test-only flag.
        allowInsecureWebhookHttp: true,
        allowPrivateWebhookAddresses: true,
        send: sendWebhook,
      },
      delivery.id,
    );

    expect(outcome).toEqual({ kind: "delivered" });
    expect(received).toHaveLength(1);

    const [request] = received;
    if (!request) throw new Error("expected exactly one received request");
    const signatureHeader = request.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()];
    expect(typeof signatureHeader).toBe("string");

    // The receiver independently verifies the signature with the raw
    // secret it was given at registration time — this is the real,
    // end-to-end proof (not a mocked assertion) that a merchant app can
    // authenticate a delivered webhook.
    const verified = verifyWebhookSignature({ rawBody: request.body, header: signatureHeader as string, secret: merchant.rawSecret, now: NOW });
    expect(verified.eventId).toBe("evt_sample_receiver_test");

    const parsedBody = JSON.parse(request.body) as { eventType: string; data: { paymentId: string } };
    expect(parsedBody.eventType).toBe("payment.succeeded");
    expect(parsedBody.data.paymentId).toBe("pay_demo");

    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(row.status).toBe("delivered");
  });
});
