import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authHeader,
  buildTestApp,
  cleanDatabase,
  createTestMerchant,
  randomHexId32,
  randomStellarAccountAddress,
  randomStellarContractAddress,
  type TestApp,
} from "../test/helpers.js";

const ASSET_DECIMALS = 7;

/** Builds a product + checkout session + MandateIndex row (as `checkout-sessions.ts`'s `/mandate` link endpoint would after Phase 11's change) for a given payer, returning the mandateId and merchantId. */
async function createDiscoverableMandate(
  testApp: TestApp,
  apiKey: string,
  payerAddress: string,
  overrides: { amount?: string } = {},
): Promise<{ mandateId: string; merchantId: string }> {
  const amount = overrides.amount ?? "100.00";
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
  await testApp.prisma.checkoutSession.update({ where: { id: sessionId }, data: { mandateId, status: "completed", payerAddress } });
  const session = await testApp.prisma.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } });

  await testApp.prisma.mandateIndex.create({
    data: {
      mandateId,
      merchantId: session.merchantId,
      payerAddress,
      merchantAddress: randomStellarAccountAddress(),
      assetAddress: randomStellarContractAddress(),
      status: "Active",
      lastIndexedAt: testApp.now,
    },
  });

  return { mandateId, merchantId: session.merchantId };
}

describe("GET /v1/consumer/mandates", () => {
  let testApp: TestApp;
  let apiKey: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    apiKey = (await createTestMerchant(testApp.prisma, { name: "Acme Roasters" })).apiKey;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("requires no authentication", async () => {
    const payerAddress = randomStellarAccountAddress();
    const response = await testApp.app.inject({ method: "GET", url: `/v1/consumer/mandates?payerAddress=${payerAddress}` });
    expect(response.statusCode).toBe(200);
  });

  it("lists mandates discovered for a payer, enriched with the merchant's display name", async () => {
    const payerAddress = randomStellarAccountAddress();
    const { mandateId } = await createDiscoverableMandate(testApp, apiKey, payerAddress);

    const response = await testApp.app.inject({ method: "GET", url: `/v1/consumer/mandates?payerAddress=${payerAddress}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: Array<{ mandateId: string; merchant: { name: string }; cachedStatus: string; assetDecimals: number }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.mandateId).toBe(mandateId);
    expect(body.data[0]?.merchant.name).toBe("Acme Roasters");
    expect(body.data[0]?.cachedStatus).toBe("Active");
    expect(body.data[0]?.assetDecimals).toBe(7);
  });

  it("never returns another payer's mandates", async () => {
    await createDiscoverableMandate(testApp, apiKey, randomStellarAccountAddress());
    const response = await testApp.app.inject({
      method: "GET",
      url: `/v1/consumer/mandates?payerAddress=${randomStellarAccountAddress()}`,
    });
    expect((response.json() as { data: unknown[] }).data).toHaveLength(0);
  });

  it("rejects a malformed payerAddress", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/consumer/mandates?payerAddress=not-an-address" });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /v1/consumer/payments", () => {
  let testApp: TestApp;
  let apiKey: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    apiKey = (await createTestMerchant(testApp.prisma, { name: "Acme Roasters" })).apiKey;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("returns an empty shape for a payer with no discoverable mandates", async () => {
    const response = await testApp.app.inject({
      method: "GET",
      url: `/v1/consumer/payments?payerAddress=${randomStellarAccountAddress()}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ payments: [], failedAttempts: [] });
  });

  it("lists successful payments in decimal amounts, enriched with merchant name", async () => {
    const payerAddress = randomStellarAccountAddress();
    const { mandateId, merchantId } = await createDiscoverableMandate(testApp, apiKey, payerAddress);
    await testApp.prisma.payment.create({
      data: {
        paymentId: randomHexId32(),
        merchantId,
        mandateId,
        chargeId: randomHexId32(),
        amount: "1000000000", // 100.0000000 at 7 decimals
        assetAddress: randomStellarContractAddress(),
        transactionHash: randomHexId32(),
        ledger: 12345n,
      },
    });

    const response = await testApp.app.inject({ method: "GET", url: `/v1/consumer/payments?payerAddress=${payerAddress}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { payments: Array<{ amount: string; merchant: { name: string } }> };
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]?.amount).toBe("100.0000000");
    expect(body.payments[0]?.merchant.name).toBe("Acme Roasters");
  });

  it("lists failed charge attempts with their failure code, but not scheduled/processing ones", async () => {
    const payerAddress = randomStellarAccountAddress();
    const { mandateId, merchantId } = await createDiscoverableMandate(testApp, apiKey, payerAddress);
    await testApp.prisma.chargeRequest.create({
      data: {
        merchantId,
        mandateId,
        chargeId: randomHexId32(),
        amount: "500000000",
        invoiceHash: randomHexId32(),
        scheduledFor: testApp.now,
        status: "permanently_failed",
        failureCode: "AmountExceedsChargeLimit",
      },
    });
    await testApp.prisma.chargeRequest.create({
      data: {
        merchantId,
        mandateId,
        chargeId: randomHexId32(),
        amount: "500000000",
        invoiceHash: randomHexId32(),
        scheduledFor: testApp.now,
        status: "scheduled",
      },
    });

    const response = await testApp.app.inject({ method: "GET", url: `/v1/consumer/payments?payerAddress=${payerAddress}` });
    const body = response.json() as { failedAttempts: Array<{ failureCode?: string; amount: string }> };
    expect(body.failedAttempts).toHaveLength(1);
    expect(body.failedAttempts[0]?.failureCode).toBe("AmountExceedsChargeLimit");
    expect(body.failedAttempts[0]?.amount).toBe("50.0000000");
  });

  it("rejects a malformed payerAddress", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/consumer/payments?payerAddress=not-an-address" });
    expect(response.statusCode).toBe(400);
  });
});
