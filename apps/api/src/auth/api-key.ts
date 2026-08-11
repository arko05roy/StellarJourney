/**
 * API key issuance, hashing, rotation, and verification (CLAUDE.md §10/§16).
 *
 * Hashing: HMAC-SHA256 with `API_KEY_HASH_SECRET` as the pepper — never a
 * bare hash of the key alone (CLAUDE.md's explicit "not bcrypt-of-nothing"
 * requirement: the secret must matter, so a stolen database dump alone
 * cannot be dictionary-attacked against candidate keys without also having
 * the pepper). The raw key is never stored; only `keyHash` is persisted.
 *
 * Lookup: `keyPrefix` (a short, non-secret slice of the raw key) is an
 * indexed lookup aid so verification doesn't need a full-table scan — it is
 * never used as the actual match. The match itself is a constant-time
 * comparison (`timingSafeEqual`) of the full HMAC digest, so no timing
 * signal about how many hash bytes matched ever reaches an attacker
 * (CLAUDE.md §10 "constant-time comparison").
 *
 * Rotation: issuing a new key and revoking the old one happens in one DB
 * transaction — a caller never observes a state with zero or two active
 * keys for the same rotation.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { badRequest, forbiddenError, unauthorizedError } from "../errors.js";
import type { ApiKey, Merchant, Prisma, PrismaClient } from "../db.js";

const KEY_PREFIX = "sk_live_";
/** Long enough to make the indexed lookup highly selective without being long enough to leak meaningful entropy about the secret. */
const PREFIX_LOOKUP_LENGTH = KEY_PREFIX.length + 8;

export interface GeneratedApiKey {
  raw: string;
  prefix: string;
}

/** Generates a new raw API key. Never persisted in raw form — see {@link hashApiKey}. */
export function generateApiKey(): GeneratedApiKey {
  const raw = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { raw, prefix: raw.slice(0, PREFIX_LOOKUP_LENGTH) };
}

/** HMAC-SHA256(secret, rawKey), hex-encoded. */
export function hashApiKey(raw: string, hashSecret: string): string {
  return createHmac("sha256", hashSecret).update(raw).digest("hex");
}

export interface AuthenticatedMerchant {
  merchant: Merchant;
  apiKey: ApiKey;
}

/**
 * Verifies a raw API key against stored, hashed keys and returns the owning
 * merchant. Throws a 401/403 {@link ApiError} for every failure mode:
 * malformed key, no matching hash, a hash that matches a *revoked* key
 * (distinct code from "no match" — deliberately informative, since a
 * revoked key is a known, named credential, not a guess), or a merchant
 * whose account itself is disabled.
 */
export async function authenticateApiKey(prisma: PrismaClient, hashSecret: string, rawKey: string): Promise<AuthenticatedMerchant> {
  if (!rawKey.startsWith(KEY_PREFIX) || rawKey.length < PREFIX_LOOKUP_LENGTH + 16) {
    throw unauthorizedError("INVALID_API_KEY", "Malformed API key.");
  }

  const prefix = rawKey.slice(0, PREFIX_LOOKUP_LENGTH);
  const computedHash = Buffer.from(hashApiKey(rawKey, hashSecret), "hex");

  // Prefix collisions are astronomically unlikely with 24 random bytes of
  // entropy behind it, but the loop (rather than assuming exactly one row)
  // costs nothing and removes the assumption entirely.
  const candidates = await prisma.apiKey.findMany({ where: { keyPrefix: prefix }, include: { merchant: true } });

  for (const candidate of candidates) {
    const storedHash = Buffer.from(candidate.keyHash, "hex");
    if (storedHash.length === computedHash.length && timingSafeEqual(storedHash, computedHash)) {
      if (candidate.status !== "active") {
        throw unauthorizedError("API_KEY_REVOKED", "This API key has been revoked. Rotate to a new key.");
      }
      if (candidate.merchant.status !== "active") {
        throw forbiddenError("MERCHANT_DISABLED", "This merchant account is disabled.");
      }
      const { merchant, ...apiKey } = candidate;
      return { merchant, apiKey };
    }
  }

  throw unauthorizedError("INVALID_API_KEY", "Invalid API key.");
}

export interface CreateMerchantInput {
  name: string;
  walletAddress: string;
}

export interface IssuedApiKey {
  merchant: Merchant;
  apiKey: ApiKey;
  rawApiKey: string;
}

/** Creates a merchant and issues its first API key. The raw key is returned once and never again — the caller must show it to the merchant now. */
export async function createMerchantWithApiKey(prisma: PrismaClient, hashSecret: string, input: CreateMerchantInput): Promise<IssuedApiKey> {
  const { raw, prefix } = generateApiKey();
  const keyHash = hashApiKey(raw, hashSecret);
  const merchant = await prisma.merchant.create({
    data: {
      name: input.name,
      walletAddress: input.walletAddress,
      apiKeys: { create: { keyPrefix: prefix, keyHash } },
    },
    include: { apiKeys: true },
  });
  const apiKey = merchant.apiKeys[0];
  if (!apiKey) {
    // Unreachable: the nested `create` above always produces exactly one row in the same write.
    throw badRequest("INTERNAL_ERROR", "Merchant created without an API key.");
  }
  return { merchant, apiKey, rawApiKey: raw };
}

export interface RotatedApiKey {
  apiKey: ApiKey;
  rawApiKey: string;
}

/** Revokes `currentApiKeyId` and issues a fresh key for `merchantId`, atomically — a reader can never see zero or two active keys for this merchant mid-rotation. */
export async function rotateApiKey(
  prisma: PrismaClient,
  hashSecret: string,
  merchantId: string,
  currentApiKeyId: string,
): Promise<RotatedApiKey> {
  const { raw, prefix } = generateApiKey();
  const keyHash = hashApiKey(raw, hashSecret);
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.apiKey.update({
      where: { id: currentApiKeyId },
      data: { status: "revoked", revokedAt: new Date() },
    });
    const apiKey = await tx.apiKey.create({
      data: { merchantId, keyPrefix: prefix, keyHash },
    });
    return { apiKey, rawApiKey: raw };
  });
}
