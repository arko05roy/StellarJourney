import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTestApp,
  cleanDatabase,
  randomStellarAccountAddress,
  type TestApp,
} from "../test/helpers.js";

describe("POST /v1/merchants", () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("creates a merchant and shows the API key exactly once", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants",
      payload: { name: "Acme Inc", walletAddress: randomStellarAccountAddress() },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { merchantId: string; apiKey: string };
    expect(body.apiKey.startsWith("sk_live_")).toBe(true);

    // The new key works immediately.
    const authed = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys/rotate",
      headers: { authorization: `Bearer ${body.apiKey}` },
    });
    expect(authed.statusCode).toBe(201);
  });

  it("rejects an invalid wallet address", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants",
      payload: { name: "Acme Inc", walletAddress: "not-a-stellar-address" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("VALIDATION_ERROR");
  });

  it("rate-limits merchant creation", async () => {
    const requests = Array.from({ length: 7 }, (_, i) =>
      testApp.app.inject({
        method: "POST",
        url: "/v1/merchants",
        payload: { name: `Acme ${String(i)}`, walletAddress: randomStellarAccountAddress() },
      }),
    );
    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(5);
    expect(statuses).toContain(429);
  });
});

describe("POST /v1/merchants/me/api-keys/rotate", () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("requires authentication", async () => {
    const response = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys/rotate",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("MISSING_API_KEY");
  });

  it("issues a new key and revokes the old one", async () => {
    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants",
      payload: { name: "Acme Inc", walletAddress: randomStellarAccountAddress() },
    });
    const { apiKey: oldKey } = created.json() as { apiKey: string };

    const rotated = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys/rotate",
      headers: { authorization: `Bearer ${oldKey}` },
    });
    expect(rotated.statusCode).toBe(201);
    const { apiKey: newKey } = rotated.json() as { apiKey: string };
    expect(newKey).not.toBe(oldKey);

    // Old key is now rejected.
    const withOldKey = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys/rotate",
      headers: { authorization: `Bearer ${oldKey}` },
    });
    expect(withOldKey.statusCode).toBe(401);
    expect(withOldKey.json().code).toBe("API_KEY_REVOKED");

    // New key works.
    const withNewKey = await testApp.app.inject({
      method: "GET",
      url: "/v1/products/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${newKey}` },
    });
    // 404 (no such product) proves auth succeeded, not 401.
    expect(withNewKey.statusCode).toBe(404);
  });
});

describe("scoped API keys", () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("enforces least privilege and prevents scope escalation", async () => {
    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants",
      payload: { name: "Scoped Inc", walletAddress: randomStellarAccountAddress() },
    });
    const { apiKey: adminKey } = created.json() as { apiKey: string };

    const issued = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys",
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { name: "Catalog reader", scopes: ["products:read"] },
    });
    expect(issued.statusCode).toBe(201);
    const { apiKey: readKey } = issued.json() as { apiKey: string };

    const allowed = await testApp.app.inject({
      method: "GET",
      url: "/v1/products",
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(allowed.statusCode).toBe(200);

    const denied = await testApp.app.inject({
      method: "POST",
      url: "/v1/products",
      headers: { authorization: `Bearer ${readKey}` },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("INSUFFICIENT_SCOPE");

    const escalation = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys",
      headers: { authorization: `Bearer ${readKey}` },
      payload: { name: "Admin", scopes: ["api_keys:manage"] },
    });
    expect(escalation.statusCode).toBe(403);
    expect(escalation.json().code).toBe("INSUFFICIENT_SCOPE");
  });

  it("lists and revokes another key but refuses self-revocation", async () => {
    const created = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants",
      payload: { name: "Scoped Inc", walletAddress: randomStellarAccountAddress() },
    });
    const { apiKey: adminKey, apiKeyId: adminKeyId } = created.json() as {
      apiKey: string;
      apiKeyId: string;
    };
    const issued = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys",
      headers: { authorization: `Bearer ${adminKey}` },
      payload: { name: "Reader", scopes: ["products:read"] },
    });
    const { apiKeyId: readerKeyId } = issued.json() as { apiKeyId: string };

    const listed = await testApp.app.inject({
      method: "GET",
      url: "/v1/merchants/me/api-keys",
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { data: unknown[] }).data).toHaveLength(2);

    const self = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/merchants/me/api-keys/${adminKeyId}`,
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().code).toBe("CANNOT_REVOKE_CURRENT_API_KEY");

    const revoked = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/merchants/me/api-keys/${readerKeyId}`,
      headers: { authorization: `Bearer ${adminKey}` },
    });
    expect(revoked.statusCode).toBe(204);
  });
});
