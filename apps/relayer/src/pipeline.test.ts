import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeMandateErrorName } from "@paymap/stellar";
import { processChargeRequest, type PipelineDeps } from "./pipeline.js";
import {
  buildMandate,
  buildPaymentReceipt,
  cleanDatabase,
  createChargeRequest,
  createMerchantWithMandateContext,
  createTestPrisma,
  FakeChainGateway,
  randomHexId32,
  type TestFixture,
} from "./test/helpers.js";
import type { PrismaClient } from "./db.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("processChargeRequest", () => {
  let prisma: PrismaClient;
  let gateway: FakeChainGateway;
  let fixture: TestFixture;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
    gateway = new FakeChainGateway();
    fixture = await createMerchantWithMandateContext(prisma);
    gateway.setMandate(
      fixture.mandateId,
      buildMandate({ merchant: fixture.merchantWalletAddress, asset: fixture.assetAddress }),
    );
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function deps(now: Date = NOW): PipelineDeps {
    return { prisma, gateway, now: () => now };
  }

  it("succeeds end-to-end: writes exactly one Payment row (from the confirmed receipt, not optimism) and transitions to succeeded", async () => {
    const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture, {
      amount: 5_000_000n,
    });
    const receipt = buildPaymentReceipt({
      mandateId: fixture.mandateId,
      chargeId,
      invoiceHash,
      merchant: fixture.merchantWalletAddress,
      asset: fixture.assetAddress,
      amount: 5_000_000n,
    });
    gateway.prepareResult = () => ({ ok: true, receipt });
    gateway.submitResult = () => ({
      kind: "success",
      receipt,
      txHash: "real-tx-hash-1",
      ledger: 12345n,
    });

    const outcome = await processChargeRequest(deps(), id);

    expect(outcome).toEqual({
      kind: "succeeded",
      paymentId: receipt.paymentId,
      txHash: "real-tx-hash-1",
    });

    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("succeeded");
    expect(row.transactionHash).toBe("real-tx-hash-1");

    const payments = await prisma.payment.findMany({ where: { mandateId: fixture.mandateId } });
    expect(payments).toHaveLength(1);
    expect(payments[0]?.paymentId).toBe(receipt.paymentId);
    expect(payments[0]?.transactionHash).toBe("real-tx-hash-1");
    expect(payments[0]?.ledger.toString()).toBe("12345");

    const webhooks = await prisma.webhookDelivery.findMany({
      where: { merchantId: fixture.merchantId },
    });
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.eventType).toBe("payment.succeeded");
    expect(webhooks[0]?.status).toBe("pending");
  });

  it("a permanent contract error at simulation (e.g. MandateRevoked) never reaches submit() and writes no Payment row", async () => {
    const { id } = await createChargeRequest(prisma, fixture);
    gateway.prepareResult = () => ({ ok: false, error: decodeMandateErrorName("MandateRevoked") });

    const outcome = await processChargeRequest(deps(), id);

    expect(outcome).toEqual({ kind: "permanently_failed", reason: "MandateRevoked" });
    expect(gateway.submitCallLog).toHaveLength(0);

    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("permanently_failed");
    expect(row.failureCode).toBe("MandateRevoked");

    const payments = await prisma.payment.findMany({ where: { mandateId: fixture.mandateId } });
    expect(payments).toHaveLength(0);

    const webhooks = await prisma.webhookDelivery.findMany({
      where: { merchantId: fixture.merchantId },
    });
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?.eventType).toBe("payment.failed");
  });

  it("a transient contract error at simulation (InsufficientAllowance) schedules a retry at +6h and writes no Payment row", async () => {
    const { id } = await createChargeRequest(prisma, fixture);
    gateway.prepareResult = () => ({
      ok: false,
      error: decodeMandateErrorName("InsufficientAllowance"),
    });

    const outcome = await processChargeRequest(deps(NOW), id);

    expect(outcome.kind).toBe("retry_scheduled");
    if (outcome.kind === "retry_scheduled") {
      expect(outcome.nextAttemptAt).toEqual(new Date(NOW.getTime() + 6 * HOUR));
    }
    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("retryable_failed");
    expect(row.nextAttemptAt).toEqual(new Date(NOW.getTime() + 6 * HOUR));
    expect(await prisma.payment.count()).toBe(0);
    // Transient failures don't fire a webhook yet (not a terminal outcome).
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("an infra failure at submit (RPC_UNAVAILABLE) is transient and writes no Payment row", async () => {
    const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture);
    const receipt = buildPaymentReceipt({
      mandateId: fixture.mandateId,
      chargeId,
      invoiceHash,
      merchant: fixture.merchantWalletAddress,
      asset: fixture.assetAddress,
      amount: 1_000_000n,
    });
    gateway.prepareResult = () => ({ ok: true, receipt });
    gateway.submitResult = () => ({
      kind: "infra_error",
      failure: { failureClass: "transient", reason: "RPC_UNAVAILABLE" },
      message: "network unreachable",
    });

    const outcome = await processChargeRequest(deps(NOW), id);

    expect(outcome).toEqual({
      kind: "retry_scheduled",
      nextAttemptAt: new Date(NOW.getTime() + 6 * HOUR),
      reason: "RPC_UNAVAILABLE",
    });
    expect(await prisma.payment.count()).toBe(0);
  });

  it("an RPC failure during simulation schedules a retry instead of stranding processing", async () => {
    const { id } = await createChargeRequest(prisma, fixture);
    gateway.prepareResult = () => {
      throw new Error("RPC 503");
    };

    const outcome = await processChargeRequest(deps(NOW), id);

    expect(outcome).toEqual({
      kind: "retry_scheduled",
      nextAttemptAt: new Date(NOW.getTime() + 6 * HOUR),
      reason: "RPC_UNAVAILABLE",
    });
    expect((await prisma.chargeRequest.findUniqueOrThrow({ where: { id } })).status).toBe(
      "retryable_failed",
    );
  });

  it("fails closed on an unreadable stored merchant authorization", async () => {
    const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture);
    const authorization = await prisma.chargeAuthorization.create({
      data: {
        merchantId: fixture.merchantId,
        mandateId: fixture.mandateId,
        chargeId,
        amount: "1000000",
        invoiceHash,
        scheduledFor: NOW,
        networkPassphrase: "Test SDF Network ; September 2015",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        unsignedEntryXdr: "unsigned",
        signedEntryCiphertext: "corrupted",
        signatureExpirationLedger: 999999n,
        status: "ready",
      },
    });
    await prisma.chargeRequest.update({
      where: { id },
      data: { authorizationId: authorization.id },
    });

    const outcome = await processChargeRequest(
      { ...deps(NOW), authorizationEncryptionKey: "test-key" },
      id,
    );

    expect(outcome).toEqual({
      kind: "permanently_failed",
      reason: "MERCHANT_AUTHORIZATION_INVALID",
    });
    expect(gateway.chargeCallLog).toHaveLength(0);
  });

  it("retry schedule exhausted (4th attempt) permanently fails instead of scheduling a 5th attempt", async () => {
    const { id } = await createChargeRequest(prisma, fixture, {
      status: "retryable_failed",
      attemptCount: 3,
      nextAttemptAt: NOW,
    });
    gateway.prepareResult = () => ({
      ok: false,
      error: decodeMandateErrorName("InsufficientBalance"),
    });

    const outcome = await processChargeRequest(deps(NOW), id);

    expect(outcome).toEqual({ kind: "permanently_failed", reason: "InsufficientBalance" });
    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("permanently_failed");
    expect(row.attemptCount).toBe(4);
  });

  it("a permanent failure is never retried, even if called again", async () => {
    const { id } = await createChargeRequest(prisma, fixture);
    gateway.prepareResult = () => ({ ok: false, error: decodeMandateErrorName("MandateExpired") });
    await processChargeRequest(deps(), id);

    gateway.chargeCallLog.length = 0;
    const secondOutcome = await processChargeRequest(deps(), id);

    expect(secondOutcome).toEqual({ kind: "skipped_not_claimable" });
    expect(gateway.chargeCallLog).toHaveLength(0);
    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("permanently_failed");
  });

  it("illegal/already-claimed transitions are rejected: processing an already-succeeded request is a no-op, never re-charges", async () => {
    const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture);
    const receipt = buildPaymentReceipt({
      mandateId: fixture.mandateId,
      chargeId,
      invoiceHash,
      merchant: fixture.merchantWalletAddress,
      asset: fixture.assetAddress,
      amount: 1_000_000n,
    });
    gateway.prepareResult = () => ({ ok: true, receipt });
    gateway.submitResult = () => ({ kind: "success", receipt, txHash: "hash-1", ledger: 1n });
    await processChargeRequest(deps(), id);
    expect(await prisma.payment.count()).toBe(1);

    const second = await processChargeRequest(deps(), id);
    expect(second).toEqual({ kind: "skipped_not_claimable" });
    expect(await prisma.payment.count()).toBe(1);
    expect(gateway.submitCallLog).toHaveLength(1);
  });

  describe("relayer cannot alter amount or destination — verification-mismatch proof", () => {
    it("a simulated receipt with a DIFFERENT merchant than the mandate/context is rejected before submit() is ever called", async () => {
      const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture);
      const attackerAddress = fixture.merchantWalletAddress; // baseline, then diverge below
      const wrongMerchantReceipt = buildPaymentReceipt({
        mandateId: fixture.mandateId,
        chargeId,
        invoiceHash,
        merchant: attackerAddress + "-not-really-but-different", // clearly distinct string
        asset: fixture.assetAddress,
        amount: 1_000_000n,
      });
      gateway.prepareResult = () => ({ ok: true, receipt: wrongMerchantReceipt });
      gateway.submitResult = () => {
        throw new Error("must never be called — verification should reject before submission");
      };

      const outcome = await processChargeRequest(deps(), id);

      expect(outcome).toEqual({ kind: "permanently_failed", reason: "SIMULATION_MISMATCH" });
      expect(gateway.submitCallLog).toHaveLength(0);
      expect(await prisma.payment.count()).toBe(0);
    });

    it("a simulated receipt with an ALTERED amount (more than the ChargeRequest asked for) is rejected before submit() is ever called", async () => {
      const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture, {
        amount: 1_000_000n,
      });
      const alteredAmountReceipt = buildPaymentReceipt({
        mandateId: fixture.mandateId,
        chargeId,
        invoiceHash,
        merchant: fixture.merchantWalletAddress,
        asset: fixture.assetAddress,
        amount: 999_000_000n, // wildly more than the 1_000_000n the request asked for
      });
      gateway.prepareResult = () => ({ ok: true, receipt: alteredAmountReceipt });
      gateway.submitResult = () => {
        throw new Error("must never be called — verification should reject before submission");
      };

      const outcome = await processChargeRequest(deps(), id);

      expect(outcome).toEqual({ kind: "permanently_failed", reason: "SIMULATION_MISMATCH" });
      expect(gateway.submitCallLog).toHaveLength(0);
      expect(await prisma.payment.count()).toBe(0);
    });

    it("a simulated receipt against the WRONG asset is rejected before submit() is ever called", async () => {
      const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture);
      const wrongAssetReceipt = buildPaymentReceipt({
        mandateId: fixture.mandateId,
        chargeId,
        invoiceHash,
        merchant: fixture.merchantWalletAddress,
        asset: fixture.assetAddress + "-wrong",
        amount: 1_000_000n,
      });
      gateway.prepareResult = () => ({ ok: true, receipt: wrongAssetReceipt });
      gateway.submitResult = () => {
        throw new Error("must never be called");
      };

      const outcome = await processChargeRequest(deps(), id);
      expect(outcome).toEqual({ kind: "permanently_failed", reason: "SIMULATION_MISMATCH" });
      expect(gateway.submitCallLog).toHaveLength(0);
    });
  });

  it("stale simulation: state changes between simulate and submit (e.g. revoked in between) is handled, never a corrupt Payment row", async () => {
    const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture);
    const receipt = buildPaymentReceipt({
      mandateId: fixture.mandateId,
      chargeId,
      invoiceHash,
      merchant: fixture.merchantWalletAddress,
      asset: fixture.assetAddress,
      amount: 1_000_000n,
    });
    gateway.prepareResult = () => ({ ok: true, receipt });
    // The simulation looked fine, but the *real* submission re-executes the
    // contract for real and the mandate was revoked in the meantime — the
    // contract itself returns a typed Err at that point, with a real tx hash
    // (the transaction genuinely reached the ledger).
    gateway.submitResult = () => ({
      kind: "contract_error",
      error: decodeMandateErrorName("MandateRevoked"),
      txHash: "stale-sim-tx-hash",
    });

    const outcome = await processChargeRequest(deps(), id);

    expect(outcome).toEqual({ kind: "permanently_failed", reason: "MandateRevoked" });
    expect(await prisma.payment.count()).toBe(0);
    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("permanently_failed");
    // The real, genuinely-submitted tx hash is still recorded for audit even though it failed.
    expect(row.transactionHash).toBe("stale-sim-tx-hash");
  });

  describe("duplicate job delivery — at most one successful charge", () => {
    it("two concurrent processChargeRequest calls for the SAME ChargeRequest produce exactly one succeeded outcome, one Payment row, and one on-chain submit() call", async () => {
      const { id, chargeId, invoiceHash } = await createChargeRequest(prisma, fixture, {
        amount: 2_500_000n,
      });
      const receipt = buildPaymentReceipt({
        mandateId: fixture.mandateId,
        chargeId,
        invoiceHash,
        merchant: fixture.merchantWalletAddress,
        asset: fixture.assetAddress,
        amount: 2_500_000n,
      });
      gateway.prepareResult = () => ({ ok: true, receipt });
      // Simulate two independent worker processes: two separate Prisma
      // client connections racing the same guarded DB transition, sharing
      // only the chain gateway (to count real chain-submission calls).
      const prismaWorkerA = createTestPrisma();
      const prismaWorkerB = createTestPrisma();
      gateway.submitResult = () => ({
        kind: "success",
        receipt,
        txHash: "dup-delivery-tx-hash",
        ledger: 42n,
      });

      try {
        const [outcomeA, outcomeB] = await Promise.all([
          processChargeRequest({ prisma: prismaWorkerA, gateway, now: () => NOW }, id),
          processChargeRequest({ prisma: prismaWorkerB, gateway, now: () => NOW }, id),
        ]);

        const outcomes = [outcomeA, outcomeB];
        const succeeded = outcomes.filter((o) => o.kind === "succeeded");
        const skipped = outcomes.filter((o) => o.kind === "skipped_not_claimable");

        expect(succeeded).toHaveLength(1);
        expect(skipped).toHaveLength(1);
        expect(gateway.submitCallLog).toHaveLength(1);

        const payments = await prisma.payment.findMany({ where: { mandateId: fixture.mandateId } });
        expect(payments).toHaveLength(1);
        expect(payments[0]?.paymentId).toBe(receipt.paymentId);

        const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe("succeeded");
      } finally {
        await prismaWorkerA.$disconnect();
        await prismaWorkerB.$disconnect();
      }
    });
  });

  it("MandateNotFound on-chain (mandate never set on the fake gateway) permanently fails without a Payment row", async () => {
    const otherFixture = await createMerchantWithMandateContext(prisma);
    // Deliberately never call gateway.setMandate for this mandate id.
    const { id } = await createChargeRequest(prisma, otherFixture);

    const outcome = await processChargeRequest(deps(), id);

    expect(outcome).toEqual({ kind: "permanently_failed", reason: "MandateNotFound" });
    expect(gateway.chargeCallLog).toHaveLength(0);
  });

  it("a mandate whose on-chain merchant differs from this merchant's own records is rejected as a mismatch, never charged", async () => {
    const otherFixture = await createMerchantWithMandateContext(prisma);
    gateway.setMandate(
      otherFixture.mandateId,
      buildMandate({ merchant: randomHexId32(), asset: otherFixture.assetAddress }),
    );
    const { id } = await createChargeRequest(prisma, otherFixture);

    const outcome = await processChargeRequest(deps(), id);

    expect(outcome).toEqual({ kind: "permanently_failed", reason: "SIMULATION_MISMATCH" });
    expect(gateway.chargeCallLog).toHaveLength(0);
  });
});
