import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeader, buildMandate, buildTestApp, cleanDatabase, createTestMerchant, type TestApp } from "../test/helpers.js";

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
