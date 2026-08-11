import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeader, buildTestApp, cleanDatabase, createTestMerchant, randomStellarContractAddress, type TestApp } from "../test/helpers.js";

async function createProduct(app: TestApp["app"], apiKey: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/products",
    headers: authHeader(apiKey),
    payload: {
      name: "Pro Plan",
      assetAddress: randomStellarContractAddress(),
      assetDecimals: 7,
      amountType: "fixed",
      fixedAmount: "15.00",
      maxPerPeriod: "15.00",
      periodSeconds: 2_592_000,
      minIntervalSeconds: 0,
      maxSuccessfulCharges: 0,
      defaultDurationSeconds: 31_536_000,
    },
  });
  return (response.json() as { id: string }).id;
}

describe("POST /v1/checkout-sessions", () => {
  let testApp: TestApp;
  let apiKey: string;
  let productId: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    apiKey = (await createTestMerchant(testApp.prisma)).apiKey;
    productId = await createProduct(testApp.app, apiKey);
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("requires an Idempotency-Key header", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: authHeader(apiKey),
      payload: { productId },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("creates a session defaulting expiresAt from the product's defaultDurationSeconds", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: { ...authHeader(apiKey), "idempotency-key": "cs-1" },
      payload: { productId },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; status: string; expiresAt: string };
    expect(body.status).toBe("pending");
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(testApp.now.getTime());

    const fetched = await testApp.app.inject({ method: "GET", url: `/v1/checkout-sessions/${body.id}`, headers: authHeader(apiKey) });
    expect(fetched.statusCode).toBe(200);
  });

  it("404s for an unknown product", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: { ...authHeader(apiKey), "idempotency-key": "cs-2" },
      payload: { productId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("PRODUCT_NOT_FOUND");
  });

  it("replays the stored response for the same Idempotency-Key + same body", async () => {
    const headers = { ...authHeader(apiKey), "idempotency-key": "cs-3" };
    const first = await testApp.app.inject({ method: "POST", url: "/v1/checkout-sessions", headers, payload: { productId } });
    const second = await testApp.app.inject({ method: "POST", url: "/v1/checkout-sessions", headers, payload: { productId } });

    expect(first.json()).toEqual(second.json());
    expect(second.headers["idempotency-replayed"]).toBe("true");

    const count = await testApp.prisma.checkoutSession.count();
    expect(count).toBe(1);
  });

  it("rejects the same Idempotency-Key reused with a different body", async () => {
    const key = "cs-4";
    await testApp.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: { ...authHeader(apiKey), "idempotency-key": key },
      payload: { productId },
    });
    const conflict = await testApp.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: { ...authHeader(apiKey), "idempotency-key": key },
      payload: { productId, clientReference: "different-body" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("concurrent identical requests produce exactly one checkout session", async () => {
    const headers = { ...authHeader(apiKey), "idempotency-key": "cs-concurrent" };
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => testApp.app.inject({ method: "POST", url: "/v1/checkout-sessions", headers, payload: { productId } })),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(201);
    }
    const count = await testApp.prisma.checkoutSession.count();
    expect(count).toBe(1);
  });
});
