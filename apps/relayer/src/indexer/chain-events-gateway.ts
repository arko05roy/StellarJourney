/**
 * The seam between the indexer's polling loop and live Soroban event data —
 * same "narrow interface, fake in tests, thin real wrapper in production"
 * pattern as `../chain-gateway.ts` (CLAUDE.md §20), so every indexer test
 * (idempotency, cursor resume, retention-gap detection, ordering) runs
 * against a deterministic in-memory fake — no live RPC in the default
 * `pnpm test` run.
 */
import { fetchMandateLifecycleEvents, getCurrentLedgerSequence } from "@paymap/stellar";
import type { MandateLifecycleEvent } from "@paymap/contract-client";

export interface ChainEventsPage {
  events: MandateLifecycleEvent[];
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
  pageMaxLedger: number | undefined;
}

export interface ChainEventsGetParams {
  cursor?: string;
  startLedger?: number;
  limit?: number;
}

export interface ChainEventsGateway {
  /** Current chain tip — used only to pick a starting point on the indexer's first-ever run. */
  getCurrentLedger(): Promise<number>;
  getEvents(params: ChainEventsGetParams): Promise<ChainEventsPage>;
}

export interface SorobanChainEventsGatewayOptions {
  rpcUrl: string;
  contractId: string;
}

/** Production `ChainEventsGateway`: real Soroban RPC via `@paymap/stellar`. */
export function createSorobanChainEventsGateway(options: SorobanChainEventsGatewayOptions): ChainEventsGateway {
  return {
    getCurrentLedger: () => getCurrentLedgerSequence(options.rpcUrl),
    getEvents: (params) =>
      fetchMandateLifecycleEvents({
        rpcUrl: options.rpcUrl,
        contractId: options.contractId,
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.startLedger !== undefined ? { startLedger: params.startLedger } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      }),
  };
}
