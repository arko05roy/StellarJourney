import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authHeader,
  buildMandate,
  buildTestApp,
  cleanDatabase,
  createTestMerchant,
  randomHexId32,
  randomStellarContractAddress,
  type TestApp,
} from "../test/helpers.js";
import type { Mandate } from "@paymap/contract-client";

const ASSET_DECIMALS = 7;

/** Creates a product + checkout session, then links a mandate id to it directly (Phase 10, which drives the real wallet-authorization flow that produces this link, doesn't exist yet — this is the minimal fixture standing in for it). */
async function linkMandateToProduct(testApp: TestApp, apiKey: string, mandate: Mandate, fixedAmount = "100.00"): Promise<void> {
  const productResponse = await testApp.app.inject({
    method: "POST",
    url: "/v1/products",
    headers: authHeader(apiKey),
    payload: {
      name: "Pro Plan",
      assetAddress: randomStellarContractAddress(),
      assetDecimals: ASSET_DECIMALS,
      amountType: "fixed",
      fixedAmount,
      maxPerPeriod: fixedAmount,
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

  await testApp.prisma.checkoutSession.update({ where: { id: sessionId }, data: { mandateId: mandate.id, status: "completed" } });
}

describe("POST /v1/mandates/:id/charges", () => {
  let testApp: TestApp;
  let apiKey: string;
  let walletAddress: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    const merchant = await createTestMerchant(testApp.prisma);
    apiKey = merchant.apiKey;
    walletAddress = merchant.walletAddress;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("requires an Idempotency-Key header", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Active", startAt: 0n });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate);

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: authHeader(apiKey),
      payload: { amount: "100.00", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("creates a scheduled charge request for a valid Active mandate", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Active", startAt: 0n });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate);

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "100.00", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { status: string; amount: string; mandateId: string };
    expect(body.status).toBe("scheduled");
    expect(body.amount).toBe("100.0000000");
    expect(body.mandateId).toBe(mandate.id);

    const stored = await testApp.prisma.chargeRequest.findFirst({ where: { mandateId: mandate.id } });
    expect(stored?.status).toBe("scheduled");
  });

  it("rejects a revoked mandate with the specific contract error code, never a generic error", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Revoked", startAt: 0n });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate);

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "100.00", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("MandateRevoked");

    const count = await testApp.prisma.chargeRequest.count({ where: { mandateId: mandate.id } });
    expect(count).toBe(0);
  });

  it("rejects a paused mandate with MandatePaused", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Paused", startAt: 0n });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate);

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "100.00", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("MandatePaused");
  });

  it("rejects an expired mandate with MandateExpired", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Active", startAt: 0n, expiresAt: 500n });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate);
    testApp.setNow(new Date(600_000)); // 600 seconds since epoch, past expiresAt = 500

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "100.00", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("MandateExpired");
  });

  it("rejects an amount exceeding the per-charge limit with AmountExceedsChargeLimit", async () => {
    const mandate = buildMandate({
      merchant: walletAddress,
      status: "Active",
      startAt: 0n,
      amountRule: { kind: "variable", maxPerCharge: 100_0000000n }, // 100.0000000 at 7 decimals
    });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate, "100.00");

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "999.00", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("AmountExceedsChargeLimit");
  });

  it("rejects a mandate that belongs to a different merchant (404, not 403)", async () => {
    const mandate = buildMandate({ status: "Active", startAt: 0n }); // random merchant address
    testApp.mandateReader.setMandate(mandate);

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "100.00", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a malformed amount at the API boundary", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Active", startAt: 0n });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate);

    const response = await testApp.app.inject({
      method: "POST",
      url: `/v1/mandates/${mandate.id}/charges`,
      headers: { ...authHeader(apiKey), "idempotency-key": randomHexId32() },
      payload: { amount: "not-a-number", invoiceHash: randomHexId32() },
    });
    expect(response.statusCode).toBe(400);
  });

  it("replays the stored response for the same Idempotency-Key + same body without creating a second row", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Active", startAt: 0n });
    testApp.mandateReader.setMandate(mandate);
    await linkMandateToProduct(testApp, apiKey, mandate);
    const headers = { ...authHeader(apiKey), "idempotency-key": "charge-replay" };
    const payload = { amount: "100.00", invoiceHash: randomHexId32() };

    const first = await testApp.app.inject({ method: "POST", url: `/v1/mandates/${mandate.id}/charges`, headers, payload });
    const second = await testApp.app.inject({ method: "POST", url: `/v1/mandates/${mandate.id}/charges`, headers, payload });

    expect(first.json()).toEqual(second.json());
    const count = await testApp.prisma.chargeRequest.count({ where: { mandateId: mandate.id } });
    expect(count).toBe(1);
  });
});
