import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeader, buildTestApp, cleanDatabase, createTestMerchant, randomStellarContractAddress, type TestApp } from "../test/helpers.js";

const baseFixedProduct = {
  name: "Pro Plan",
  assetDecimals: 7,
  amountType: "fixed" as const,
  fixedAmount: "15.00",
  maxPerPeriod: "15.00",
  periodSeconds: 2_592_000,
  minIntervalSeconds: 0,
  maxSuccessfulCharges: 0,
  defaultDurationSeconds: 31_536_000,
};

describe("POST /v1/products", () => {
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

  it("requires authentication", async () => {
    const response = await testApp.app.inject({ method: "POST", url: "/v1/products", payload: baseFixedProduct });
    expect(response.statusCode).toBe(401);
  });

  it("creates a fixed-amount product and round-trips the decimal amount", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, assetAddress: randomStellarContractAddress() },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; fixedAmount: string; maxPerPeriod: string };
    expect(body.fixedAmount).toBe("15.0000000");
    expect(body.maxPerPeriod).toBe("15.0000000");

    const fetched = await testApp.app.inject({ method: "GET", url: `/v1/products/${body.id}`, headers: authHeader(apiKey) });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { fixedAmount: string }).fixedAmount).toBe("15.0000000");
  });

  it("creates a variable-amount product", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: {
        ...baseFixedProduct,
        amountType: "variable",
        fixedAmount: undefined,
        maxPerCharge: "50.00",
        assetAddress: randomStellarContractAddress(),
      },
    });
    expect(response.statusCode).toBe(201);
    expect((response.json() as { maxPerCharge: string }).maxPerCharge).toBe("50.0000000");
  });

  it("rejects an unknown/malformed asset address", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, assetAddress: "not-a-real-asset" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects a negative amount", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, assetAddress: randomStellarContractAddress(), fixedAmount: "-5.00" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a zero amount", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, assetAddress: randomStellarContractAddress(), fixedAmount: "0" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_AMOUNT");
  });

  it("rejects more precision than the asset's declared decimals", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, assetAddress: randomStellarContractAddress(), assetDecimals: 2, fixedAmount: "15.12345" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_AMOUNT");
  });

  it("rejects an unbounded (absurdly large) period/duration", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, assetAddress: randomStellarContractAddress(), periodSeconds: Number.MAX_SAFE_INTEGER },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /v1/products", () => {
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

  it("requires authentication", async () => {
    const response = await testApp.app.inject({ method: "GET", url: "/v1/products" });
    expect(response.statusCode).toBe(401);
  });

  it("lists this merchant's products, newest first, and never another merchant's", async () => {
    await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, name: "First", assetAddress: randomStellarContractAddress() },
    });
    await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, name: "Second", assetAddress: randomStellarContractAddress() },
    });
    const otherApiKey = (await createTestMerchant(testApp.prisma)).apiKey;
    await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(otherApiKey),
      payload: { ...baseFixedProduct, name: "Someone else's", assetAddress: randomStellarContractAddress() },
    });

    const response = await testApp.app.inject({ method: "GET", url: "/v1/products", headers: authHeader(apiKey) });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { name: string }[] };
    expect(body.data.map((p) => p.name)).toEqual(["Second", "First"]);
  });
});

describe("GET /v1/products/:id", () => {
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

  it("404s for a product owned by a different merchant", async () => {
    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: authHeader(apiKey),
      payload: { ...baseFixedProduct, assetAddress: randomStellarContractAddress() },
    });
    const { id } = created.json() as { id: string };

    const otherApiKey = (await createTestMerchant(testApp.prisma)).apiKey;
    const response = await testApp.app.inject({ method: "GET", url: `/v1/products/${id}`, headers: authHeader(otherApiKey) });
    expect(response.statusCode).toBe(404);
  });
});
