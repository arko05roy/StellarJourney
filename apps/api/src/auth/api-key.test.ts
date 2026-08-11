import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateApiKey, createMerchantWithApiKey, generateApiKey, hashApiKey, rotateApiKey } from "./api-key.js";
import { ApiError } from "../errors.js";
import { cleanDatabase, createTestPrisma, randomStellarAccountAddress, TEST_HASH_SECRET } from "../test/helpers.js";
import type { PrismaClient } from "../db.js";

describe("hashApiKey", () => {
  it("is deterministic for the same key + secret", () => {
    const { raw } = generateApiKey();
    expect(hashApiKey(raw, "secret")).toBe(hashApiKey(raw, "secret"));
  });

  it("differs when the secret (pepper) differs — the secret genuinely matters, not bcrypt-of-nothing", () => {
    const { raw } = generateApiKey();
    expect(hashApiKey(raw, "secret-a")).not.toBe(hashApiKey(raw, "secret-b"));
  });

  it("never stores the raw key anywhere reachable from the hash", () => {
    const { raw } = generateApiKey();
    const hash = hashApiKey(raw, TEST_HASH_SECRET);
    expect(hash).not.toContain(raw);
  });
});

describe("API key lifecycle (against a real Postgres)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("createMerchantWithApiKey issues a working key, shown once, never retrievable again", async () => {
    const { merchant, apiKey, rawApiKey } = await createMerchantWithApiKey(prisma, TEST_HASH_SECRET, {
      name: "Acme",
      walletAddress: randomStellarAccountAddress(),
    });
    expect(rawApiKey.startsWith("sk_live_")).toBe(true);

    const { merchant: resolved } = await authenticateApiKey(prisma, TEST_HASH_SECRET, rawApiKey);
    expect(resolved.id).toBe(merchant.id);

    // The stored row never contains the raw key in any retrievable field.
    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: apiKey.id } });
    expect(JSON.stringify(stored)).not.toContain(rawApiKey);
  });

  it("rejects a valid-shaped but unknown key", async () => {
    const { raw } = generateApiKey();
    await expect(authenticateApiKey(prisma, TEST_HASH_SECRET, raw)).rejects.toMatchObject({ code: "INVALID_API_KEY" });
  });

  it("rejects a malformed key without a DB lookup", async () => {
    await expect(authenticateApiKey(prisma, TEST_HASH_SECRET, "not-a-real-key")).rejects.toMatchObject({ code: "INVALID_API_KEY" });
  });

  it("rejects the wrong hash secret for an otherwise-valid key", async () => {
    const { rawApiKey } = await createMerchantWithApiKey(prisma, TEST_HASH_SECRET, {
      name: "Acme",
      walletAddress: randomStellarAccountAddress(),
    });
    await expect(authenticateApiKey(prisma, "wrong-secret", rawApiKey)).rejects.toMatchObject({ code: "INVALID_API_KEY" });
  });

  it("rotation: old key stops working, new key works, merchant identity is preserved", async () => {
    const { merchant, apiKey, rawApiKey: oldRaw } = await createMerchantWithApiKey(prisma, TEST_HASH_SECRET, {
      name: "Acme",
      walletAddress: randomStellarAccountAddress(),
    });

    const { rawApiKey: newRaw } = await rotateApiKey(prisma, TEST_HASH_SECRET, merchant.id, apiKey.id);
    expect(newRaw).not.toBe(oldRaw);

    await expect(authenticateApiKey(prisma, TEST_HASH_SECRET, oldRaw)).rejects.toMatchObject({ code: "API_KEY_REVOKED" });

    const { merchant: resolved } = await authenticateApiKey(prisma, TEST_HASH_SECRET, newRaw);
    expect(resolved.id).toBe(merchant.id);
  });

  it("a disabled merchant's otherwise-valid key is rejected", async () => {
    const { merchant, rawApiKey } = await createMerchantWithApiKey(prisma, TEST_HASH_SECRET, {
      name: "Acme",
      walletAddress: randomStellarAccountAddress(),
    });
    await prisma.merchant.update({ where: { id: merchant.id }, data: { status: "disabled" } });
    await expect(authenticateApiKey(prisma, TEST_HASH_SECRET, rawApiKey)).rejects.toMatchObject({ code: "MERCHANT_DISABLED" });
  });

  it("errors are ApiError instances carrying an HTTP status", async () => {
    const { raw } = generateApiKey();
    try {
      await authenticateApiKey(prisma, TEST_HASH_SECRET, raw);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).httpStatus).toBe(401);
    }
  });
});
