/**
 * The seam between the relayer's pipeline logic and live Soroban state
 * (mirrors `apps/api/src/chain/mandate-reader.ts`'s "narrow interface, fake
 * in tests, thin real wrapper in production" pattern — CLAUDE.md §20's
 * "don't duplicate business rules", applied to test infrastructure too).
 * `pipeline.ts` depends only on {@link ChainGateway}, never on
 * `@paymap/contract-client`/`@paymap/stellar` directly, so every
 * Postgres+Redis integration test in this app (duplicate delivery,
 * classification, stale simulation, "relayer can't alter amount/
 * destination") runs against a deterministic in-memory fake — no live RPC
 * anywhere in the default `pnpm test` run.
 *
 * ## The one open trust-model question this phase surfaces
 *
 * `contracts/mandate-registry/src/charge.rs` requires
 * `mandate.merchant.require_auth()` on *every* `charge` call — never the
 * relayer, by design. Phases 1-8 never defined how a merchant's signature
 * for a specific, server-generated `charge_id` reaches this untrusted
 * process without it custodying a merchant secret key (which would violate
 * the "relayer has zero spending authority" invariant this whole phase
 * exists to prove). This is flagged, not silently resolved:
 * `resolveMerchantSigner` is an injected seam so a future phase can plug in
 * the real mechanism (most likely: the merchant's own backend pre-signs the
 * specific auth entry at charge-request time and the API persists the
 * signed XDR for the relayer to attach — never a raw key) without touching
 * pipeline logic. For *this* phase's required real-testnet proof, the
 * demo/production entrypoint supplies the same known demo merchant identity
 * `scripts/create-demo-mandate.ts` already uses (Phase 7) — see
 * `docs/threat-model.md`'s "merchant charge authorization" entry.
 */
import { SentTransaction } from "@stellar/stellar-sdk/contract";
import {
  buildCharge,
  createMandateRegistryClient,
  getMandate as getMandateOnChain,
  toDomainPaymentReceipt,
  type DeploymentRecord,
  type Mandate,
  type PaymentReceipt,
} from "@paymap/contract-client";
import { decodeMandateErrorFromResult, submitAsRelayer, type KeypairSigner, type MandateContractError } from "@paymap/stellar";
import { classifyInfraFailure, type ClassifiedFailure } from "./classify.js";

export interface ChargeArgs {
  mandateId: string;
  chargeId: string;
  amount: bigint;
  invoiceHash: string;
}

export type ChargeSubmitResult =
  | { kind: "success"; receipt: PaymentReceipt; txHash: string; ledger: bigint }
  // `txHash` is present whenever the transaction genuinely reached the
  // ledger and was executed (a "stale simulation" case — e.g. the mandate
  // was revoked between simulate and submit — surfaces here with a real
  // hash worth recording for audit, even though no `Payment` row is ever
  // written for it).
  | { kind: "contract_error"; error: MandateContractError; txHash?: string }
  | { kind: "infra_error"; failure: ClassifiedFailure; message: string };

export interface PreparedCharge {
  /** The already-simulated outcome (built when `prepareCharge` was called) — inspect this before ever calling `submit()`. */
  readonly simulated: { readonly ok: true; readonly receipt: PaymentReceipt } | { readonly ok: false; readonly error: MandateContractError };
  /** Signs (merchant auth entry + relayer envelope) and submits, then polls to a final on-chain result. Throws if `simulated.ok` was `false` — never call submit on an already-rejected simulation. */
  submit(): Promise<ChargeSubmitResult>;
}

export interface ChainGateway {
  /** Fresh on-chain read — never a DB cache (CLAUDE.md §2). */
  getMandate(mandateId: string): Promise<Mandate>;
  /** Builds + simulates the `charge` invocation. Does not sign or submit anything yet. */
  prepareCharge(args: ChargeArgs): Promise<PreparedCharge>;
}

export interface SorobanChainGatewayOptions {
  deployment: DeploymentRecord;
  relayerSigner: KeypairSigner;
  /**
   * Resolves the merchant's own authorization signer for the given
   * *on-chain* merchant address (read from the mandate the pipeline just
   * fetched — never a caller-supplied destination, per decision #4). See
   * this module's doc comment for why this is an open seam, not a solved
   * production mechanism, in this phase.
   */
  resolveMerchantSigner: (merchantAddress: string) => Promise<KeypairSigner> | KeypairSigner;
}

/** Production `ChainGateway`: real Soroban RPC via `@paymap/contract-client`/`@paymap/stellar`. */
export function createSorobanChainGateway(options: SorobanChainGatewayOptions): ChainGateway {
  const readClient = createMandateRegistryClient(options.deployment);
  const relayerClient = createMandateRegistryClient(options.deployment, {
    publicKey: options.relayerSigner.publicKey,
    signTransaction: options.relayerSigner.signTransaction,
  });

  return {
    getMandate: (mandateId) => getMandateOnChain(readClient, mandateId),

    prepareCharge: async (args) => {
      const tx = await buildCharge(relayerClient, args);

      if (tx.result.isErr()) {
        const error = decodeMandateErrorFromResult(tx.result.unwrapErr());
        return {
          simulated: { ok: false, error },
          submit: () => {
            throw new Error(`cannot submit charge_id=${args.chargeId}: simulation already rejected with ${error.info.name}`);
          },
        };
      }

      const receipt = toDomainPaymentReceipt(tx.result.unwrap());
      return {
        simulated: { ok: true, receipt },
        submit: async () => {
          // Merchant signer resolved from the *simulated receipt's own*
          // merchant field (fresh on-chain data), never from a parameter —
          // structurally, this code path has no way to redirect funds.
          const merchantSigner = await options.resolveMerchantSigner(receipt.merchant);
          try {
            const sent = await submitAsRelayer(tx, merchantSigner);
            const txHash = sent.sendTransactionResponse?.hash;
            if (sent.result.isErr()) {
              return { kind: "contract_error", error: decodeMandateErrorFromResult(sent.result.unwrapErr()), ...(txHash !== undefined ? { txHash } : {}) };
            }
            const finalReceipt = toDomainPaymentReceipt(sent.result.unwrap());
            const finalResponse = sent.getTransactionResponse;
            const ledger = finalResponse && "ledger" in finalResponse ? BigInt(finalResponse.ledger) : 0n;
            return { kind: "success", receipt: finalReceipt, txHash: txHash ?? "", ledger };
          } catch (error) {
            if (error instanceof SentTransaction.Errors.TransactionStillPending) {
              return { kind: "infra_error", failure: classifyInfraFailure("TX_NOT_INCLUDED"), message: error.message };
            }
            if (error instanceof SentTransaction.Errors.SendFailed) {
              return { kind: "infra_error", failure: classifyInfraFailure("SEND_FAILED"), message: error.message };
            }
            // Anything else (network unreachable, DNS failure, RPC 5xx,
            // etc.) — no finer-grained signal available; the most general
            // infra condition, always transient.
            const message = error instanceof Error ? error.message : String(error);
            return { kind: "infra_error", failure: classifyInfraFailure("RPC_UNAVAILABLE"), message };
          }
        },
      };
    },
  };
}
