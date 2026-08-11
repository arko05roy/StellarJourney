/**
 * `setInterval`-driven poll loop around `runIndexerTick` — mirrors
 * `../scheduler.ts`/`../webhook-scheduler.ts`'s exact shape. A retention gap
 * (`IndexerRetentionGapError`) is logged loudly at `"error"` level and the
 * loop keeps running — the next tick will hit the identical failure again
 * (the cursor never advances past a gap), which is the intended "keep
 * failing loudly until an operator resolves it" behavior (decision #1),
 * rather than crashing the whole relayer process or silently skipping ahead.
 */
import type { IndexerDeps } from "./indexer.js";
import { runIndexerTick, IndexerRetentionGapError } from "./indexer.js";

export function startIndexerScheduler(deps: IndexerDeps, intervalMs = 15_000): () => void {
  const log = deps.logger ?? ((): void => undefined);
  const tick = (): void => {
    runIndexerTick(deps).catch((error: unknown) => {
      if (error instanceof IndexerRetentionGapError) {
        log("error", "indexer.retention_gap", { message: error.message });
        return;
      }
      log("error", "indexer.tick_failed", { message: error instanceof Error ? error.message : String(error) });
    });
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
  };
}
