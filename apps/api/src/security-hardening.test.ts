import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildTestApp,
  cleanDatabase,
  randomStellarAccountAddress,
  type TestApp,
} from "./test/helpers.js";

describe("sensitive-route rate limits under burst load", () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("caps merchant bootstrap at 5 requests/minute/IP", async () => {
    const responses = [];
    for (let index = 0; index < 6; index++) {
      responses.push(
        await testApp.app.inject({
          method: "POST",
          url: "/v1/merchants",
          payload: {
            name: `Merchant ${String(index)}`,
            walletAddress: randomStellarAccountAddress(),
          },
        }),
      );
    }
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(5);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
  });

  it.each([
    {
      name: "API-key rotation",
      count: 6,
      method: "POST" as const,
      url: "/v1/merchants/me/api-keys/rotate",
      allowedStatus: 401,
    },
    {
      name: "charge creation",
      count: 31,
      method: "POST" as const,
      url: `/v1/mandates/${"a".repeat(64)}/charge-authorizations`,
      allowedStatus: 401,
    },
    {
      name: "public checkout reads",
      count: 61,
      method: "GET" as const,
      url: "/v1/checkout-sessions/not-found/public",
      allowedStatus: 404,
    },
    {
      name: "checkout mandate linking",
      count: 21,
      method: "POST" as const,
      url: "/v1/checkout-sessions/not-found/mandate",
      allowedStatus: 400,
    },
  ])(
    "caps $name before excess requests reach route logic",
    async ({ count, method, url, allowedStatus }) => {
      const responses = [];
      for (let index = 0; index < count; index++) {
        responses.push(
          await testApp.app.inject({
            method,
            url,
            ...(method === "POST" ? { payload: {} } : {}),
          }),
        );
      }
      expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode === allowedStatus)).toHaveLength(
        count - 1,
      );
      expect(responses.find((response) => response.statusCode === 429)?.json()).toMatchObject({
        code: "RATE_LIMITED",
      });
    },
  );

  it("exports bounded API-key rejection metrics", async () => {
    await testApp.app.inject({
      method: "GET",
      url: "/v1/products",
      headers: { authorization: "Bearer malformed" },
    });
    const response = await testApp.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('paymap_api_auth_rejections_total{reason="INVALID_API_KEY"} 1');
    expect(response.body).not.toContain("malformed");
  });
});
