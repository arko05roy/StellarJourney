/**
 * Integration tests for `applyMandateLifecycleEvent` against a real Postgres
 * (`docker-compose.yml`) — no live Soroban RPC (the `FakeChainGateway`'s
 * `getMandate` map stands in for the cold-start asset-backfill read).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMandateLifecycleEvent } from "./mandate-index-sync.js";
import { buildLifecycleEvent, buildMandate, cleanDatabase, createMerchant, createTestPrisma, FakeChainGateway } from "../test/helpers.js";
import type { PrismaClient } from "../db.js";

describe("applyMandateLifecycleEvent (real Postgres)", () => {
  let prisma: PrismaClient;
  let mandateReader: FakeChainGateway;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
    mandateReader = new FakeChainGateway();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("mandate_created for an unknown merchant creates no MandateIndex row and no webhook", async () => {
    const event = buildLifecycleEvent({ kind: "mandate_created" });

    await applyMandateLifecycleEvent(prisma, event, mandateReader);

    expect(await prisma.mandateIndex.findUnique({ where: { mandateId: event.mandateId } })).toBeNull();
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("mandate_created for a known merchant creates the MandateIndex row and enqueues mandate.active", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_created", merchant: merchant.walletAddress });

    await applyMandateLifecycleEvent(prisma, event, mandateReader);

    const row = await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId: event.mandateId } });
    expect(row.merchantId).toBe(merchant.id);
    expect(row.status).toBe("Active");
    expect(row.payerAddress).toBe(event.payer);
    expect(row.merchantAddress).toBe(merchant.walletAddress);
    expect(row.assetAddress).toBe((event as { asset: string }).asset);
    expect(row.lastIndexedLedger?.toString()).toBe(String(event.ledger));

    const deliveries = await prisma.webhookDelivery.findMany({ where: { merchantId: merchant.id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.eventType).toBe("mandate.active");
    expect(deliveries[0]?.eventId).toBe(`chain:${event.rpcEventId}`);
    expect(deliveries[0]?.payload).toMatchObject({ mandateId: event.mandateId });
  });

  it("a later event on an existing row reuses its stored merchantId and updates status", async () => {
    const merchant = await createMerchant(prisma);
    const mandateId = "a".repeat(64);
    const created = buildLifecycleEvent({ kind: "mandate_created", mandateId, merchant: merchant.walletAddress, ledger: 100 });
    const paused = buildLifecycleEvent({ kind: "mandate_paused", mandateId, merchant: merchant.walletAddress, payer: created.payer, ledger: 101 });

    await applyMandateLifecycleEvent(prisma, created, mandateReader);
    await applyMandateLifecycleEvent(prisma, paused, mandateReader);

    const row = await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId } });
    expect(row.status).toBe("Paused");
    const deliveries = await prisma.webhookDelivery.findMany({ where: { merchantId: merchant.id }, orderBy: { eventType: "asc" } });
    expect(deliveries.map((d) => d.eventType).sort()).toEqual(["mandate.active", "mandate.paused"]);
  });

  it("chain-wins with a monotonic-ledger guard: an out-of-order (older-ledger) event never regresses the row", async () => {
    const merchant = await createMerchant(prisma);
    const mandateId = "b".repeat(64);
    const created = buildLifecycleEvent({ kind: "mandate_created", mandateId, merchant: merchant.walletAddress, ledger: 100 });
    await applyMandateLifecycleEvent(prisma, created, mandateReader);

    // A revoked event from an *earlier* ledger arriving late (e.g. a retried
    // stale poll) must not overwrite the row created from a later ledger.
    const staleRevoked = buildLifecycleEvent({ kind: "mandate_revoked", mandateId, merchant: merchant.walletAddress, payer: created.payer, ledger: 50 });
    await applyMandateLifecycleEvent(prisma, staleRevoked, mandateReader);

    const row = await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId } });
    expect(row.status).toBe("Active");
    expect(row.lastIndexedLedger?.toString()).toBe("100");

    // A genuinely later ledger's revocation does apply.
    const realRevoked = buildLifecycleEvent({ kind: "mandate_revoked", mandateId, merchant: merchant.walletAddress, payer: created.payer, ledger: 150 });
    await applyMandateLifecycleEvent(prisma, realRevoked, mandateReader);
    const rowAfter = await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId } });
    expect(rowAfter.status).toBe("Revoked");
  });

  it("reprocessing the identical event is idempotent — exactly one WebhookDelivery row", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_paused", merchant: merchant.walletAddress });
    // A MandateIndex row must exist first (a paused event with no prior
    // creation event falls back to a chain read for the asset — irrelevant
    // to this test, so seed a plain row directly).
    await prisma.mandateIndex.create({
      data: {
        mandateId: event.mandateId,
        merchantId: merchant.id,
        payerAddress: event.payer,
        merchantAddress: merchant.walletAddress,
        assetAddress: "irrelevant",
        status: "Active",
        lastIndexedLedger: event.ledger - 1,
      },
    });

    await applyMandateLifecycleEvent(prisma, event, mandateReader);
    await applyMandateLifecycleEvent(prisma, event, mandateReader);

    expect(await prisma.webhookDelivery.count({ where: { eventId: `chain:${event.rpcEventId}` } })).toBe(1);
  });

  it("two concurrent applies of the same event still produce exactly one WebhookDelivery row", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_revoked", merchant: merchant.walletAddress });
    await prisma.mandateIndex.create({
      data: {
        mandateId: event.mandateId,
        merchantId: merchant.id,
        payerAddress: event.payer,
        merchantAddress: merchant.walletAddress,
        assetAddress: "irrelevant",
        status: "Active",
        lastIndexedLedger: event.ledger - 1,
      },
    });

    await Promise.all([applyMandateLifecycleEvent(prisma, event, mandateReader), applyMandateLifecycleEvent(prisma, event, mandateReader)]);

    expect(await prisma.webhookDelivery.count({ where: { eventId: `chain:${event.rpcEventId}` } })).toBe(1);
    expect((await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId: event.mandateId } })).status).toBe("Revoked");
  });

  it("merchant isolation: an event for merchant A never enqueues a webhook for unrelated merchant B", async () => {
    const merchantA = await createMerchant(prisma);
    const merchantB = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_created", merchant: merchantA.walletAddress });

    await applyMandateLifecycleEvent(prisma, event, mandateReader);

    expect(await prisma.webhookDelivery.count({ where: { merchantId: merchantA.id } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { merchantId: merchantB.id } })).toBe(0);
  });

  it("mandate_completed updates status to Completed but enqueues no webhook (charge pipeline is the sole producer)", async () => {
    const merchant = await createMerchant(prisma);
    const mandateId = "c".repeat(64);
    const created = buildLifecycleEvent({ kind: "mandate_created", mandateId, merchant: merchant.walletAddress, ledger: 100 });
    await applyMandateLifecycleEvent(prisma, created, mandateReader);

    const completed = buildLifecycleEvent({ kind: "mandate_completed", mandateId, merchant: merchant.walletAddress, payer: created.payer, ledger: 101, successfulCharges: 12 });
    await applyMandateLifecycleEvent(prisma, completed, mandateReader);

    expect((await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId } })).status).toBe("Completed");
    expect(await prisma.webhookDelivery.count({ where: { eventType: "mandate.completed" } })).toBe(0);
  });

  it("does not duplicate mandate.completed when the charge pipeline already enqueued it for the same completion", async () => {
    const merchant = await createMerchant(prisma);
    const mandateId = "d".repeat(64);
    const created = buildLifecycleEvent({ kind: "mandate_created", mandateId, merchant: merchant.walletAddress, ledger: 100 });
    await applyMandateLifecycleEvent(prisma, created, mandateReader);

    // Simulate `pipeline.ts`'s own producer: a random-eventId `mandate.completed` row already enqueued synchronously by the charge pipeline.
    await prisma.webhookDelivery.create({
      data: { merchantId: merchant.id, eventId: "pipeline-produced-completion", eventType: "mandate.completed", payload: { mandateId } },
    });

    const completed = buildLifecycleEvent({ kind: "mandate_completed", mandateId, merchant: merchant.walletAddress, payer: created.payer, ledger: 101 });
    await applyMandateLifecycleEvent(prisma, completed, mandateReader);

    expect(await prisma.webhookDelivery.count({ where: { eventType: "mandate.completed", merchantId: merchant.id } })).toBe(1);
  });

  it("cold start: a non-creation event with no existing MandateIndex row backfills the asset from a fresh chain read, never fabricating it", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_paused", merchant: merchant.walletAddress });
    const onChainMandate = buildMandate({ id: event.mandateId, payer: event.payer, merchant: merchant.walletAddress, status: "Paused" });
    mandateReader.setMandate(event.mandateId, onChainMandate);

    await applyMandateLifecycleEvent(prisma, event, mandateReader);

    const row = await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId: event.mandateId } });
    expect(row.assetAddress).toBe(onChainMandate.asset);
    expect(row.status).toBe("Paused");
  });
});
