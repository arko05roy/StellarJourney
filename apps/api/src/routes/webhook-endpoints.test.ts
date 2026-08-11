import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptWebhookSecret } from "@paymap/shared";
import { authHeader, buildTestApp, cleanDatabase, createTestMerchant, TEST_WEBHOOK_ENCRYPTION_KEY, type TestApp } from "../test/helpers.js";

describe("POST /v1/webhook-endpoints/test", () => {
  let testApp: TestApp;
  let apiKey: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    apiKey = (await createTestMerchant(testApp.prisma)).apiKey;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("queues a pending WebhookDelivery for a valid https URL", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints/test",
      headers: authHeader(apiKey),
      payload: { url: "https://example.com/webhooks" },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { status: string; eventId: string };
    expect(body.status).toBe("pending");

    const stored = await testApp.prisma.webhookDelivery.findUnique({ where: { eventId: body.eventId } });
    expect(stored?.status).toBe("pending");
    expect(stored?.eventType).toBe("webhook.test");
  });

  for (const url of ["ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "not-a-url"]) {
    it(`rejects a non-http(s) webhook URL: ${url}`, async () => {
      const response = await testApp.app.inject({
        method: "POST",
        url: "/v1/webhook-endpoints/test",
        headers: authHeader(apiKey),
        payload: { url },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("VALIDATION_ERROR");
    });
  }

  it("requires authentication", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints/test",
      payload: { url: "https://example.com/webhooks" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a URL that resolves to a private/loopback address (SSRF guard)", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints/test",
      headers: authHeader(apiKey),
      payload: { url: "https://127.0.0.1/hook" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("BLOCKED_HOST");
  });
});

describe("POST /v1/webhook-endpoints (register/rotate)", () => {
  let testApp: TestApp;
  let apiKey: string;
  let merchantId: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    const merchant = await createTestMerchant(testApp.prisma);
    apiKey = merchant.apiKey;
    merchantId = merchant.merchantId;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("registers a webhook endpoint, returns the raw secret once, and stores only the encrypted form", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: authHeader(apiKey),
      payload: { url: "https://merchant.example.com/webhooks/paymap" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { webhookUrl: string; webhookSecret: string };
    expect(body.webhookUrl).toBe("https://merchant.example.com/webhooks/paymap");
    expect(body.webhookSecret.startsWith("whsec_")).toBe(true);

    const stored = await testApp.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(stored.webhookUrl).toBe("https://merchant.example.com/webhooks/paymap");
    expect(stored.webhookSecret).not.toBeNull();
    expect(stored.webhookSecret).not.toContain(body.webhookSecret);
    // Round-trips back to the exact secret shown once above — proves it's
    // genuinely recoverable with the right key, not just "some ciphertext".
    expect(decryptWebhookSecret(stored.webhookSecret as string, TEST_WEBHOOK_ENCRYPTION_KEY)).toBe(body.webhookSecret);
  });

  it("rotating (calling again) issues a new secret and overwrites the old one", async () => {
    const first = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: authHeader(apiKey),
      payload: { url: "https://merchant.example.com/webhooks/v1" },
    });
    const firstSecret = (first.json() as { webhookSecret: string }).webhookSecret;

    const second = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: authHeader(apiKey),
      payload: { url: "https://merchant.example.com/webhooks/v2" },
    });
    expect(second.statusCode).toBe(201);
    const secondSecret = (second.json() as { webhookSecret: string }).webhookSecret;
    expect(secondSecret).not.toBe(firstSecret);

    const stored = await testApp.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(stored.webhookUrl).toBe("https://merchant.example.com/webhooks/v2");
    expect(decryptWebhookSecret(stored.webhookSecret as string, TEST_WEBHOOK_ENCRYPTION_KEY)).toBe(secondSecret);
  });

  it("rejects an unsafe URL without persisting anything", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: authHeader(apiKey),
      payload: { url: "http://10.0.0.5/hook" },
    });
    expect(response.statusCode).toBe(400);
    const stored = await testApp.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
    expect(stored.webhookUrl).toBeNull();
  });

  it("requires authentication", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      payload: { url: "https://merchant.example.com/webhooks" },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /v1/webhook-endpoints", () => {
  let testApp: TestApp;
  let apiKey: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    apiKey = (await createTestMerchant(testApp.prisma)).apiKey;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("reports unconfigured before registration, and never returns a secret", async () => {
    const before = await testApp.app.inject({ method: "GET", url: "/v1/webhook-endpoints", headers: authHeader(apiKey) });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as { configured: boolean };
    expect(beforeBody.configured).toBe(false);
    expect(JSON.stringify(before.json())).not.toContain("webhookSecret");

    await testApp.app.inject({
      method: "POST",
      url: "/v1/webhook-endpoints",
      headers: authHeader(apiKey),
      payload: { url: "https://merchant.example.com/webhooks" },
    });

    const after = await testApp.app.inject({ method: "GET", url: "/v1/webhook-endpoints", headers: authHeader(apiKey) });
    const afterBody = after.json() as { configured: boolean; webhookUrl: string };
    expect(afterBody.configured).toBe(true);
    expect(afterBody.webhookUrl).toBe("https://merchant.example.com/webhooks");
    expect(JSON.stringify(after.json())).not.toContain("whsec_");
  });
});

describe("GET /v1/webhook-deliveries", () => {
  let testApp: TestApp;
  let apiKey: string;
  let merchantId: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    const merchant = await createTestMerchant(testApp.prisma);
    apiKey = merchant.apiKey;
    merchantId = merchant.merchantId;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("requires authentication", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/webhook-deliveries" });
    expect(response.statusCode).toBe(401);
  });

  it("lists this merchant's deliveries with status/attempt counts, never the payload or a secret", async () => {
    await testApp.prisma.webhookDelivery.create({
      data: { merchantId, eventId: "evt_1", eventType: "payment.succeeded", payload: { paymentId: "abc" }, status: "delivered", attemptCount: 1 },
    });
    await testApp.prisma.webhookDelivery.create({
      data: { merchantId, eventId: "evt_2", eventType: "payment.failed", payload: { paymentId: "def" }, status: "retry_scheduled", attemptCount: 2 },
    });

    const response = await testApp.app.inject({ method: "GET", url: "/v1/webhook-deliveries", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { eventId: string; status: string; attemptCount: number }[] };
    expect(body.data).toHaveLength(2);
    expect(body.data.map((d) => d.eventId)).toEqual(["evt_2", "evt_1"]);
    expect(JSON.stringify(body)).not.toContain("abc");
    expect(JSON.stringify(body)).not.toContain("whsec_");
  });

  it("filters by a comma-separated status list", async () => {
    await testApp.prisma.webhookDelivery.create({
      data: { merchantId, eventId: "evt_a", eventType: "payment.succeeded", payload: {}, status: "delivered" },
    });
    await testApp.prisma.webhookDelivery.create({
      data: { merchantId, eventId: "evt_b", eventType: "payment.failed", payload: {}, status: "dead_letter" },
    });

    const response = await testApp.app.inject({ method: "GET", url: "/v1/webhook-deliveries?status=dead_letter", headers: authHeader(apiKey) });
    const body = response.json() as { data: { eventId: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.eventId).toBe("evt_b");
  });

  it("rejects an unknown status value", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/webhook-deliveries?status=bogus", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_STATUS_FILTER");
  });

  it("never returns another merchant's deliveries", async () => {
    const other = await createTestMerchant(testApp.prisma);
    await testApp.prisma.webhookDelivery.create({
      data: { merchantId: other.merchantId, eventId: "evt_other", eventType: "payment.succeeded", payload: {}, status: "delivered" },
    });
    const response = await testApp.app.inject({ method: "GET", url: "/v1/webhook-deliveries", headers: authHeader(apiKey) });
    expect((response.json() as { data: unknown[] }).data).toHaveLength(0);
  });
});
