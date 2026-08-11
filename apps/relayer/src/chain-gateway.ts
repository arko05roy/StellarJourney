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
 * Production attaches the merchant's encrypted, invocation-bound Soroban
 * authorization entry before simulation. `resolveMerchantSigner` remains an
 * optional test/demo seam only; the production entrypoint never supplies it.
 */
import { SentTransaction } from "@stellar/stellar-sdk/contract";
import { rpc } from "@stellar/stellar-sdk";
import {
  buildCharge,
  createMandateRegistryClient,
  getMandate as getMandateOnChain,
  toDomainPaymentReceipt,
  type DeploymentRecord,
  type Mandate,
  type PaymentReceipt,
} from "@paymap/contract-client";
import {
  decodeMandateErrorFromResult,
  submitAsRelayer,
  type KeypairSigner,
  type MandateContractError,
} from "@paymap/stellar";
import { classifyInfraFailure, type ClassifiedFailure } from "./classify.js";

export interface ChargeArgs {
  mandateId: string;
  chargeId: string;
  amount: bigint;
  invoiceHash: string;
  signedAuthorizationEntryXdr?: string;
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
  readonly simulated:
    | { readonly ok: true; readonly receipt: PaymentReceipt }
    | { readonly ok: false; readonly error: MandateContractError };
  /** Signs (merchant auth entry + relayer envelope) and submits, then polls to a final on-chain result. Throws if `simulated.ok` was `false` — never call submit on an already-rejected simulation. */
  submit(): Promise<ChargeSubmitResult>;
}

export interface ChainGateway {
  /** Fresh on-chain read — never a DB cache (CLAUDE.md §2). */
  getMandate(mandateId: string): Promise<Mandate>;
  getLatestLedgerSequence?(): Promise<number>;
  /** Builds + simulates the `charge` invocation. Does not sign or submit anything yet. */
  prepareCharge(args: ChargeArgs): Promise<PreparedCharge>;
}

export interface SorobanChainGatewayOptions {
  deployment: DeploymentRecord;
  relayerSigner: KeypairSigner;
  /**
   * Test/demo-only signer seam. Production supplies a signed authorization
   * entry and leaves this undefined.
   */
  resolveMerchantSigner?: (merchantAddress: string) => Promise<KeypairSigner> | KeypairSigner;
}

/** Production `ChainGateway`: real Soroban RPC via `@paymap/contract-client`/`@paymap/stellar`. */
export function createSorobanChainGateway(options: SorobanChainGatewayOptions): ChainGateway {
  const readClient = createMandateRegistryClient(options.deployment);
  const relayerClient = createMandateRegistryClient(options.deployment, {
    publicKey: options.relayerSigner.publicKey,
    signTransaction: options.relayerSigner.signTransaction,
  });
  const rpcServer = new rpc.Server(options.deployment.rpcUrl, {
    allowHttp: options.deployment.rpcUrl.startsWith("http://"),
  });

  return {
    getMandate: (mandateId) => getMandateOnChain(readClient, mandateId),
    getLatestLedgerSequence: async () => (await rpcServer.getLatestLedger()).sequence,

    prepareCharge: async (args) => {
      const tx = await buildCharge(relayerClient, args, args.signedAuthorizationEntryXdr);

      if (tx.result.isErr()) {
        const error = decodeMandateErrorFromResult(tx.result.unwrapErr());
        return {
          simulated: { ok: false, error },
          submit: () => {
            throw new Error(
              `cannot submit charge_id=${args.chargeId}: simulation already rejected with ${error.info.name}`,
            );
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
          const outstanding = tx.needsNonInvokerSigningBy();
          const merchantSigner =
            outstanding.length > 0 && options.resolveMerchantSigner
              ? await options.resolveMerchantSigner(receipt.merchant)
              : undefined;
          try {
            const sent = await submitAsRelayer(tx, merchantSigner);
            const txHash = sent.sendTransactionResponse?.hash;
            if (sent.result.isErr()) {
              return {
                kind: "contract_error",
                error: decodeMandateErrorFromResult(sent.result.unwrapErr()),
                ...(txHash !== undefined ? { txHash } : {}),
              };
            }
            const finalReceipt = toDomainPaymentReceipt(sent.result.unwrap());
            const finalResponse = sent.getTransactionResponse;
            const ledger =
              finalResponse && "ledger" in finalResponse ? BigInt(finalResponse.ledger) : 0n;
            return { kind: "success", receipt: finalReceipt, txHash: txHash ?? "", ledger };
          } catch (error) {
            if (error instanceof SentTransaction.Errors.TransactionStillPending) {
              return {
                kind: "infra_error",
                failure: classifyInfraFailure("TX_NOT_INCLUDED"),
                message: error.message,
              };
            }
            if (error instanceof SentTransaction.Errors.SendFailed) {
              return {
                kind: "infra_error",
                failure: classifyInfraFailure("SEND_FAILED"),
                message: error.message,
              };
            }
            // Anything else (network unreachable, DNS failure, RPC 5xx,
            // etc.) — no finer-grained signal available; the most general
            // infra condition, always transient.
            const message = error instanceof Error ? error.message : String(error);
            return {
              kind: "infra_error",
              failure: classifyInfraFailure("RPC_UNAVAILABLE"),
              message,
            };
          }
        },
      };
    },
  };
}
