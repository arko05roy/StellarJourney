/**
 * Shared test infrastructure: a real Prisma client against the Postgres
 * started by `docker-compose.yml` (never mocked), plus a deterministic
 * in-memory `FakeChainGateway` (no live Soroban RPC in the default test
 * run) — mirrors `apps/api/src/test/helpers.ts`'s established pattern.
 */
import { randomBytes } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { decodeMandateErrorName, type MandateContractError } from "@paymap/stellar";
import { encryptWebhookSecret, generateWebhookSecret } from "@paymap/shared";
import type { Mandate, PaymentReceipt } from "@paymap/contract-client";
import { MandateReadError } from "@paymap/contract-client";
import { createPrismaClient, type PrismaClient } from "../db.js";
import type { ChainGateway, ChargeArgs, ChargeSubmitResult, PreparedCharge } from "../chain-gateway.js";

export function createTestPrisma(): PrismaClient {
  return createPrismaClient();
}

export const TEST_WEBHOOK_ENCRYPTION_KEY = "relayer-test-webhook-encryption-key";

export interface TestMerchantWithWebhook {
  merchantId: string;
  webhookUrl: string;
  /** The raw (never-stored) secret — only `encryptWebhookSecret(rawSecret, TEST_WEBHOOK_ENCRYPTION_KEY)` is persisted, mirroring production. */
  rawSecret: string;
}

/** Creates a `Merchant` row with a real (encrypted-at-rest) webhook endpoint configured — the fixture `webhook-delivery.test.ts` needs. */
export async function createMerchantWithWebhook(prisma: PrismaClient, webhookUrl: string): Promise<TestMerchantWithWebhook> {
  const rawSecret = generateWebhookSecret();
  const merchant = await prisma.merchant.create({
    data: {
      name: "Test Merchant",
      walletAddress: Keypair.random().publicKey(),
      webhookUrl,
      webhookSecret: encryptWebhookSecret(rawSecret, TEST_WEBHOOK_ENCRYPTION_KEY),
    },
  });
  return { merchantId: merchant.id, webhookUrl, rawSecret };
}

/**
 * Deletes every app row, FK-safe order. This app shares one Postgres
 * database with `apps/api` (`docker-compose.yml`'s single `paymap` DB, per
 * CLAUDE.md §4 — one backend data model, not a duplicate), so this must
 * clean apps/api's tables too (`ApiKey`, `IdempotencyKey`, etc.) — mirrors
 * `apps/api/src/test/helpers.ts::cleanDatabase` exactly, extended for
 * `apps/relayer`'s own model set.
 */
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

export function randomHexId32(): string {
  return randomBytes(32).toString("hex");
}

export function randomStellarAccountAddress(): string {
  return Keypair.random().publicKey();
}

export function randomStellarContractAddress(): string {
  return StrKey.encodeContract(randomBytes(32));
}

const DAY_SECONDS = 86_400n;

export function buildMandate(overrides: Partial<Mandate> = {}): Mandate {
  const startAt = overrides.startAt ?? 0n;
  return {
    id: randomHexId32(),
    payer: randomStellarAccountAddress(),
    merchant: randomStellarAccountAddress(),
    asset: randomStellarContractAddress(),
    status: "Active",
    amountRule: { kind: "variable", maxPerCharge: 1_000_000_000_000n },
    maxPerPeriod: 1_000_000_000_000n,
    periodSeconds: DAY_SECONDS * 30n,
    minIntervalSeconds: DAY_SECONDS,
    startAt,
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

export function buildPaymentReceipt(overrides: Partial<PaymentReceipt> = {}): PaymentReceipt {
  return {
    paymentId: randomHexId32(),
    mandateId: randomHexId32(),
    chargeId: randomHexId32(),
    payer: randomStellarAccountAddress(),
    merchant: randomStellarAccountAddress(),
    asset: randomStellarContractAddress(),
    amount: 1_000_000n,
    invoiceHash: randomHexId32(),
    timestamp: 0n,
    ...overrides,
  };
}

/** Fixtures for a merchant that owns a product + checkout session pointing at a given mandate/asset, plus a `ChargeRequest` for it — the minimum row set `pipeline.ts::resolveChargeContext` needs. */
export interface TestFixture {
  merchantId: string;
  merchantWalletAddress: string;
  assetAddress: string;
  mandateId: string;
}

export async function createMerchantWithMandateContext(
  prisma: PrismaClient,
  overrides: { merchantWalletAddress?: string; assetAddress?: string; mandateId?: string } = {},
): Promise<TestFixture> {
  const merchantWalletAddress = overrides.merchantWalletAddress ?? randomStellarAccountAddress();
  const assetAddress = overrides.assetAddress ?? randomStellarContractAddress();
  const mandateId = overrides.mandateId ?? randomHexId32();

  const merchant = await prisma.merchant.create({
    data: { name: "Test Merchant", walletAddress: merchantWalletAddress },
  });
  const product = await prisma.product.create({
    data: {
      merchantId: merchant.id,
      name: "Test Product",
      assetAddress,
      assetDecimals: 7,
      amountType: "variable",
      maxPerCharge: "1000000000000",
      maxPerPeriod: "1000000000000",
      periodSeconds: 2_592_000,
      minIntervalSeconds: 86_400,
      maxSuccessfulCharges: 0,
      defaultDurationSeconds: 31_536_000,
    },
  });
  await prisma.checkoutSession.create({
    data: {
      merchantId: merchant.id,
      productId: product.id,
      mandateId,
      expiresAt: new Date(Date.now() + 3_600_000),
      status: "completed",
    },
  });

  return { merchantId: merchant.id, merchantWalletAddress, assetAddress, mandateId };
}

export interface CreateChargeRequestOptions {
  scheduledFor?: Date;
  amount?: bigint;
  status?: "scheduled" | "retryable_failed";
  attemptCount?: number;
  nextAttemptAt?: Date;
}

export async function createChargeRequest(
  prisma: PrismaClient,
  fixture: TestFixture,
  options: CreateChargeRequestOptions = {},
): Promise<{ id: string; chargeId: string; invoiceHash: string }> {
  const chargeId = randomHexId32();
  const invoiceHash = randomHexId32();
  const row = await prisma.chargeRequest.create({
    data: {
      merchantId: fixture.merchantId,
      mandateId: fixture.mandateId,
      chargeId,
      amount: (options.amount ?? 1_000_000n).toString(),
      invoiceHash,
      scheduledFor: options.scheduledFor ?? new Date(),
      ...(options.status ? { status: options.status } : {}),
      ...(options.attemptCount !== undefined ? { attemptCount: options.attemptCount } : {}),
      ...(options.nextAttemptAt !== undefined ? { nextAttemptAt: options.nextAttemptAt } : {}),
    },
  });
  return { id: row.id, chargeId, invoiceHash };
}

/**
 * Deterministic in-memory `ChainGateway`. Every test configures
 * `prepareResult`/`submitResult` explicitly (default: reject with
 * `MandateNotFound`, forcing every test to be intentional about what it
 * simulates) — `chargeCallLog`/`submitCallLog` record every invocation so
 * tests can assert exactly how many times the "chain" was touched (the
 * concurrency and verification-mismatch proofs both hinge on this).
 */
export class FakeChainGateway implements ChainGateway {
  private readonly mandates = new Map<string, Mandate>();
  readonly chargeCallLog: ChargeArgs[] = [];
  readonly submitCallLog: ChargeArgs[] = [];

  prepareResult: (args: ChargeArgs) => { ok: true; receipt: PaymentReceipt } | { ok: false; error: MandateContractError } = () => ({
    ok: false,
    error: decodeMandateErrorName("MandateNotFound"),
  });

  submitResult: (args: ChargeArgs) => ChargeSubmitResult | Promise<ChargeSubmitResult> = () => {
    throw new Error("FakeChainGateway.submitResult was not configured for this test");
  };

  setMandate(mandateId: string, mandate: Mandate): void {
    this.mandates.set(mandateId, mandate);
  }

  async getMandate(mandateId: string): Promise<Mandate> {
    const mandate = this.mandates.get(mandateId);
    if (!mandate) throw new MandateReadError("MandateNotFound");
    return mandate;
  }

  async prepareCharge(args: ChargeArgs): Promise<PreparedCharge> {
    this.chargeCallLog.push(args);
    const simulated = this.prepareResult(args);
    return {
      simulated,
      submit: async () => {
        this.submitCallLog.push(args);
        return this.submitResult(args);
      },
    };
  }
}
