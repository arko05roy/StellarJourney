/**
 * Integration tests for `runIndexerTick` against a real Postgres
 * (`docker-compose.yml`) and a deterministic `FakeChainEventsGateway` — no
 * live Soroban RPC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runIndexerTick, IndexerRetentionGapError } from "./indexer.js";
import { getIndexerCursor } from "./cursor.js";
import { buildLifecycleEvent, cleanDatabase, createMerchant, createTestPrisma, FakeChainEventsGateway, FakeChainGateway } from "../test/helpers.js";
import type { PrismaClient } from "../db.js";
import type { IndexerDeps } from "./indexer.js";

describe("runIndexerTick (real Postgres, fake chain-events gateway)", () => {
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

  // A large default lookback so every test event (regardless of its ledger
  // number relative to the fake gateway's `currentLedger`) falls inside the
  // computed first-run `startLedger` window — only the dedicated "first run"
  // test below cares about the exact lookback arithmetic.
  function deps(events: FakeChainEventsGateway, initialLookbackLedgers = 1_000_000): IndexerDeps {
    return { prisma, events, mandateReader, initialLookbackLedgers, pageLimit: 100 };
  }

  it("first run: starts from currentLedger - lookback, processes events, and persists the cursor", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_created", merchant: merchant.walletAddress, ledger: 9_980 });
    const gateway = new FakeChainEventsGateway([event], 10_000);

    const result = await runIndexerTick(deps(gateway, 50));

    expect(result.processed).toBe(1);
    expect(gateway.calls[0]).toMatchObject({ startLedger: 9_950 }); // 10_000 - 50 lookback
    const cursor = await getIndexerCursor(prisma);
    expect(cursor?.lastLedger).toBe(9_980);
    expect(await prisma.mandateIndex.count()).toBe(1);
    expect(await prisma.webhookDelivery.count()).toBe(1);
  });

  it("resumes from the persisted cursor after a restart — never re-scans from the beginning", async () => {
    const merchant = await createMerchant(prisma);
    const first = buildLifecycleEvent({ kind: "mandate_created", merchant: merchant.walletAddress, ledger: 100 });
    const second = buildLifecycleEvent({ kind: "mandate_paused", merchant: merchant.walletAddress, mandateId: first.mandateId, payer: first.payer, ledger: 200 });
    const gatewayRun1 = new FakeChainEventsGateway([first], 500);
    await runIndexerTick(deps(gatewayRun1));

    // "Restart": a fresh gateway instance, same underlying event stream plus one new event, same DB cursor.
    const gatewayRun2 = new FakeChainEventsGateway([first, second], 500);
    const result = await runIndexerTick(deps(gatewayRun2));

    expect(result.processed).toBe(1); // only the new `second` event — `first` was never re-fetched, since resume used `cursor`, not `startLedger`.
    expect(gatewayRun2.calls[0]).toMatchObject({ cursor: "idx:1" });
    expect(await prisma.webhookDelivery.count()).toBe(2);
  });

  it("idempotent: re-running a tick with no new events past the cursor processes nothing further", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_created", merchant: merchant.walletAddress, ledger: 100 });
    const gateway = new FakeChainEventsGateway([event], 500);

    await runIndexerTick(deps(gateway));
    const second = await runIndexerTick(deps(gateway));

    expect(second.processed).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(1);
  });

  it("processes multiple events in one page strictly in the given (ledger/tx/op) order — same-ledger ordering is deterministic", async () => {
    const merchant = await createMerchant(prisma);
    const mandateId = "e".repeat(64);
    // Both events land in the *same* ledger — order must be exactly as returned by the gateway (created, then paused), never reversed.
    const created = buildLifecycleEvent({ kind: "mandate_created", mandateId, merchant: merchant.walletAddress, ledger: 300, rpcEventId: "300-0" });
    const paused = buildLifecycleEvent({ kind: "mandate_paused", mandateId, merchant: merchant.walletAddress, payer: created.payer, ledger: 300, rpcEventId: "300-1" });
    const gateway = new FakeChainEventsGateway([created, paused], 500);

    await runIndexerTick(deps(gateway));

    const row = await prisma.mandateIndex.findUniqueOrThrow({ where: { mandateId } });
    expect(row.status).toBe("Paused"); // proves `paused` was applied after `created`, not the reverse
    expect(await prisma.webhookDelivery.count()).toBe(2);
  });

  it("two concurrent indexer instances processing overlapping ranges still produce exactly one webhook per on-chain event", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_created", merchant: merchant.walletAddress, ledger: 100 });
    // Two independent gateway instances (simulating two separate relayer
    // processes with their own RPC connections) seeded with the identical
    // event stream, racing against the same DB with no cursor stored yet —
    // both compute an overlapping/identical first-run range.
    const gatewayA = new FakeChainEventsGateway([event], 500);
    const gatewayB = new FakeChainEventsGateway([event], 500);

    await Promise.all([runIndexerTick(deps(gatewayA)), runIndexerTick(deps(gatewayB))]);

    expect(await prisma.webhookDelivery.count({ where: { eventId: `chain:${event.rpcEventId}` } })).toBe(1);
    expect(await prisma.mandateIndex.count()).toBe(1);
    const cursor = await getIndexerCursor(prisma);
    expect(cursor).toBeDefined();
  });

  it("throws IndexerRetentionGapError and does not advance the cursor when the RPC call itself reports the position is gone", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_created", merchant: merchant.walletAddress, ledger: 100 });
    const gateway = new FakeChainEventsGateway([event], 500);
    await runIndexerTick(deps(gateway)); // establishes a stored cursor
    const cursorBefore = await getIndexerCursor(prisma);

    gateway.nextError = new Error("start ledger is before the oldest ledger this RPC server has data for");
    await expect(runIndexerTick(deps(gateway))).rejects.toThrow(IndexerRetentionGapError);

    const cursorAfter = await getIndexerCursor(prisma);
    expect(cursorAfter).toEqual(cursorBefore);
  });

  it("throws IndexerRetentionGapError when a successful response's oldestLedger has advanced past the last processed ledger", async () => {
    const merchant = await createMerchant(prisma);
    const event = buildLifecycleEvent({ kind: "mandate_created", merchant: merchant.walletAddress, ledger: 100 });
    const gateway = new FakeChainEventsGateway([event], 500);
    await runIndexerTick(deps(gateway));

    gateway.oldestLedger = 5_000; // far past the stored lastLedger (100) — ledgers in between were pruned
    await expect(runIndexerTick(deps(gateway))).rejects.toThrow(IndexerRetentionGapError);
  });
});
