import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { Merchant, MerchantSession, PrismaClient } from "../db.js";
import { conflictError, forbiddenError, unauthorizedError } from "../errors.js";

const SIGNED_MESSAGE_PREFIX = "Stellar Signed Message:\n";
const SESSION_PREFIX = "pms_live_";
const SESSION_LOOKUP_LENGTH = SESSION_PREFIX.length + 8;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface MerchantAuthChallenge {
  id: string;
  message: string;
  networkPassphrase: string;
  expiresAt: Date;
}

export interface AuthenticatedMerchantSession {
  session: MerchantSession;
  merchant?: Merchant;
}

function signedMessageDigest(message: string): Buffer {
  return createHash("sha256")
    .update(SIGNED_MESSAGE_PREFIX, "utf8")
    .update(message, "utf8")
    .digest();
}

function sessionHash(rawToken: string, hashSecret: string): string {
  return createHmac("sha256", hashSecret)
    .update("paymap:merchant-session:v1:")
    .update(rawToken)
    .digest("hex");
}

function buildChallengeMessage(input: {
  walletAddress: string;
  networkPassphrase: string;
  domain: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  return [
    "Paymap merchant authentication",
    "",
    `Wallet: ${input.walletAddress}`,
    `Network: ${input.networkPassphrase}`,
    `Domain: ${input.domain}`,
    `Challenge: ${input.nonce}`,
    `Issued at: ${input.issuedAt.toISOString()}`,
    `Expires at: ${input.expiresAt.toISOString()}`,
    "",
    "Signing proves wallet ownership. It does not submit a transaction or move funds.",
  ].join("\n");
}

function generateSessionToken(): { raw: string; prefix: string } {
  const raw = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, prefix: raw.slice(0, SESSION_LOOKUP_LENGTH) };
}

export async function createMerchantAuthChallenge(
  prisma: PrismaClient,
  input: {
    walletAddress: string;
    networkPassphrase: string;
    domain: string;
    now: Date;
  },
): Promise<MerchantAuthChallenge> {
  const expiresAt = new Date(input.now.getTime() + CHALLENGE_TTL_MS);
  const message = buildChallengeMessage({
    walletAddress: input.walletAddress,
    networkPassphrase: input.networkPassphrase,
    domain: input.domain,
    nonce: randomBytes(32).toString("base64url"),
    issuedAt: input.now,
    expiresAt,
  });
  const challenge = await prisma.merchantAuthChallenge.create({
    data: {
      walletAddress: input.walletAddress,
      networkPassphrase: input.networkPassphrase,
      messageHash: signedMessageDigest(message).toString("hex"),
      expiresAt,
    },
  });
  return {
    id: challenge.id,
    message,
    networkPassphrase: input.networkPassphrase,
    expiresAt,
  };
}

function decodeSignature(signature: string): Buffer {
  const decoded = Buffer.from(signature, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== signature) {
    throw unauthorizedError("INVALID_WALLET_SIGNATURE", "Wallet signature is invalid.");
  }
  return decoded;
}

export async function completeMerchantAuthChallenge(
  prisma: PrismaClient,
  hashSecret: string,
  input: {
    challengeId: string;
    message: string;
    signature: string;
    signerAddress: string;
    now: Date;
  },
): Promise<{
  rawSessionToken: string;
  expiresAt: Date;
  profileRequired: boolean;
  merchant?: Merchant;
}> {
  const challenge = await prisma.merchantAuthChallenge.findUnique({
    where: { id: input.challengeId },
  });
  if (!challenge) {
    throw unauthorizedError("INVALID_AUTH_CHALLENGE", "Authentication challenge is invalid.");
  }
  if (challenge.usedAt) {
    throw conflictError("AUTH_CHALLENGE_USED", "Authentication challenge was already used.");
  }
  if (challenge.expiresAt.getTime() <= input.now.getTime()) {
    throw unauthorizedError("AUTH_CHALLENGE_EXPIRED", "Authentication challenge expired.");
  }
  if (challenge.walletAddress !== input.signerAddress) {
    throw unauthorizedError(
      "WALLET_ADDRESS_MISMATCH",
      "The wallet that signed does not match the connected wallet.",
    );
  }

  const expectedDigest = Buffer.from(challenge.messageHash, "hex");
  const submittedDigest = signedMessageDigest(input.message);
  if (
    expectedDigest.length !== submittedDigest.length ||
    !timingSafeEqual(expectedDigest, submittedDigest)
  ) {
    throw unauthorizedError("INVALID_AUTH_CHALLENGE", "Authentication challenge was altered.");
  }

  let signatureValid = false;
  try {
    signatureValid = Keypair.fromPublicKey(input.signerAddress).verify(
      submittedDigest,
      decodeSignature(input.signature),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw unauthorizedError("INVALID_WALLET_SIGNATURE", "Wallet signature is invalid.");
  }

  const token = generateSessionToken();
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_MS);
  const result = await prisma.$transaction(async (tx) => {
    const consumed = await tx.merchantAuthChallenge.updateMany({
      where: {
        id: challenge.id,
        usedAt: null,
        expiresAt: { gt: input.now },
      },
      data: { usedAt: input.now },
    });
    if (consumed.count !== 1) {
      throw conflictError("AUTH_CHALLENGE_USED", "Authentication challenge was already used.");
    }
    const merchant = await tx.merchant.findUnique({
      where: { walletAddress: input.signerAddress },
    });
    await tx.merchantSession.create({
      data: {
        merchantId: merchant?.id ?? null,
        walletAddress: input.signerAddress,
        tokenPrefix: token.prefix,
        tokenHash: sessionHash(token.raw, hashSecret),
        expiresAt,
      },
    });
    return merchant;
  });

  return {
    rawSessionToken: token.raw,
    expiresAt,
    profileRequired: result === null,
    ...(result ? { merchant: result } : {}),
  };
}

export async function authenticateMerchantSession(
  prisma: PrismaClient,
  hashSecret: string,
  rawToken: string,
  now: Date,
  options: { allowPendingProfile?: boolean } = {},
): Promise<AuthenticatedMerchantSession> {
  if (!rawToken.startsWith(SESSION_PREFIX) || rawToken.length < SESSION_LOOKUP_LENGTH + 16) {
    throw unauthorizedError("INVALID_MERCHANT_SESSION", "Merchant session is invalid.");
  }
  const tokenPrefix = rawToken.slice(0, SESSION_LOOKUP_LENGTH);
  const computedHash = Buffer.from(sessionHash(rawToken, hashSecret), "hex");
  const candidates = await prisma.merchantSession.findMany({
    where: { tokenPrefix },
    include: { merchant: true },
  });
  for (const candidate of candidates) {
    const storedHash = Buffer.from(candidate.tokenHash, "hex");
    if (storedHash.length !== computedHash.length || !timingSafeEqual(storedHash, computedHash)) {
      continue;
    }
    if (candidate.revokedAt || candidate.expiresAt.getTime() <= now.getTime()) {
      throw unauthorizedError("MERCHANT_SESSION_EXPIRED", "Merchant session expired.");
    }
    if (!candidate.merchant) {
      if (!options.allowPendingProfile) {
        throw forbiddenError(
          "MERCHANT_PROFILE_REQUIRED",
          "Complete your merchant profile before continuing.",
        );
      }
      return { session: candidate };
    }
    if (candidate.merchant.status !== "active") {
      throw forbiddenError("MERCHANT_DISABLED", "This merchant account is disabled.");
    }
    if (
      candidate.lastUsedAt === null ||
      now.getTime() - candidate.lastUsedAt.getTime() >= 60 * 60 * 1000
    ) {
      await prisma.merchantSession.update({
        where: { id: candidate.id },
        data: { lastUsedAt: now },
      });
    }
    return { session: candidate, merchant: candidate.merchant };
  }
  throw unauthorizedError("INVALID_MERCHANT_SESSION", "Merchant session is invalid.");
}

export async function registerVerifiedMerchant(
  prisma: PrismaClient,
  session: MerchantSession,
  name: string,
): Promise<Merchant> {
  if (session.merchantId) {
    return prisma.merchant.findUniqueOrThrow({ where: { id: session.merchantId } });
  }
  return prisma.$transaction(async (tx) => {
    const merchant = await tx.merchant.upsert({
      where: { walletAddress: session.walletAddress },
      update: {},
      create: { name, walletAddress: session.walletAddress },
    });
    await tx.merchantSession.update({
      where: { id: session.id },
      data: { merchantId: merchant.id },
    });
    return merchant;
  });
}

export async function revokeMerchantSession(
  prisma: PrismaClient,
  sessionId: string,
  now: Date,
): Promise<void> {
  await prisma.merchantSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now },
  });
}
