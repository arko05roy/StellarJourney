/**
 * The checkout flow's real Soroban gateway: builds and submits
 * `create_mandate` (mandate-registry) and `approve` (the payer's bounded
 * SAC allowance). Deployment info (contract id, network passphrase, RPC
 * URL) is fixed at construction (it's public, loaded server-side from
 * `deployments/<network>.json` and passed down as props — see
 * `app/checkout/[sessionId]/page.tsx`), but the signer is supplied per call
 * instead of at construction: the payer's address/signing callbacks are
 * only known *after* `WalletAdapter.connect()` resolves, which happens
 * later than this gateway is constructed.
 *
 * This is the one seam `components/checkout/checkout-flow.tsx` depends on
 * instead of importing `@paymap/contract-client`/`@paymap/stellar`
 * directly, so the component's state-machine logic is testable without a
 * live wallet or RPC endpoint (a deterministic stub implements the same
 * interface for the Playwright happy-path test — see `lib/test-stubs.ts`).
 */
// Imported from the `./client`/`./domain` subpaths, not the package root —
// the root barrel also re-exports `./deployment-registry.js` (a Node-only,
// `node:fs`-reading module), which a browser bundler would otherwise pull
// into this Client Component's bundle. See `packages/contract-client/src/index.ts`'s doc comment.
import { buildCreateMandate, createMandateRegistryClient } from "@paymap/contract-client/client";
import { idToHex, type MandateInput } from "@paymap/contract-client/domain";
import type { DeploymentRecord } from "@paymap/contract-client";
import { assertSimulatedOk, buildApprove, computeApprovalLiveUntilLedger, queryAllowance, submitAsInvoker } from "@paymap/stellar";
import { Server as SorobanRpcServer } from "@stellar/stellar-sdk/rpc";
import type { SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";

export interface WalletSigner {
  publicKey: string;
  signTransaction: SignTransaction;
  signAuthEntry: SignAuthEntry;
}

export interface ChainGateway {
  /** Builds, signs (payer), and submits `create_mandate`. Returns the derived `mandate_id` as lowercase hex. */
  createMandate(input: MandateInput, signer: WalletSigner): Promise<{ mandateId: string }>;
  /** Builds, signs (payer), and submits a bounded `approve` on the product's asset contract, scoping the approval's own ledger-based expiry to the mandate's `expiresAt` (never unlimited in amount or time — CLAUDE.md §2). */
  approve(args: { tokenContractId: string; spender: string; amount: bigint; mandateExpiresAt: bigint }, signer: WalletSigner): Promise<void>;
  /** Current on-chain allowance the payer has granted `spender` — used by the allowance-change flow to confirm a zeroing `approve` actually landed before requesting the new amount (PLAN.md §10.10). */
  queryAllowance(args: { tokenContractId: string; spender: string }, signer: Pick<WalletSigner, "publicKey">): Promise<bigint>;
}

/** Real, production `ChainGateway`. */
export function createStellarChainGateway(deployment: DeploymentRecord): ChainGateway {
  const rpcServer = new SorobanRpcServer(deployment.rpcUrl, { allowHttp: deployment.rpcUrl.startsWith("http://") });

  return {
    async createMandate(input, signer) {
      const client = createMandateRegistryClient(deployment, {
        publicKey: signer.publicKey,
        signTransaction: signer.signTransaction,
        signAuthEntry: signer.signAuthEntry,
      });
      const tx = await buildCreateMandate(client, input);
      assertSimulatedOk(tx);
      const sent = await submitAsInvoker(tx);
      return { mandateId: idToHex(sent.result.unwrap()) };
    },

    async approve({ tokenContractId, spender, amount, mandateExpiresAt }, signer) {
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
  };
}
