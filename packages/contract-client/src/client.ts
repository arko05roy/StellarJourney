/**
 * Hand-written facade over the generated `mandate-registry` bindings.
 * Consumers of this package should import from here (or `./index.js`, which
 * re-exports this module), never reach into `./generated/*` directly.
 *
 * Read-only methods (`getMandate`, `getPayment`, `getRefund`,
 * `getRefundedTotal`, `ping`) resolve straight to domain types (or throw
 * {@link MandateReadError}) since they only ever need a simulation, never a
 * signature.
 *
 * Write methods (`createMandate`, `pauseMandate`, `resumeMandate`,
 * `revokeMandate`, `charge`, `refund`) return the generated client's
 * `AssembledTransaction` unchanged — signing them requires choosing one of
 * the two authorization flows this protocol has (payer-signs-and-submits, or
 * merchant-authorizes/relayer-submits), which is `packages/stellar`'s job
 * (`packages/stellar/src/submit.ts`), not this package's. This package stays
 * signer-agnostic.
 */
import type { SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";
import { Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import {
  Client as GeneratedClient,
  Errors as GeneratedErrors,
} from "./generated/mandate-registry.js";
import {
  fromDomainMandateInput,
  hexToId,
  toDomainMandate,
  toDomainPaymentReceipt,
  toDomainRefundReceipt,
  type Mandate,
  type MandateInput,
  type PaymentReceipt,
  type RefundReceipt,
} from "./domain.js";
import type { DeploymentRecord } from "./deployment-registry.js";

export { GeneratedClient };
export type { AmountRule as GeneratedAmountRule } from "./generated/mandate-registry.js";

/** Thrown by the read-only convenience methods when the contract returns a typed `Result::Err`. Carries only the error *name* — use `packages/stellar`'s `decodeMandateErrorFromResult`/`decodeMandateErrorName` for the full `{code, retryable}` triple; this package intentionally has no dependency on that decoder to keep the dependency direction one-way (`stellar` depends on `contract-client`, not the reverse). */
export class MandateReadError extends Error {
  readonly errorName: string;

  constructor(errorName: string) {
    super(`mandate-registry returned Err(${errorName})`);
    this.name = "MandateReadError";
    this.errorName = errorName;
  }
}

export interface MandateRegistryClientOptions {
  /** Defaults to the deployment registry's `contractId`. */
  contractId?: string;
  /** Defaults to the deployment registry's `networkPassphrase`. */
  networkPassphrase?: string;
  /** Defaults to the deployment registry's `rpcUrl`. */
  rpcUrl?: string;
  /** Source account that will pay the fee and own the sequence number for submitted transactions (the invoker — payer for lifecycle methods, relayer for `charge`/`refund`; see `packages/stellar/src/submit.ts`). Omit for simulation-only usage (the read-only methods below). */
  publicKey?: string;
  signTransaction?: SignTransaction;
  signAuthEntry?: SignAuthEntry;
  allowHttp?: boolean;
}

/** Constructs the generated `Client`, defaulting `contractId`/`networkPassphrase`/`rpcUrl` from a loaded {@link DeploymentRecord} (see `deployment-registry.ts`) and layering any explicit overrides (e.g. a distinct signer per call) on top. */
export function createMandateRegistryClient(
  deployment: DeploymentRecord,
  options: MandateRegistryClientOptions = {},
): GeneratedClient {
  const client = new GeneratedClient({
    contractId: options.contractId ?? deployment.contractId,
    networkPassphrase: options.networkPassphrase ?? deployment.networkPassphrase,
    rpcUrl: options.rpcUrl ?? deployment.rpcUrl,
    errorTypes: GeneratedErrors,
    ...(options.publicKey !== undefined ? { publicKey: options.publicKey } : {}),
    ...(options.signTransaction !== undefined ? { signTransaction: options.signTransaction } : {}),
    ...(options.signAuthEntry !== undefined ? { signAuthEntry: options.signAuthEntry } : {}),
    ...(options.allowHttp !== undefined ? { allowHttp: options.allowHttp } : {}),
  });

  // stellar-sdk 16 builds each method's error map from the contract spec's
  // error-case `doc` field, overwriting `options.errorTypes`. Soroban emits
  // empty docs for this `#[contracterror]` enum, while codegen separately
  // produced the correct names in `GeneratedErrors`; without this repair a
  // live `Error(Contract, #4)` becomes `{message: ""}` instead of
  // `MandateRevoked`. Fill the in-memory spec once so every dynamically
  // assembled method gets the generated ABI names. No generated source is
  // edited.
  for (const errorCase of client.spec.errorCases()) {
    const generated = GeneratedErrors[errorCase.value() as keyof typeof GeneratedErrors];
    if (generated !== undefined) {
      errorCase.doc(generated.message);
    }
  }

  return client;
}

/** Health-check. */
export async function ping(client: GeneratedClient): Promise<number> {
  const tx = await client.ping();
  return tx.result;
}

/** Read-only. Throws {@link MandateReadError} if the mandate doesn't exist (`MandateNotFound`) — never mutates storage (mirrors the contract's own computed-only-expiry read path, PLAN.md §10.8). */
export async function getMandate(client: GeneratedClient, mandateId: string): Promise<Mandate> {
  const tx = await client.get_mandate({ mandate_id: hexToId(mandateId) });
  if (tx.result.isErr()) {
    throw new MandateReadError(tx.result.unwrapErr().message);
  }
  return toDomainMandate(tx.result.unwrap());
}

/** Read-only. Throws {@link MandateReadError} (`PaymentNotFound`) if no receipt exists. */
export async function getPayment(
  client: GeneratedClient,
  paymentId: string,
): Promise<PaymentReceipt> {
  const tx = await client.get_payment({ payment_id: hexToId(paymentId) });
  if (tx.result.isErr()) {
    throw new MandateReadError(tx.result.unwrapErr().message);
  }
  return toDomainPaymentReceipt(tx.result.unwrap());
}

/** Read-only. Throws {@link MandateReadError} (`RefundNotFound`) if no receipt exists. */
export async function getRefund(client: GeneratedClient, refundId: string): Promise<RefundReceipt> {
  const tx = await client.get_refund({ refund_id: hexToId(refundId) });
  if (tx.result.isErr()) {
    throw new MandateReadError(tx.result.unwrapErr().message);
  }
  return toDomainRefundReceipt(tx.result.unwrap());
}

/** Read-only. Cumulative amount refunded against `paymentId` so far (`0n` if none). */
export async function getRefundedTotal(
  client: GeneratedClient,
  paymentId: string,
): Promise<bigint> {
  const tx = await client.get_refunded_total({ payment_id: hexToId(paymentId) });
  return tx.result;
}

/**
 * Builds (and, per the generated client's own behavior, simulates) the
 * `create_mandate` transaction. Requires `input.payer.require_auth()` — the
 * client must have been constructed with the payer as `publicKey` (see
 * `packages/stellar/src/submit.ts::submitAsInvoker`).
 */
export async function buildCreateMandate(client: GeneratedClient, input: MandateInput) {
  return client.create_mandate({ input: fromDomainMandateInput(input) });
}

export async function buildPauseMandate(client: GeneratedClient, mandateId: string) {
  return client.pause_mandate({ mandate_id: hexToId(mandateId) });
}

export async function buildResumeMandate(client: GeneratedClient, mandateId: string) {
  return client.resume_mandate({ mandate_id: hexToId(mandateId) });
}

export async function buildRevokeMandate(client: GeneratedClient, mandateId: string) {
  return client.revoke_mandate({ mandate_id: hexToId(mandateId) });
}

export interface ChargeArgs {
  mandateId: string;
  chargeId: string;
  amount: bigint;
  invoiceHash: string;
}

/**
 * Builds the `charge` transaction. Requires `mandate.merchant.require_auth()`
 * — in the real product this is the merchant-authorizes/relayer-submits flow
 * (`packages/stellar/src/submit.ts::submitAsRelayer`), never the relayer's
 * own key. There is deliberately no merchant/destination parameter here at
 * all — the contract reads the payout destination only from the stored
 * `Mandate` (see `contracts/mandate-registry/src/charge.rs` module doc),
 * which is what makes relayer redirection structurally impossible.
 */
export async function buildCharge(
  client: GeneratedClient,
  args: ChargeArgs,
  signedAuthorizationEntryXdr?: string,
) {
  const invocationArgs = {
    mandate_id: hexToId(args.mandateId),
    charge_id: hexToId(args.chargeId),
    amount: args.amount,
    invoice_hash: hexToId(args.invoiceHash),
  };
  if (signedAuthorizationEntryXdr === undefined) {
    return client.charge(invocationArgs);
  }

  const tx = await client.charge(invocationArgs, { simulate: false });
  if (!tx.raw) {
    throw new Error("Charge authorization requires an assembled transaction builder.");
  }
  // With `simulate: false`, stellar-sdk intentionally exposes `raw` and
  // leaves `built` unset so callers can modify the transaction before its
  // first simulation.
  tx.built = tx.raw.build();
  if (!tx.built || !("operations" in tx.built) || tx.built.operations.length !== 1) {
    throw new Error("Charge authorization requires one built invoke-contract operation.");
  }
  const operation = tx.built.operations[0];
  if (!operation || operation.type !== "invokeHostFunction") {
    throw new Error("Charge authorization can only attach to invokeHostFunction.");
  }
  const signedAuthorizationEntry = xdr.SorobanAuthorizationEntry.fromXDR(
    signedAuthorizationEntryXdr,
    "base64",
  );
  // `Transaction.operations` is a decoded view of the envelope. Mutating that
  // view does not update the transaction XDR that RPC simulation receives.
  // Rebuild the operation so the signed authorization is embedded in the
  // envelope and survives simulation/assembly.
  const withAuthorization = TransactionBuilder.cloneFrom(tx.built, {
    fee: tx.built.fee,
    networkPassphrase: tx.built.networkPassphrase,
  });
  withAuthorization.clearOperations();
  withAuthorization.addOperation(
    Operation.invokeHostFunction({
      ...(operation.source !== undefined ? { source: operation.source } : {}),
      func: operation.func,
      auth: [signedAuthorizationEntry],
    }),
  );
  tx.built = withAuthorization.build();
  await tx.simulate();
  return tx;
}

export interface RefundArgs {
  mandateId: string;
  paymentId: string;
  amount: bigint;
  refundId: string;
}

/** Builds the `refund` transaction. Requires `mandate.merchant.require_auth()` — same merchant-authorizes/relayer-submits flow as `charge`. */
export async function buildRefund(client: GeneratedClient, args: RefundArgs) {
  return client.refund({
    mandate_id: hexToId(args.mandateId),
    payment_id: hexToId(args.paymentId),
    amount: args.amount,
    refund_id: hexToId(args.refundId),
  });
}
