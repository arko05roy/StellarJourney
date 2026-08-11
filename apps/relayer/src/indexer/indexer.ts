/**
 * One indexer poll cycle (Phase 12c — see this repo's `docs/architecture.md`
 * "On-chain event indexer" section for the full design rationale). Wired
 * into a `setInterval` loop by `scheduler.ts`, exactly mirroring
 * `../scheduler.ts`/`../webhook-scheduler.ts`'s established shape.
 *
 * Order of operations:
 *   1. Read the durable cursor (`cursor.ts`). None yet -> first-ever run.
 *   2. Fetch the next page of lifecycle events — by `cursor` if we have one
 *      (Soroban RPC's own exact continuation position), or by `startLedger`
 *      computed from the current chain tip minus a bounded lookback window
 *      on the very first run (decision: this indexer does not attempt a full
 *      historical backfill beyond a small configurable window — it exists to
 *      keep the index and webhooks current going forward, not to replay
 *      months of history; see docs/architecture.md).
 *   3. **Retention-gap detection (decision #1 — fail loudly, never silently
 *      skip):** two independent checks, since a real 7-day-retention gap can
 *      manifest either as the RPC call itself erroring (heuristically
 *      detected, `isLikelyRetentionGapError`) or — more robustly — as a
 *      successful response whose own `oldestLedger` has advanced past the
 *      last ledger this indexer successfully processed, meaning ledgers in
 *      between were pruned before this indexer could read them. Either
 *      condition throws {@link IndexerRetentionGapError} and the cursor is
 *      *not* advanced, so the next tick fails identically until an operator
 *      intervenes (there is no automatic "skip the gap and continue" path —
 *      that would silently drop events, which is the one thing decision #1
 *      explicitly forbids).
 *   4. Apply every decoded event, strictly in the order the RPC returned
 *      them (already ledger/tx/operation/event-index ordered) —
 *      `mandate-index-sync.ts::applyMandateLifecycleEvent`, one at a time,
 *      each its own DB transaction.
 *   5. Advance the cursor (CAS — see `cursor.ts`).
 */
import type { PrismaClient } from "../db.js";
import type { Logger } from "../pipeline.js";
import type { ChainEventsGateway } from "./chain-events-gateway.js";
import { getIndexerCursor, advanceIndexerCursor, type IndexerCursorState } from "./cursor.js";
import { applyMandateLifecycleEvent, type MandateReader } from "./mandate-index-sync.js";

export const DEFAULT_INITIAL_LOOKBACK_LEDGERS = 100;
export const DEFAULT_PAGE_LIMIT = 100;

const noopLogger: Logger = () => undefined;

/**
 * Thrown when the indexer's stored cursor has fallen outside the RPC's event
 * retention window (~7 days on Soroban testnet/mainnet RPC). A real,
 * documented architectural limit, not a bug — see this module's doc and
 * `docs/architecture.md`. Recovery requires operator judgment (e.g. an
 * archival event source, or accepting the gap and manually resetting the
 * cursor to the current retention floor), which is exactly why this is a
 * loud, distinct, un-auto-retried failure rather than a silent skip.
 */
export class IndexerRetentionGapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexerRetentionGapError";
  }
}

const RETENTION_ERROR_HINTS = ["oldest ledger", "before the oldest", "outside the ledger range", "cursor", "startledger", "start ledger", "ledger range"];

/**
 * Heuristic match on common Soroban RPC error wording for an invalid/pruned
 * `getEvents` position. Best-effort and explicitly documented as such — this
 * repo's own contract was deployed only ~2 days before this indexer was
 * built, so the exact error text a genuinely 7-day-stale cursor produces has
 * not been observed against live infrastructure (see this phase's final
 * report). Any RPC error this heuristic does *not* recognize is still never
 * silently swallowed — it propagates as-is and fails the tick loudly too,
 * just without the more specific `IndexerRetentionGapError` framing.
 */
function isLikelyRetentionGapError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return RETENTION_ERROR_HINTS.some((hint) => message.includes(hint));
}

export interface IndexerDeps {
  prisma: PrismaClient;
  events: ChainEventsGateway;
  mandateReader: MandateReader;
  logger?: Logger;
  initialLookbackLedgers?: number;
  pageLimit?: number;
}

export interface IndexerTickResult {
  processed: number;
}

export async function runIndexerTick(deps: IndexerDeps): Promise<IndexerTickResult> {
  const log = deps.logger ?? noopLogger;
  const stored = await getIndexerCursor(deps.prisma);
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;

  let request: { cursor: string; limit: number } | { startLedger: number; limit: number };
  if (stored) {
    request = { cursor: stored.cursor, limit };
  } else {
    const latest = await deps.events.getCurrentLedger();
    const lookback = deps.initialLookbackLedgers ?? DEFAULT_INITIAL_LOOKBACK_LEDGERS;
    const startLedger = Math.max(1, latest - lookback);
    log("info", "indexer.first_run", { startLedger, latest, lookback });
    request = { startLedger, limit };
  }

  let page;
  try {
    page = await deps.events.getEvents(request);
  } catch (error) {
    if (stored && isLikelyRetentionGapError(error)) {
      throw new IndexerRetentionGapError(
        `Indexer cursor (ledger ${String(stored.lastLedger)}) appears to have fallen outside the RPC's event retention window — cannot resume without a gap. Manual intervention required (see docs/architecture.md's indexer section). Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  }

  if (stored && page.oldestLedger > stored.lastLedger + 1) {
    throw new IndexerRetentionGapError(
      `Indexer cursor (last processed ledger ${String(stored.lastLedger)}) is now behind the RPC's oldest retained ledger (${String(page.oldestLedger)}) — ledgers in between may have been pruned before this indexer could read them.`,
    );
  }

  for (const event of page.events) {
    await applyMandateLifecycleEvent(deps.prisma, event, deps.mandateReader, log);
  }

  const newLastLedger = page.pageMaxLedger ?? stored?.lastLedger ?? ("startLedger" in request ? request.startLedger : page.latestLedger);
  const next: IndexerCursorState = { lastLedger: newLastLedger, cursor: page.cursor };
  await advanceIndexerCursor(deps.prisma, stored, next);

  return { processed: page.events.length };
}
