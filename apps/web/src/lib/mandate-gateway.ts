/**
 * The dashboard's Soroban gateway: live reads of `get_mandate` (the
 * authoritative source for everything a mandate card displays, CLAUDE.md
 * §2 — never the DB) plus the three payer-authorized lifecycle writes
 * (`pause_mandate`/`resume_mandate`/`revoke_mandate`) and the same bounded
 * `approve`/`allowance` primitives Phase 10's checkout flow uses, reused
 * here for the post-revoke allowance-to-zero prompt (PLAN.md §10.9).
 *
 * Mirrors `lib/chain-gateway.ts`'s shape exactly (constructed once from a
 * public `DeploymentRecord`, signer supplied per call) so
 * `components/dashboard/*` can depend on this narrow interface instead of
 * `@paymap/contract-client`/`@paymap/stellar` directly — same reason: a
 * deterministic stub can stand in for Playwright/component tests with no
 * live wallet or RPC endpoint.
 */
// `./client`/`./domain` subpaths only, never the package root barrel — the
// root also re-exports `./deployment-registry.js` (`node:fs`), which would
// otherwise leak into this Client Component's bundle (see
// `lib/chain-gateway.ts`'s identical comment / `tasks/lessons.md`).
import {
  buildPauseMandate,
  buildResumeMandate,
  buildRevokeMandate,
  createMandateRegistryClient,
  getMandate as getMandateOnChain,
  MandateReadError,
} from "@paymap/contract-client/client";
import type { Mandate } from "@paymap/contract-client/domain";
import type { DeploymentRecord } from "@paymap/contract-client";
import { assertSimulatedOk, buildApprove, computeApprovalLiveUntilLedger, queryAllowance, submitAsInvoker } from "@paymap/stellar";
import { Server as SorobanRpcServer } from "@stellar/stellar-sdk/rpc";
import type { SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";

export { MandateReadError };
export type { Mandate };

export interface MandateSigner {
  publicKey: string;
  signTransaction: SignTransaction;
  signAuthEntry: SignAuthEntry;
}

export interface MandateGateway {
  /** Live, authoritative read — throws {@link MandateReadError} if the mandate doesn't exist. Reflects the contract's own computed (lazy-expiry) status. */
  getMandate(mandateId: string): Promise<Mandate>;
  /** Payer-authorized. Builds, signs (payer), and submits `pause_mandate`. */
  pauseMandate(mandateId: string, signer: MandateSigner): Promise<void>;
  /** Payer-authorized. Builds, signs (payer), and submits `resume_mandate`. */
  resumeMandate(mandateId: string, signer: MandateSigner): Promise<void>;
  /** Payer-authorized. Builds, signs (payer), and submits `revoke_mandate` — immediate, unconditional (PLAN.md §10.9), no merchant approval. */
  revokeMandate(mandateId: string, signer: MandateSigner): Promise<void>;
  /** Current on-chain allowance the payer has granted `spender` (base units). */
  queryAllowance(args: { tokenContractId: string; spender: string }, signer: Pick<MandateSigner, "publicKey">): Promise<bigint>;
  /** Sets the payer's allowance to `amount` (base units) — used both by the checkout flow and, here, the post-revoke "set your allowance to zero" prompt (`amount: 0n`). */
  approve(args: { tokenContractId: string; spender: string; amount: bigint; mandateExpiresAt: bigint }, signer: MandateSigner): Promise<void>;
}

/** Real, production `MandateGateway`. */
export function createStellarMandateGateway(deployment: DeploymentRecord): MandateGateway {
  return {
    async getMandate(mandateId) {
      const client = createMandateRegistryClient(deployment);
      return getMandateOnChain(client, mandateId);
    },

    async pauseMandate(mandateId, signer) {
      const client = createMandateRegistryClient(deployment, {
        publicKey: signer.publicKey,
        signTransaction: signer.signTransaction,
        signAuthEntry: signer.signAuthEntry,
      });
      const tx = await buildPauseMandate(client, mandateId);
      assertSimulatedOk(tx);
      await submitAsInvoker(tx);
    },

    async resumeMandate(mandateId, signer) {
      const client = createMandateRegistryClient(deployment, {
        publicKey: signer.publicKey,
        signTransaction: signer.signTransaction,
        signAuthEntry: signer.signAuthEntry,
      });
      const tx = await buildResumeMandate(client, mandateId);
      assertSimulatedOk(tx);
      await submitAsInvoker(tx);
    },

    async revokeMandate(mandateId, signer) {
      const client = createMandateRegistryClient(deployment, {
        publicKey: signer.publicKey,
        signTransaction: signer.signTransaction,
        signAuthEntry: signer.signAuthEntry,
      });
      const tx = await buildRevokeMandate(client, mandateId);
      assertSimulatedOk(tx);
      await submitAsInvoker(tx);
    },

    async queryAllowance({ tokenContractId, spender }, signer) {
      return queryAllowance(
        {
          tokenContractId,
          networkPassphrase: deployment.networkPassphrase,
          rpcUrl: deployment.rpcUrl,
          publicKey: signer.publicKey,
          allowHttp: deployment.rpcUrl.startsWith("http://"),
        },
        { from: signer.publicKey, spender },
      );
    },

    async approve({ tokenContractId, spender, amount, mandateExpiresAt }, signer) {
      const rpcServer = new SorobanRpcServer(deployment.rpcUrl, { allowHttp: deployment.rpcUrl.startsWith("http://") });
      const latestLedger = await rpcServer.getLatestLedger();
      const nowUnixSeconds = BigInt(Math.floor(Date.now() / 1000));
      const liveUntilLedgerSeq = computeApprovalLiveUntilLedger(latestLedger.sequence, nowUnixSeconds, mandateExpiresAt);

      const tx = await buildApprove(
        {
          tokenContractId,
          networkPassphrase: deployment.networkPassphrase,
          rpcUrl: deployment.rpcUrl,
          publicKey: signer.publicKey,
          signTransaction: signer.signTransaction,
          signAuthEntry: signer.signAuthEntry,
          allowHttp: deployment.rpcUrl.startsWith("http://"),
        },
        { from: signer.publicKey, spender, amount, liveUntilLedgerSeq },
      );
      await tx.signAndSend();
    },
  };
}
