import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeader, buildTestApp, cleanDatabase, createTestMerchant, type TestApp } from "../test/helpers.js";

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
});
