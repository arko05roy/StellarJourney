/**
 * Durable poll-cursor persistence (`IndexerCursor`, `prisma/schema.prisma` —
 * see that model's doc comment for why this is its own table rather than a
 * field on `MandateIndex`). One global row, keyed by {@link INDEXER_CURSOR_ID}.
 *
 * `advanceIndexerCursor` is a compare-and-swap, not a plain write: two
 * relayer processes racing the same indexer tick must never have one
 * silently clobber the other's more-advanced cursor with a stale one. A CAS
 * miss is not an error — it means a concurrent instance already advanced
 * past this point, which is harmless because event processing itself
 * (`mandate-index-sync.ts`) is idempotent regardless of which instance's
 * cursor write "wins" (decision #3: exactly-once webhook production is
 * guaranteed at the event-processing layer, not by cursor ownership).
 */
import { Prisma, type PrismaClient } from "../db.js";

export const INDEXER_CURSOR_ID = "mandate-registry-events";

export interface IndexerCursorState {
  lastLedger: number;
  cursor: string;
}

export async function getIndexerCursor(prisma: PrismaClient): Promise<IndexerCursorState | undefined> {
  const row = await prisma.indexerCursor.findUnique({ where: { id: INDEXER_CURSOR_ID } });
  return row ? { lastLedger: row.lastLedger, cursor: row.cursor } : undefined;
}

export async function advanceIndexerCursor(
  prisma: PrismaClient,
  previous: IndexerCursorState | undefined,
  next: IndexerCursorState,
): Promise<void> {
  if (previous === undefined) {
    try {
      await prisma.indexerCursor.create({ data: { id: INDEXER_CURSOR_ID, lastLedger: next.lastLedger, cursor: next.cursor } });
    } catch (error) {
      // P2002 = unique constraint violation: a concurrent instance already
      // created the row first. Harmless race loss, not a real error.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
    }
    return;
  }

  await prisma.indexerCursor.updateMany({
    where: { id: INDEXER_CURSOR_ID, lastLedger: previous.lastLedger, cursor: previous.cursor },
    data: { lastLedger: next.lastLedger, cursor: next.cursor },
  });
}
