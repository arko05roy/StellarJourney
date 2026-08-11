/**
 * Applies one decoded {@link MandateLifecycleEvent} to the database: an
 * atomic, chain-wins `MandateIndex` upsert plus (for 4 of the 5 events) a
 * deterministic webhook enqueue, both in one Postgres transaction.
 *
 * ## Merchant resolution and isolation (decision #6)
 *
 * An event only ever notifies the merchant the mandate actually belongs to.
 * Resolution order:
 *   1. If a `MandateIndex` row already exists for this `mandateId`, its
 *      `merchantId` is authoritative (set once, at creation, from the
 *      verified on-chain `merchant` address — never re-derived from a
 *      lookup that could resolve differently later).
 *   2. Otherwise, resolve by the event's own `merchant` address against
 *      `Merchant.walletAddress`. If no `Merchant` row matches, this event
 *      cannot be attributed to anyone in this system (e.g. a mandate created
 *      entirely out-of-band, for a wallet address this deployment has never
 *      seen as a merchant) — logged and skipped: no `MandateIndex` row is
 *      created (its `merchantId` is a required FK, so there is nothing valid
 *      to point it at) and no webhook is sent to anyone.
 *
 * ## Chain-wins, monotonic-ledger upsert (decision #4)
 *
 * `upsertMandateIndexFromEvent` is one atomic `INSERT ... ON CONFLICT ...
 * DO UPDATE ... WHERE` statement (Postgres-native upsert, race-safe under
 * concurrent overlapping indexers — no read-then-write gap). The `WHERE`
 * guards against regression: an update is only applied when the incoming
 * event's ledger is at or after the row's current `lastIndexedLedger`, so
 * reprocessing an already-applied (or older) event is a safe no-op rather
 * than an accidental rollback to stale state.
 *
 * ## `mandate_completed`: indexed, never re-notified (decision #8)
 *
 * `apps/relayer/src/pipeline.ts` already enqueues `mandate.completed`
 * synchronously, in the same DB transaction as the charge that completed the
 * mandate — strictly more timely than this indexer's polling could ever be,
 * and already covered by its own tests. This module still updates
 * `MandateIndex.status` to `"Completed"` when it observes the on-chain
 * `mandate_completed` event (chain remains the source of truth for status),
 * but deliberately emits **no** webhook for it — `EVENT_TO_WEBHOOK` has no
 * entry for `"mandate_completed"`. The charge pipeline is the sole producer
 * of `mandate.completed`; this is what prevents a duplicate rather than
 * relying on eventId collision (the pipeline's `eventId` is a fresh
 * `randomUUID()` per call, not derived from chain coordinates, so it could
 * never collide with this indexer's deterministic id anyway).
 */
import type { PrismaClient, Prisma } from "../db.js";
import type { MandateLifecycleEvent, MandateLifecycleEventKind } from "@paymap/contract-client";
import type { WebhookEventType } from "@paymap/api/dist/schemas/webhooks.js";
import type { ChainGateway } from "../chain-gateway.js";
import { enqueueDeterministicWebhook } from "../webhook.js";
import type { Logger } from "../pipeline.js";

const noopLogger: Logger = () => undefined;

/** `undefined` for `mandate_completed` — see this module's doc for why. */
const EVENT_TO_WEBHOOK: Readonly<Record<MandateLifecycleEventKind, WebhookEventType | undefined>> = {
  mandate_created: "mandate.active",
  mandate_paused: "mandate.paused",
  mandate_resumed: "mandate.resumed",
  mandate_revoked: "mandate.revoked",
  mandate_completed: undefined,
};

const EVENT_TO_STATUS: Readonly<Record<MandateLifecycleEventKind, string>> = {
  mandate_created: "Active",
  mandate_paused: "Paused",
  mandate_resumed: "Active",
  mandate_revoked: "Revoked",
  mandate_completed: "Completed",
};

/** A mandate reader capable of a fresh on-chain `get_mandate` — reuses `ChainGateway`'s existing method, never a second RPC client. */
export type MandateReader = Pick<ChainGateway, "getMandate">;

interface ResolvedMerchant {
  merchantId: string;
}

async function resolveMerchant(prisma: PrismaClient, event: MandateLifecycleEvent): Promise<ResolvedMerchant | undefined> {
  const existing = await prisma.mandateIndex.findUnique({ where: { mandateId: event.mandateId }, select: { merchantId: true } });
  if (existing) {
    return { merchantId: existing.merchantId };
  }
  const merchant = await prisma.merchant.findFirst({ where: { walletAddress: event.merchant }, select: { id: true } });
  return merchant ? { merchantId: merchant.id } : undefined;
}

/**
 * Resolves the asset address to store for a fresh `MandateIndex` row.
 * `mandate_created` carries it directly; any other event kind observed
 * before this indexer ever saw that mandate's creation (a genuine cold-start
 * case — e.g. the indexer's lookback window started after creation, or a
 * mandate created before the indexer ever ran) requires one fresh on-chain
 * read, since `MandateIndex.assetAddress` is a required column and this
 * module never invents a placeholder value (decision #4 — chain is the only
 * source of truth, including for backfilling a row this indexer is creating
 * for the first time).
 */
async function resolveAssetAddressForNewRow(mandateReader: MandateReader, event: MandateLifecycleEvent): Promise<string> {
  if (event.kind === "mandate_created") {
    return event.asset;
  }
  const mandate = await mandateReader.getMandate(event.mandateId);
  return mandate.asset;
}

async function upsertMandateIndexFromEvent(
  tx: Prisma.TransactionClient,
  event: MandateLifecycleEvent,
  merchant: ResolvedMerchant,
  mandateReader: MandateReader,
): Promise<void> {
  const status = EVENT_TO_STATUS[event.kind];
  const existing = await tx.mandateIndex.findUnique({ where: { mandateId: event.mandateId }, select: { assetAddress: true } });
  const assetAddress = existing?.assetAddress ?? (await resolveAssetAddressForNewRow(mandateReader, event));
  const now = new Date();

  await tx.$executeRaw`
    INSERT INTO "MandateIndex"
      ("mandateId", "merchantId", "payerAddress", "merchantAddress", "assetAddress", "status", "contractStateVersion", "lastIndexedLedger", "lastIndexedAt", "createdAt")
    VALUES
      (${event.mandateId}, ${merchant.merchantId}, ${event.payer}, ${event.merchant}, ${assetAddress}, ${status}, 1, ${event.ledger}, ${now}, ${now})
    ON CONFLICT ("mandateId") DO UPDATE SET
      "merchantId" = EXCLUDED."merchantId",
      "payerAddress" = EXCLUDED."payerAddress",
      "merchantAddress" = EXCLUDED."merchantAddress",
      "assetAddress" = EXCLUDED."assetAddress",
      "status" = EXCLUDED."status",
      "contractStateVersion" = "MandateIndex"."contractStateVersion" + 1,
      "lastIndexedLedger" = EXCLUDED."lastIndexedLedger",
      "lastIndexedAt" = EXCLUDED."lastIndexedAt"
    WHERE "MandateIndex"."lastIndexedLedger" IS NULL OR "MandateIndex"."lastIndexedLedger" <= EXCLUDED."lastIndexedLedger"
  `;
}

function buildWebhookPayload(event: MandateLifecycleEvent): Record<string, unknown> {
  const base = { mandateId: event.mandateId, payerAddress: event.payer, merchantAddress: event.merchant };
  if (event.kind === "mandate_created") {
    return { ...base, assetAddress: event.asset };
  }
  return base;
}

/**
 * Applies one lifecycle event: resolves the owning merchant, then atomically
 * upserts `MandateIndex` and (if this event kind maps to one) enqueues the
 * webhook — both in a single transaction so a crash between the two writes
 * can never leave one applied without the other.
 */
export async function applyMandateLifecycleEvent(
  prisma: PrismaClient,
  event: MandateLifecycleEvent,
  mandateReader: MandateReader,
  logger: Logger = noopLogger,
): Promise<void> {
  const merchant = await resolveMerchant(prisma, event);
  if (!merchant) {
    logger("warn", "indexer.unknown_merchant", { mandateId: event.mandateId, merchantAddress: event.merchant, kind: event.kind, rpcEventId: event.rpcEventId });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await upsertMandateIndexFromEvent(tx, event, merchant, mandateReader);
    const eventType = EVENT_TO_WEBHOOK[event.kind];
    if (eventType !== undefined) {
      await enqueueDeterministicWebhook(tx, {
        merchantId: merchant.merchantId,
        eventId: `chain:${event.rpcEventId}`,
        eventType,
        payload: buildWebhookPayload(event),
      });
    }
  });

  logger("info", "indexer.event_applied", { mandateId: event.mandateId, kind: event.kind, ledger: event.ledger, rpcEventId: event.rpcEventId });
}
