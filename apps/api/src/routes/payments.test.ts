import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authHeader,
  buildTestApp,
  cleanDatabase,
  createTestMerchant,
  randomHexId32,
  randomStellarContractAddress,
  type TestApp,
} from "../test/helpers.js";

const ASSET_DECIMALS = 7;

/** Payments are only ever written from a confirmed on-chain result (Phase 9's relayer, not built yet) — inserted directly here as a fixture standing in for that. */
async function createProductAndPaymentFixture(testApp: TestApp, apiKey: string, amount = "100.00") {
  const productResponse = await testApp.app.inject({
    method: "POST",
    url: "/v1/products",
    headers: authHeader(apiKey),
    payload: {
      name: "Pro Plan",
      assetAddress: randomStellarContractAddress(),
      assetDecimals: ASSET_DECIMALS,
      amountType: "fixed",
      fixedAmount: amount,
      maxPerPeriod: amount,
      periodSeconds: 2_592_000,
      minIntervalSeconds: 0,
      maxSuccessfulCharges: 0,
      defaultDurationSeconds: 31_536_000,
    },
  });
  const { id: productId } = productResponse.json() as { id: string };

  const sessionResponse = await testApp.app.inject({
    method: "POST",
    url: "/v1/checkout-sessions",
    headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
    payload: { productId },
  });
  const { id: sessionId } = sessionResponse.json() as { id: string };

  const mandateId = randomHexId32();
  await testApp.prisma.checkoutSession.update({ where: { id: sessionId }, data: { mandateId, status: "completed" } });

  const merchant = await testApp.prisma.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } });
  const paymentId = randomHexId32();
  const chargeId = randomHexId32();
  await testApp.prisma.payment.create({
    data: {
      paymentId,
      merchantId: merchant.merchantId,
      mandateId,
      chargeId,
      amount: "1000000000", // 100.0000000 at 7 decimals
      assetAddress: randomStellarContractAddress(),
      transactionHash: randomHexId32(),
      ledger: 12345n,
    },
  });

  return { paymentId, mandateId };
}

describe("GET /v1/payments", () => {
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

  it("lists this merchant's payments", async () => {
    await createProductAndPaymentFixture(testApp, apiKey);
    const response = await testApp.app.inject({ method: "GET", url: "/v1/payments", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("requires authentication", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/payments" });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /v1/payments/:id/refunds", () => {
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

  it("requires an Idempotency-Key header", async () => {
    const { paymentId } = await createProductAndPaymentFixture(testApp, apiKey);
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/payments/${paymentId}/refunds`,
      headers: authHeader(apiKey),
      payload: { amount: "10.00" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("404s for an unknown payment", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/payments/${randomHexId32()}/refunds`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "10.00" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("PaymentNotFound");
  });

  it("creates a scheduled full refund", async () => {
    const { paymentId } = await createProductAndPaymentFixture(testApp, apiKey, "100.00");
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/payments/${paymentId}/refunds`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "100.00" },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { status: string; amount: string };
    expect(body.status).toBe("scheduled");
    expect(body.amount).toBe("100.0000000");
  });

  it("rejects an amount exceeding the original payment with RefundExceedsPayment", async () => {
    const { paymentId } = await createProductAndPaymentFixture(testApp, apiKey, "100.00");
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/payments/${paymentId}/refunds`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "150.00" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("RefundExceedsPayment");
  });

  it("rejects two partial refunds that together would exceed the payment", async () => {
    const { paymentId } = await createProductAndPaymentFixture(testApp, apiKey, "100.00");
    const first = await testApp.app.inject({
      method: "POST",
      url: `/v1/payments/${paymentId}/refunds`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "60.00" },
    });
    expect(first.statusCode).toBe(201);

    // Reflect the first refund's effect on the on-chain cumulative total the
    // way a real chain read would (Phase 8 has no relayer to do this yet).
    testApp.mandateReader.setRefundedTotal(paymentId, 60_0000000n);

    const second = await testApp.app.inject({
      method: "POST",
      url: `/v1/payments/${paymentId}/refunds`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "60.00" },
    });
    expect(second.statusCode).toBe(422);
    expect(second.json().code).toBe("RefundExceedsPayment");
  });

  it("404s for a payment owned by a different merchant", async () => {
    const { paymentId } = await createProductAndPaymentFixture(testApp, apiKey);
    const otherApiKey = (await createTestMerchant(testApp.prisma)).apiKey;
    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/payments/${paymentId}/refunds`,
      headers: { ...authHeader(otherApiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "10.00" },
    });
    expect(response.statusCode).toBe(404);
  });
});
