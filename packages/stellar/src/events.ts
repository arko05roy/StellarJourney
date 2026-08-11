/**
 * Thin RPC-access wrapper around `rpc.Server.getEvents()`, scoped to the
 * mandate-registry contract's 5 lifecycle events (Phase 12c indexer). Decodes
 * via `@paymap/contract-client`'s `decodeMandateLifecycleEvent` — this module
 * only owns "how to call the RPC and page through it," never event shape
 * decisions (those live with the contract's own ABI, in `contract-client`).
 */
import { rpc } from "@stellar/stellar-sdk";
// `./events` subpath only, never the package root barrel — the root also
// re-exports `./deployment-registry.js` (`node:fs`/`node:path`/`node:url`),
// which would otherwise leak into any browser bundle that imports a value
// from this module's own package root (`@paymap/stellar`) — see
// `tasks/lessons.md`'s "barrel re-export drags in Node-only sibling" note.
import { decodeMandateLifecycleEvent, type MandateLifecycleEvent } from "@paymap/contract-client/events";

export interface FetchMandateEventsParams {
  rpcUrl: string;
  contractId: string;
  /** Resume from this opaque continuation cursor. Mutually exclusive with `startLedger` (Soroban RPC's own constraint). */
  cursor?: string;
  /** First-ever call only — where no cursor is stored yet. */
  startLedger?: number;
  limit?: number;
}

export interface FetchMandateEventsResult {
  /** Decoded lifecycle events only (already filtered to the 5 kinds this indexer cares about, in the RPC's own ledger/tx/operation order). */
  events: MandateLifecycleEvent[];
  /** Opaque continuation token for the next call's `cursor`. */
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
  /**
   * Highest ledger number seen among *every* raw event this page returned
   * (including ones that decoded to `undefined` — e.g. `charge_succeeded`) —
   * `undefined` if the page was empty. This is the indexer's best-effort
   * high-water mark for retention-gap detection; the actual resume position
   * is always the opaque `cursor` above, never this number.
   */
  pageMaxLedger: number | undefined;
}

/** Real production `getEvents` call, filtered server-side to one contract id. */
export async function fetchMandateLifecycleEvents(params: FetchMandateEventsParams): Promise<FetchMandateEventsResult> {
  const server = new rpc.Server(params.rpcUrl);
  const filters: rpc.Api.EventFilter[] = [{ type: "contract", contractIds: [params.contractId] }];
  const request: rpc.Api.GetEventsRequest =
    params.cursor !== undefined
      ? { filters, cursor: params.cursor, ...(params.limit !== undefined ? { limit: params.limit } : {}) }
      : { filters, startLedger: params.startLedger ?? 0, ...(params.limit !== undefined ? { limit: params.limit } : {}) };

  const response = await server.getEvents(request);

  let pageMaxLedger: number | undefined;
  const events: MandateLifecycleEvent[] = [];
  for (const raw of response.events) {
    if (pageMaxLedger === undefined || raw.ledger > pageMaxLedger) {
      pageMaxLedger = raw.ledger;
    }
    if (!raw.inSuccessfulContractCall) {
      continue;
    }
    const decoded = decodeMandateLifecycleEvent(raw);
    if (decoded !== undefined) {
      events.push(decoded);
    }
  }

  return { events, cursor: response.cursor, latestLedger: response.latestLedger, oldestLedger: response.oldestLedger, pageMaxLedger };
}

/** Current chain tip — used to pick a starting point on the indexer's very first run (no stored cursor yet). */
export async function getCurrentLedgerSequence(rpcUrl: string): Promise<number> {
  const server = new rpc.Server(rpcUrl);
  const info = await server.getLatestLedger();
  return info.sequence;
}
