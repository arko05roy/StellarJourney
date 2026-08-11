import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StellarMandates, StellarMandatesApiError, StellarMandatesNetworkError } from "./client.js";
import type { FetchLike } from "./http.js";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responseStatus: number, responseBody: unknown, calls: CapturedCall[]): FetchLike {
  return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return new Response(JSON.stringify(responseBody), { status: responseStatus, headers: { "content-type": "application/json" } });
  }) as FetchLike;
}

const API_KEY = "sk_live_test_key";
const BASE_URL = "https://api.paymap.test/v1";

describe("StellarMandates client — request shape", () => {
  it("checkoutSessions.create hits POST /checkout-sessions with auth + auto Idempotency-Key + full body (incl. successUrl/cancelUrl per PLAN.md §17)", async () => {
    const calls: CapturedCall[] = [];
    const mandates = new StellarMandates({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fakeFetch(201, { id: "cs_1", merchantId: "m_1", productId: "prod_1", expiresAt: "2026-01-01T00:00:00Z", status: "pending", createdAt: "2026-01-01T00:00:00Z" }, calls) });

    const result = await mandates.checkoutSessions.create({
      productId: "prod_monthly_ai",
      clientReference: "customer_123",
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    });

    expect(result.id).toBe("cs_1");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one call");
    expect(call.url).toBe(`${BASE_URL}/checkout-sessions`);
    expect(call.method).toBe("POST");
    expect(call.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(call.headers["idempotency-key"]).toBeTruthy();
    expect(call.body).toMatchObject({
      productId: "prod_monthly_ai",
      clientReference: "customer_123",
      successUrl: "https://merchant.example/success",
      cancelUrl: "https://merchant.example/cancel",
    });
  });

  it("checkoutSessions.create honors an explicit idempotencyKey instead of generating one", async () => {
    const calls: CapturedCall[] = [];
    const mandates = new StellarMandates({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fakeFetch(201, { id: "cs_1" }, calls) });
    await mandates.checkoutSessions.create({ productId: "prod_1", idempotencyKey: "my-fixed-key" });
    expect(calls[0]?.headers["idempotency-key"]).toBe("my-fixed-key");
  });

  it("charges.create posts to /mandates/:id/charges, hashes invoiceId into invoiceHash, and drops mandateId/asset/invoiceId from the body", async () => {
    const calls: CapturedCall[] = [];
    const mandates = new StellarMandates({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: fakeFetch(201, { id: "cr_1", mandateId: "mandate_abc", chargeId: "c_1", amount: "15.00", invoiceHash: "x", scheduledFor: "2026-01-01T00:00:00Z", status: "scheduled", attemptCount: 0, createdAt: "2026-01-01T00:00:00Z" }, calls),
    });

    await mandates.charges.create({
      mandateId: "mandate_abc",
      amount: "15.00",
      asset: "USDC",
      invoiceId: "invoice_2026_08_001",
      idempotencyKey: "invoice_2026_08_001",
    });

    const call = calls[0];
    if (!call) throw new Error("expected one call");
    expect(call.url).toBe(`${BASE_URL}/mandates/mandate_abc/charges`);
    expect(call.headers["idempotency-key"]).toBe("invoice_2026_08_001");
    const expectedHash = createHash("sha256").update("invoice_2026_08_001", "utf8").digest("hex");
    expect(call.body).toEqual({ amount: "15.00", invoiceHash: expectedHash });
  });

  it("payments.refunds.create posts to /payments/:id/refunds", async () => {
    const calls: CapturedCall[] = [];
    const mandates = new StellarMandates({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: fakeFetch(201, { id: "rr_1", paymentId: "pay_1", refundId: "r_1", amount: "5.00", status: "scheduled", createdAt: "2026-01-01T00:00:00Z" }, calls),
    });

    await mandates.payments.refunds.create({ paymentId: "pay_1", amount: "5.00" });

    const call = calls[0];
    if (!call) throw new Error("expected one call");
    expect(call.url).toBe(`${BASE_URL}/payments/pay_1/refunds`);
    expect(call.body).toEqual({ amount: "5.00" });
    expect(call.headers["idempotency-key"]).toBeTruthy();
  });

  it("mandates.get issues a GET with no Idempotency-Key", async () => {
    const calls: CapturedCall[] = [];
    const mandates = new StellarMandates({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fakeFetch(200, { id: "mandate_abc", status: "Active" }, calls) });
    await mandates.mandates.get("mandate_abc");
    const call = calls[0];
    if (!call) throw new Error("expected one call");
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`${BASE_URL}/mandates/mandate_abc`);
    expect(call.headers["idempotency-key"]).toBeUndefined();
  });

  it("payments.list builds the query string from mandateId/limit", async () => {
    const calls: CapturedCall[] = [];
    const mandates = new StellarMandates({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fakeFetch(200, { data: [] }, calls) });
    await mandates.payments.list({ mandateId: "mandate_abc", limit: 10 });
    expect(calls[0]?.url).toBe(`${BASE_URL}/payments?mandateId=mandate_abc&limit=10`);
  });
});

describe("StellarMandates client — error mapping", () => {
  it("maps a non-2xx response to StellarMandatesApiError, preserving the contract error code", async () => {
    const calls: CapturedCall[] = [];
    const mandates = new StellarMandates({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetch: fakeFetch(409, { code: "MandateRevoked", message: "Contract rejected the request: MandateRevoked." }, calls),
    });

    await expect(mandates.mandates.get("mandate_abc")).rejects.toMatchObject({ code: "MandateRevoked", httpStatus: 409 });
    try {
      await mandates.mandates.get("mandate_abc");
    } catch (error) {
      expect(error).toBeInstanceOf(StellarMandatesApiError);
      expect((error as StellarMandatesApiError).isContractError()).toBe(true);
    }
  });

  it("maps a failed fetch (network error) to StellarMandatesNetworkError", async () => {
    const throwingFetch: FetchLike = (async () => {
      throw new Error("ECONNREFUSED");
    }) as FetchLike;
    const mandates = new StellarMandates({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: throwingFetch });
    await expect(mandates.mandates.get("mandate_abc")).rejects.toBeInstanceOf(StellarMandatesNetworkError);
  });

  it("constructing without an apiKey throws immediately", () => {
    expect(() => new StellarMandates({ apiKey: "" })).toThrow();
  });
});
