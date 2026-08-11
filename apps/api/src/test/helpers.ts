/**
 * Shared test infrastructure: a real Prisma client against the Postgres
 * started by `docker-compose.yml` (never mocked — CLAUDE.md's "prove it
 * works" standard), a fake `MandateReader` (no real Soroban RPC in tests —
 * see `chain/mandate-reader.ts`'s module doc), and fixture builders.
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { createPrismaClient, type PrismaClient } from "../db.js";
import { createMerchantWithApiKey } from "../auth/api-key.js";
import type { Mandate, MandateStatus } from "@paymap/contract-client";
import { MandateReadError, type MandateReader } from "../chain/mandate-reader.js";

export const TEST_HASH_SECRET = "test-hash-secret-pepper";

export function createTestPrisma(): PrismaClient {
  return createPrismaClient();
}

/** Deletes every app row, FK-safe order. Called before each test so tests never depend on execution order. */
export async function cleanDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.webhookDelivery.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.refundRequest.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.chargeRequest.deleteMany();
  await prisma.mandateIndex.deleteMany();
  await prisma.checkoutSession.deleteMany();
  await prisma.product.deleteMany();
  await prisma.apiKey.deleteMany();
  await prisma.merchant.deleteMany();
  await prisma.user.deleteMany();
}

export function randomStellarAccountAddress(): string {
  return Keypair.random().publicKey();
}

export function randomStellarContractAddress(): string {
  return StrKey.encodeContract(randomBytes(32));
}

export function randomHexId32(): string {
  return randomBytes(32).toString("hex");
}

/** A fake, in-memory `MandateReader` — tests register canned mandates/refund totals instead of hitting real Soroban RPC. */
export class FakeMandateReader implements MandateReader {
  private readonly mandates = new Map<string, Mandate>();
  private readonly refundedTotals = new Map<string, bigint>();

  setMandate(mandate: Mandate): void {
    this.mandates.set(mandate.id, mandate);
  }

  setRefundedTotal(paymentId: string, total: bigint): void {
    this.refundedTotals.set(paymentId, total);
  }

  async getMandate(mandateId: string): Promise<Mandate> {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) throw new MandateReadError("MandateNotFound");
    return mandate;
  }

  async getRefundedTotal(paymentId: string): Promise<bigint> {
    return this.refundedTotals.get(paymentId) ?? 0n;
  }
}

const DAY_SECONDS = 86_400n;

/** A fully-populated `Mandate` fixture — `Active`, fixed-amount, no charges yet — with every field overridable. */
export function buildMandate(overrides: Partial<Mandate> = {}): Mandate {
  const startAt = overrides.startAt ?? 0n;
  return {
    id: randomHexId32(),
    payer: randomStellarAccountAddress(),
    merchant: randomStellarAccountAddress(),
    asset: randomStellarContractAddress(),
    status: "Active" as MandateStatus,
    // Variable with a very high cap by default so a test overriding only
    // `amount`/`status`/etc. doesn't accidentally trip the fixed-amount
    // check (step 8) before reaching whatever it actually means to test.
    amountRule: { kind: "variable", maxPerCharge: 1_000_000_000_000n },
    maxPerPeriod: 1_000_000_000_000n,
    periodSeconds: DAY_SECONDS * 30n,
    minIntervalSeconds: DAY_SECONDS,
    startAt,
    // Comfortably far out regardless of the calling test's clock — route
    // tests use `buildTestApp`'s fixed 2026 clock while `startAt` here
    // commonly defaults to the Unix epoch; a mere +365 days would already
    // read as expired against that clock. Precheck-unit tests that care
    // about expiry pass an explicit `expiresAt` instead.
    expiresAt: startAt + DAY_SECONDS * 365n * 200n,
    maxSuccessfulCharges: 0,
    successfulCharges: 0,
    totalCollected: 0n,
    currentPeriodStart: startAt,
    currentPeriodCollected: 0n,
    lastChargedAt: undefined,
    createdAt: startAt,
    metadataHash: randomHexId32(),
    ...overrides,
  };
}

export interface TestApp {
  app: FastifyInstance;
  prisma: PrismaClient;
  mandateReader: FakeMandateReader;
  now: Date;
  setNow: (date: Date) => void;
}

/** Builds a Fastify instance wired to a real (cleaned) test database and a fresh `FakeMandateReader`, with an overridable, mutable clock. */
export function buildTestApp(): TestApp {
  const prisma = createTestPrisma();
  const mandateReader = new FakeMandateReader();
  const state = { now: new Date("2026-01-01T00:00:00.000Z") };
  const app = buildApp({
    prisma,
    mandateReader,
    hashSecret: TEST_HASH_SECRET,
    now: () => state.now,
  });
  return {
    app,
    prisma,
    mandateReader,
    get now() {
      return state.now;
    },
    setNow: (date: Date) => {
      state.now = date;
    },
  };
}

export interface TestMerchant {
  merchantId: string;
  walletAddress: string;
  apiKey: string;
  apiKeyId: string;
}

export async function createTestMerchant(prisma: PrismaClient, overrides: { name?: string; walletAddress?: string } = {}): Promise<TestMerchant> {
  const { merchant, apiKey, rawApiKey } = await createMerchantWithApiKey(prisma, TEST_HASH_SECRET, {
    name: overrides.name ?? "Test Merchant",
    walletAddress: overrides.walletAddress ?? randomStellarAccountAddress(),
  });
  return { merchantId: merchant.id, walletAddress: merchant.walletAddress, apiKey: rawApiKey, apiKeyId: apiKey.id };
}

export function authHeader(apiKey: string): { authorization: string } {
  return { authorization: `Bearer ${apiKey}` };
}
