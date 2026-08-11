import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeader, buildMandate, buildTestApp, cleanDatabase, createTestMerchant, randomHexId32, randomStellarContractAddress, type TestApp } from "../test/helpers.js";

describe("GET /v1/mandates/:id", () => {
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

  it("requires authentication", async () => {
    const mandate = buildMandate({ merchant: walletAddress });
    testApp.mandateReader.setMandate(mandate);
    const response = await testApp.app.inject({ method: "GET", url: `/v1/mandates/${mandate.id}` });
    expect(response.statusCode).toBe(401);
  });

  it("returns a mandate this merchant owns", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Active" });
    testApp.mandateReader.setMandate(mandate);
    const response = await testApp.app.inject({ method: "GET", url: `/v1/mandates/${mandate.id}`, headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { id: string; status: string }).status).toBe("Active");
  });

  it("404s for an unknown mandate id", async () => {
    const unknownId = "0".repeat(64);
    const response = await testApp.app.inject({ method: "GET", url: `/v1/mandates/${unknownId}`, headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("MandateNotFound");
  });

  it("404s (not 403) for a mandate that belongs to a different merchant — never reveals existence", async () => {
    const mandate = buildMandate(); // random merchant address, not this test's merchant
    testApp.mandateReader.setMandate(mandate);
    const response = await testApp.app.inject({ method: "GET", url: `/v1/mandates/${mandate.id}`, headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("MandateNotFound");
  });

  it("rejects a malformed mandate id", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/mandates/not-a-hex-id", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(400);
  });

  it("refreshes the MandateIndex cache as a side effect", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Paused" });
    testApp.mandateReader.setMandate(mandate);
    await testApp.app.inject({ method: "GET", url: `/v1/mandates/${mandate.id}`, headers: authHeader(apiKey) });
    const cached = await testApp.prisma.mandateIndex.findUnique({ where: { mandateId: mandate.id } });
    expect(cached?.status).toBe("Paused");
  });
});

describe("GET /v1/mandates", () => {
  let testApp: TestApp;
  let apiKey: string;
  let walletAddress: string;
  let merchantId: string;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
    const merchant = await createTestMerchant(testApp.prisma);
    apiKey = merchant.apiKey;
    walletAddress = merchant.walletAddress;
    merchantId = merchant.merchantId;
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("requires authentication", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/mandates" });
    expect(response.statusCode).toBe(401);
  });

  it("returns a fresh live-read status for an indexed mandate, never the DB cache alone", async () => {
    const mandate = buildMandate({ merchant: walletAddress, status: "Active" });
    testApp.mandateReader.setMandate(mandate);
    // Seed the index the same way the single-mandate read does (mirrors the "refreshes MandateIndex" test above).
    await testApp.app.inject({ method: "GET", url: `/v1/mandates/${mandate.id}`, headers: authHeader(apiKey) });

    // Mutate on-chain state after indexing — a stale DB cache would still say "Active".
    testApp.mandateReader.setMandate({ ...mandate, status: "Paused" });

    const response = await testApp.app.inject({ method: "GET", url: "/v1/mandates", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { live: boolean; mandateId: string; mandate?: { status: string } }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.live).toBe(true);
    expect(body.data[0]?.mandate?.status).toBe("Paused");
  });

  it("degrades to the cached status (live: false) when the on-chain read fails, instead of failing the whole list", async () => {
    await testApp.prisma.mandateIndex.create({
      data: {
        mandateId: randomHexId32(),
        merchantId,
        payerAddress: randomStellarContractAddress(),
        merchantAddress: walletAddress,
        assetAddress: randomStellarContractAddress(),
        status: "Active",
      },
    });
    // Deliberately never registered with `testApp.mandateReader` — the live read throws MandateReadError.

    const response = await testApp.app.inject({ method: "GET", url: "/v1/mandates", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { live: boolean; cachedStatus?: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.live).toBe(false);
    expect(body.data[0]?.cachedStatus).toBe("Active");
  });

  it("never returns another merchant's mandates", async () => {
    const other = await createTestMerchant(testApp.prisma);
    const mandate = buildMandate({ merchant: other.walletAddress, status: "Active" });
    testApp.mandateReader.setMandate(mandate);
    await testApp.app.inject({ method: "GET", url: `/v1/mandates/${mandate.id}`, headers: authHeader(other.apiKey) });

    const response = await testApp.app.inject({ method: "GET", url: "/v1/mandates", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown[] }).data).toHaveLength(0);
  });
});
