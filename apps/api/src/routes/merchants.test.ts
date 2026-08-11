import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestApp, cleanDatabase, createTestMerchant, type TestApp } from "../test/helpers.js";

const SIGNED_MESSAGE_PREFIX = "Stellar Signed Message:\n";

function signChallenge(signer: Keypair, message: string): string {
  const digest = createHash("sha256")
    .update(SIGNED_MESSAGE_PREFIX, "utf8")
    .update(message, "utf8")
    .digest();
  return signer.sign(digest).toString("base64");
}

async function completeWalletAuth(
  testApp: TestApp,
  signer: Keypair,
): Promise<{ sessionToken: string; profileRequired: boolean }> {
  const prepared = await testApp.app.inject({
    method: "POST",
    url: "/v1/merchant-auth/challenges",
    payload: { walletAddress: signer.publicKey() },
  });
  expect(prepared.statusCode).toBe(201);
  const challenge = prepared.json() as {
    challengeId: string;
    message: string;
  };
  const completed = await testApp.app.inject({
    method: "POST",
    url: "/v1/merchant-auth/complete",
    payload: {
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: signChallenge(signer, challenge.message),
      signerAddress: signer.publicKey(),
    },
  });
  expect(completed.statusCode).toBe(201);
  return completed.json() as { sessionToken: string; profileRequired: boolean };
}

async function createVerifiedMerchant(
  testApp: TestApp,
  signer = Keypair.random(),
): Promise<{ signer: Keypair; sessionToken: string }> {
  const auth = await completeWalletAuth(testApp, signer);
  expect(auth.profileRequired).toBe(true);
  const registered = await testApp.app.inject({
    method: "POST",
    url: "/v1/merchant-auth/register",
    headers: { authorization: `Bearer ${auth.sessionToken}` },
    payload: { name: "Verified Merchant" },
  });
  expect(registered.statusCode).toBe(201);
  return { signer, sessionToken: auth.sessionToken };
}

describe("merchant wallet authentication", () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = buildTestApp();
    await cleanDatabase(testApp.prisma);
  });

  afterEach(async () => {
    await testApp.app.close();
    await testApp.prisma.$disconnect();
  });

  it("creates a merchant only after a valid wallet signature and issues no API key", async () => {
    const { signer, sessionToken } = await createVerifiedMerchant(testApp);
    expect(sessionToken.startsWith("pms_live_")).toBe(true);

    const merchant = await testApp.prisma.merchant.findUniqueOrThrow({
      where: { walletAddress: signer.publicKey() },
      include: { apiKeys: true },
    });
    expect(merchant.apiKeys).toHaveLength(0);

    const authenticated = await testApp.app.inject({
      method: "GET",
      url: "/v1/products",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(authenticated.statusCode).toBe(200);
  });

  it("signs an existing merchant into the same account", async () => {
    const existing = await createTestMerchant(testApp.prisma);
    expect(existing.signer).toBeDefined();
    const result = await completeWalletAuth(testApp, existing.signer!);
    expect(result.profileRequired).toBe(false);
    expect(await testApp.prisma.merchant.count()).toBe(1);
  });

  it("rejects altered, wrong-wallet, expired, and replayed challenges", async () => {
    const signer = Keypair.random();
    const other = Keypair.random();
    const prepared = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/challenges",
      payload: { walletAddress: signer.publicKey() },
    });
    const challenge = prepared.json() as { challengeId: string; message: string };

    const altered = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/complete",
      payload: {
        challengeId: challenge.challengeId,
        message: `${challenge.message}\naltered`,
        signature: signChallenge(signer, challenge.message),
        signerAddress: signer.publicKey(),
      },
    });
    expect(altered.statusCode).toBe(401);
    expect(altered.json().code).toBe("INVALID_AUTH_CHALLENGE");

    const wrongWallet = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/complete",
      payload: {
        challengeId: challenge.challengeId,
        message: challenge.message,
        signature: signChallenge(other, challenge.message),
        signerAddress: other.publicKey(),
      },
    });
    expect(wrongWallet.statusCode).toBe(401);
    expect(wrongWallet.json().code).toBe("WALLET_ADDRESS_MISMATCH");

    const validPayload = {
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: signChallenge(signer, challenge.message),
      signerAddress: signer.publicKey(),
    };
    const completed = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/complete",
      payload: validPayload,
    });
    expect(completed.statusCode).toBe(201);
    const replayed = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/complete",
      payload: validPayload,
    });
    expect(replayed.statusCode).toBe(409);
    expect(replayed.json().code).toBe("AUTH_CHALLENGE_USED");

    const expiringSigner = Keypair.random();
    const expiring = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/challenges",
      payload: { walletAddress: expiringSigner.publicKey() },
    });
    const expiringChallenge = expiring.json() as { challengeId: string; message: string };
    testApp.setNow(new Date(testApp.now.getTime() + 5 * 60 * 1000 + 1));
    const expired = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/complete",
      payload: {
        challengeId: expiringChallenge.challengeId,
        message: expiringChallenge.message,
        signature: signChallenge(expiringSigner, expiringChallenge.message),
        signerAddress: expiringSigner.publicKey(),
      },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe("AUTH_CHALLENGE_EXPIRED");
  });

  it("revokes the dashboard session on logout", async () => {
    const { sessionToken } = await createVerifiedMerchant(testApp);
    const loggedOut = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchant-auth/logout",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(loggedOut.statusCode).toBe(204);
    const rejected = await testApp.app.inject({
      method: "GET",
      url: "/v1/products",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().code).toBe("MERCHANT_SESSION_EXPIRED");
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

  it("lets a wallet session create a least-privilege integration key", async () => {
    const { sessionToken } = await createVerifiedMerchant(testApp);
    const issued = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: "Catalog reader", scopes: ["products:read"] },
    });
    expect(issued.statusCode).toBe(201);
    const { apiKey: readKey } = issued.json() as { apiKey: string };
    expect(readKey.startsWith("sk_live_")).toBe(true);

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
  });

  it("lists keys and lets the wallet session revoke any integration key", async () => {
    const { sessionToken } = await createVerifiedMerchant(testApp);
    const issued = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { name: "Reader", scopes: ["products:read"] },
    });
    const { apiKeyId } = issued.json() as { apiKeyId: string };

    const listed = await testApp.app.inject({
      method: "GET",
      url: "/v1/merchants/me/api-keys",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { data: unknown[] }).data).toHaveLength(1);

    const revoked = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/merchants/me/api-keys/${apiKeyId}`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(revoked.statusCode).toBe(204);
  });

  it("keeps legacy API-key rotation and self-revocation protection", async () => {
    const existing = await createTestMerchant(testApp.prisma);
    const rotated = await testApp.app.inject({
      method: "POST",
      url: "/v1/merchants/me/api-keys/rotate",
      headers: { authorization: `Bearer ${existing.apiKey}` },
    });
    expect(rotated.statusCode).toBe(201);
    const { apiKey: newKey, apiKeyId: newKeyId } = rotated.json() as {
      apiKey: string;
      apiKeyId: string;
    };
    expect(newKey).not.toBe(existing.apiKey);

    const self = await testApp.app.inject({
      method: "DELETE",
      url: `/v1/merchants/me/api-keys/${newKeyId}`,
      headers: { authorization: `Bearer ${newKey}` },
    });
    expect(self.statusCode).toBe(409);
    expect(self.json().code).toBe("CANNOT_REVOKE_CURRENT_API_KEY");
  });
});
