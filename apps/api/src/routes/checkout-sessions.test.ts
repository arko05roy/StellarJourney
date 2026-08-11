import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authHeader,
  buildMandate,
  buildTestApp,
  cleanDatabase,
  createTestMerchant,
  randomHexId32,
  randomStellarAccountAddress,
  randomStellarContractAddress,
  type TestApp,
} from "../test/helpers.js";

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

describe("GET /v1/checkout-sessions/:id/public", () => {
  let testApp: TestApp;
  let apiKey: string;
  let productId: string;
  let merchantWalletAddress: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    const merchant = await createTestMerchant(testApp.prisma);
    apiKey = merchant.apiKey;
    merchantWalletAddress = merchant.walletAddress;
    productId = await createProduct(testApp.app, apiKey);
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  async function createSession(): Promise<{ id: string; expiresAt: string }> {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: { ...authHeader(apiKey), "idempotency-key": `pub-${Date.now()}-${Math.random()}` },
      payload: { productId },
    });
    return response.json() as { id: string; expiresAt: string };
  }

  it("requires no authentication and exposes only display-safe merchant/product fields", async () => {
    const session = await createSession();
    const response = await testApp.app.inject({ method: "GET", url: `/v1/checkout-sessions/${session.id}/public` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      merchant: { name: string; walletAddress: string };
      product: { name: string; fixedAmount?: string; assetDecimals: number };
    };
    expect(body.status).toBe("pending");
    expect(body.merchant).toEqual({ name: "Test Merchant", walletAddress: merchantWalletAddress });
    expect(body.product.name).toBe("Pro Plan");
    expect(body.product.fixedAmount).toBe("15.0000000");
    // No merchant-secret shape (webhookUrl/webhookSecret/apiKeys) leaks through.
    expect(body.merchant).not.toHaveProperty("webhookSecret");
  });

  it("404s for an unknown session id", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/checkout-sessions/00000000-0000-0000-0000-000000000000/public" });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("CHECKOUT_SESSION_NOT_FOUND");
  });

  it("reports status as expired once past expiresAt, even before any sweep job runs", async () => {
    const session = await createSession();
    testApp.setNow(new Date(new Date(session.expiresAt).getTime() + 1000));
    const response = await testApp.app.inject({ method: "GET", url: `/v1/checkout-sessions/${session.id}/public` });
    expect(response.json().status).toBe("expired");
  });
});

describe("POST /v1/checkout-sessions/:id/mandate", () => {
  let testApp: TestApp;
  let apiKey: string;
  let productId: string;
  let merchantWalletAddress: string;
  let productAssetAddress: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    const merchant = await createTestMerchant(testApp.prisma);
    apiKey = merchant.apiKey;
    merchantWalletAddress = merchant.walletAddress;
    productAssetAddress = randomStellarContractAddress();
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: {
        name: "Pro Plan",
        assetAddress: productAssetAddress,
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
    productId = (response.json() as { id: string }).id;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  async function createSession(): Promise<string> {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/checkout-sessions",
      headers: { ...authHeader(apiKey), "idempotency-key": `link-${Date.now()}-${Math.random()}` },
      payload: { productId },
    });
    return (response.json() as { id: string }).id;
  }

  it("links a mandate that is independently verified on-chain", async () => {
    const sessionId = await createSession();
    const payerAddress = randomStellarAccountAddress();
    const mandateId = randomHexId32();
    testApp.mandateReader.setMandate(
      buildMandate({ id: mandateId, payer: payerAddress, merchant: merchantWalletAddress, asset: productAssetAddress }),
    );

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/checkout-sessions/${sessionId}/mandate`,
      payload: { mandateId, payerAddress },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; mandateId: string; payerAddress: string };
    expect(body.status).toBe("completed");
    expect(body.mandateId).toBe(mandateId);
    expect(body.payerAddress).toBe(payerAddress);
  });

  it("seeds MandateIndex with the payer address so the consumer dashboard can discover this mandate", async () => {
    const sessionId = await createSession();
    const payerAddress = randomStellarAccountAddress();
    const mandateId = randomHexId32();
    testApp.mandateReader.setMandate(
      buildMandate({ id: mandateId, payer: payerAddress, merchant: merchantWalletAddress, asset: productAssetAddress, status: "Active" }),
    );

    await testApp.app.inject({ method: "POST", url: `/v1/checkout-sessions/${sessionId}/mandate`, payload: { mandateId, payerAddress } });

    const cached = await testApp.prisma.mandateIndex.findUnique({ where: { mandateId } });
    expect(cached?.payerAddress).toBe(payerAddress);
    expect(cached?.status).toBe("Active");
  });

  it("is idempotent when replayed with the same mandateId", async () => {
    const sessionId = await createSession();
    const payerAddress = randomStellarAccountAddress();
    const mandateId = randomHexId32();
    testApp.mandateReader.setMandate(
      buildMandate({ id: mandateId, payer: payerAddress, merchant: merchantWalletAddress, asset: productAssetAddress }),
    );
    const payload = { mandateId, payerAddress };
    const first = await testApp.app.inject({ method: "POST", url: `/v1/checkout-sessions/${sessionId}/mandate`, payload });
    const second = await testApp.app.inject({ method: "POST", url: `/v1/checkout-sessions/${sessionId}/mandate`, payload });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
  });

  it("409s when the session is already linked to a different mandate", async () => {
    const sessionId = await createSession();
    const payerAddress = randomStellarAccountAddress();
    const firstMandateId = randomHexId32();
    testApp.mandateReader.setMandate(
      buildMandate({ id: firstMandateId, payer: payerAddress, merchant: merchantWalletAddress, asset: productAssetAddress }),
    );
    await testApp.app.inject({
      method: "POST",
      url: `/v1/checkout-sessions/${sessionId}/mandate`,
      payload: { mandateId: firstMandateId, payerAddress },
    });

    const secondMandateId = randomHexId32();
    testApp.mandateReader.setMandate(
      buildMandate({ id: secondMandateId, payer: payerAddress, merchant: merchantWalletAddress, asset: productAssetAddress }),
    );
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/checkout-sessions/${sessionId}/mandate`,
      payload: { mandateId: secondMandateId, payerAddress },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("CHECKOUT_SESSION_ALREADY_LINKED");
  });

  it("rejects a mandateId with no matching on-chain mandate", async () => {
    const sessionId = await createSession();
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/checkout-sessions/${sessionId}/mandate`,
      payload: { mandateId: randomHexId32(), payerAddress: randomStellarAccountAddress() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MandateNotFound");
  });

  it("rejects a mandate whose on-chain merchant does not match the session's merchant", async () => {
    const sessionId = await createSession();
    const payerAddress = randomStellarAccountAddress();
    const mandateId = randomHexId32();
    testApp.mandateReader.setMandate(
      buildMandate({ id: mandateId, payer: payerAddress, merchant: randomStellarAccountAddress(), asset: productAssetAddress }),
    );
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/checkout-sessions/${sessionId}/mandate`,
      payload: { mandateId, payerAddress },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MANDATE_MERCHANT_MISMATCH");
  });

  it("rejects a mandate whose on-chain payer does not match the supplied payerAddress", async () => {
    const sessionId = await createSession();
    const mandateId = randomHexId32();
    testApp.mandateReader.setMandate(
      buildMandate({ id: mandateId, payer: randomStellarAccountAddress(), merchant: merchantWalletAddress, asset: productAssetAddress }),
    );
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/checkout-sessions/${sessionId}/mandate`,
      payload: { mandateId, payerAddress: randomStellarAccountAddress() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MANDATE_PAYER_MISMATCH");
  });
});
