/**
 * The seam between this API and live on-chain state (CLAUDE.md §2 — "never
 * trust backend mandate status without verifying on-chain state before a
 * charge"). Routes depend on this narrow interface, never on
 * `@paymap/contract-client` directly, so tests can inject a fake reader
 * with canned mandate states instead of hitting real Soroban RPC — the
 * production implementation (`createChainMandateReader`) is a thin wrapper
 * over `@paymap/contract-client`'s own read-only helpers, which do the real
 * simulation-backed contract reads.
 */
import {
  createMandateRegistryClient,
  getMandate as getMandateOnChain,
  getRefundedTotal as getRefundedTotalOnChain,
  MandateReadError,
  type DeploymentRecord,
  type Mandate,
} from "@paymap/contract-client";

export { MandateReadError };
export type { Mandate };

export interface MandateReader {
  /** Throws {@link MandateReadError} if the mandate doesn't exist. Reflects the contract's own computed (lazy-expiry) status — never a stale DB copy. */
  getMandate(mandateId: string): Promise<Mandate>;
  /** Cumulative on-chain refunded total for a payment (`0n` if none). */
  getRefundedTotal(paymentId: string): Promise<bigint>;
}

export function createChainMandateReader(deployment: DeploymentRecord): MandateReader {
  const client = createMandateRegistryClient(deployment);
  return {
    getMandate: (mandateId: string) => getMandateOnChain(client, mandateId),
    getRefundedTotal: (paymentId: string) => getRefundedTotalOnChain(client, paymentId),
  };
}
