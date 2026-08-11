/**
 * Simulation-then-submission helpers for the two authorization flows the
 * protocol needs (CLAUDE.md §11, PLAN.md §9). Both helpers rely on the
 * generated client's own "simulate on construction" behavior (every method
 * call returns an already-simulated `AssembledTransaction`) and refuse to
 * proceed to a signature if that simulation already came back as a typed
 * `Result::Err` — this is the "simulate before submission" step the relayer
 * depends on (Phase 9), pulled forward into a single reusable helper instead
 * of being re-implemented per call site.
 */
import type { AssembledTransaction, Result, SentTransaction } from "@stellar/stellar-sdk/contract";
import { decodeMandateErrorFromResult } from "./errors.js";
import type { KeypairSigner } from "./signer.js";

/**
 * Throws a typed {@link MandateContractError} if the transaction's
 * already-simulated result is `Err` — surfaces a deterministic policy
 * rejection (e.g. `MandateRevoked`, `AmountExceedsChargeLimit`) immediately,
 * before asking anyone to sign or paying a submission fee, instead of
 * failing later as an opaque submitted-transaction error.
 */
export function assertSimulatedOk<T>(tx: AssembledTransaction<Result<T>>): void {
  if (tx.result.isErr()) {
    throw decodeMandateErrorFromResult(tx.result.unwrapErr());
  }
}

/**
 * Payer-signs-and-submits flow: `create_mandate`, `pause_mandate`,
 * `resume_mandate`, `revoke_mandate`. The payer is both the invocation's
 * required signer (`input.payer.require_auth()` / `mandate.payer.require_auth()`)
 * and the transaction's source account, so a single `signAndSend()` covers
 * both — the `GeneratedClient` used to build `tx` must have been constructed
 * with the payer as `publicKey`/`signTransaction`
 * (`createMandateRegistryClient(deployment, { publicKey: payer.publicKey,
 * signTransaction: payer.signTransaction })`).
 */
export async function submitAsInvoker<T>(
  tx: AssembledTransaction<Result<T>>,
): Promise<SentTransaction<Result<T>>> {
  assertSimulatedOk(tx);
  return tx.signAndSend();
}

/**
 * Merchant-authorizes/relayer-submits flow: `charge`, `refund` — the core
 * trust boundary of the whole product. The relayer is untrusted and has zero
 * spending authority; it only pays the network fee and submits. The
 * `GeneratedClient` used to build `tx` must have been constructed with the
 * *relayer* as `publicKey`/`signTransaction` (it is the tx source, per
 * `submitAsInvoker`'s doc); `merchantSigner` supplies the separate
 * authorization entry for `mandate.merchant.require_auth()`.
 *
 * Order of operations, matching CLAUDE.md §11's relayer responsibilities:
 *   1. Refuse to proceed if the simulation already rejected the call
 *      (`assertSimulatedOk` — no signature requested, no fee spent).
 *   2. Sign only the merchant's specific auth entry — never the whole
 *      transaction — with `merchantSigner`.
 *   3. Assert nothing else still needs a non-invoker signature (a caller
 *      passing the wrong merchant keypair, or a mandate whose merchant
 *      differs from what was expected, fails loudly here rather than as a
 *      network-level auth rejection).
 *   4. Sign the transaction envelope and submit, as the relayer.
 */
export async function submitAsRelayer<T>(
  tx: AssembledTransaction<Result<T>>,
  merchantSigner?: KeypairSigner,
): Promise<SentTransaction<Result<T>>> {
  assertSimulatedOk(tx);

  const needsMerchantSignature =
    merchantSigner !== undefined &&
    tx.needsNonInvokerSigningBy().includes(merchantSigner.publicKey);
  if (needsMerchantSignature && merchantSigner) {
    await tx.signAuthEntries({
      address: merchantSigner.publicKey,
      authorizeEntry: merchantSigner.authorizeEntry,
    });
  }

  const remaining = tx.needsNonInvokerSigningBy();
  if (remaining.length > 0) {
    throw new Error(
      `transaction still needs non-invoker signatures from: ${remaining.join(", ")}${
        merchantSigner ? ` (expected only "${merchantSigner.publicKey}" to be outstanding)` : ""
      }`,
    );
  }

  return tx.signAndSend();
}
