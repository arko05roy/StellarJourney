/**
 * Auth-entry assembly for the protocol's two-signer flows (CLAUDE.md §11,
 * PLAN.md §9 trust model): a payer signs and submits their own lifecycle
 * transactions directly, while a `charge`/`refund` is *authorized* by the
 * merchant but *submitted* by an untrusted relayer — the merchant never
 * hands its key to the relayer, and the relayer never gains spending
 * authority. See `submit.ts` for how these signers combine into that flow.
 *
 * Wraps a plain `Keypair` as the two callback shapes the generated Soroban
 * client (`@stellar/stellar-sdk/contract`) expects: `signTransaction` (signs
 * the outer transaction envelope — only the tx *source account* needs this)
 * and an `authorizeEntry`-based signer for `AssembledTransaction.signAuthEntries`
 * (signs one Soroban authorization entry for a specific `Address` — anyone
 * named in the invocation's `require_auth()` tree needs this, regardless of
 * whether they are the tx source).
 */
import { authorizeEntry as baseAuthorizeEntry, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import type { SignTransaction } from "@stellar/stellar-sdk/contract";
import type { xdr } from "@stellar/stellar-sdk";

/**
 * Matches `@stellar/stellar-sdk`'s own `authorizeEntry` signature exactly
 * (`typeof authorizeEntry` from `"@stellar/stellar-sdk"`'s base module) —
 * `AssembledTransaction.signAuthEntries({ authorizeEntry })` requires an
 * override of this *exact* shape (it always calls it as
 * `authorizeEntry(entry, signerCallback, validUntilLedgerSeq,
 * networkPassphrase, forAddress)` internally, regardless of what override you
 * supply). A {@link KeypairSigner}'s `authorizeEntry` ignores the
 * SDK-constructed `signerCallback` in the second position and calls the base
 * `authorizeEntry` with its own `Keypair` instead — which is what lets
 * `submitAsRelayer` (`submit.ts`) drive this with a plain secret key instead
 * of a wallet-style callback.
 */
type AuthorizeEntryFn = typeof baseAuthorizeEntry;

export interface KeypairSigner {
  readonly publicKey: string;
  readonly keypair: Keypair;
  /** Signs the outer transaction envelope. Only needed by whoever is the transaction's source account (fee payer, sequence number owner) — the payer for lifecycle methods, the relayer for `charge`/`refund`. */
  readonly signTransaction: SignTransaction;
  /**
   * Signs one Soroban authorization entry as this signer's address, for
   * `AssembledTransaction.signAuthEntries({ authorizeEntry })`. Needed by
   * anyone appearing in the invocation's `require_auth()` tree, whether or
   * not they are the tx source. Delegates directly to `@stellar/stellar-sdk`'s
   * own `authorizeEntry(entry, signer, ...)`, which accepts a bare `Keypair`
   * as `signer` — deliberately *not* hand-rolled here, since the exact
   * hash-then-sign steps `authorizeEntry` performs internally are
   * security-sensitive and already implemented/tested upstream.
   */
  readonly authorizeEntry: AuthorizeEntryFn;
}

/** Builds a {@link KeypairSigner} from a raw Stellar secret key (`S...`). Used by scripts and tests that hold plain secret keys directly (relayer, demo script) — a real wallet integration (Freighter, Stellar Wallets Kit) would instead implement `signTransaction`/`signAuthEntry` via its own extension/API and would not need this helper at all. */
export function keypairSigner(secretKey: string): KeypairSigner {
  const keypair = Keypair.fromSecret(secretKey);
  const publicKey = keypair.publicKey();

  const signTransaction: SignTransaction = async (xdrString, opts) => {
    const networkPassphrase = opts?.networkPassphrase;
    if (networkPassphrase === undefined) {
      throw new Error("keypairSigner.signTransaction requires opts.networkPassphrase");
    }
    const tx = TransactionBuilder.fromXDR(xdrString, networkPassphrase);
    tx.sign(keypair);
    return { signedTxXdr: tx.toXDR(), signerAddress: publicKey };
  };

  // Second parameter (the SDK's internally-constructed wallet-style signing
  // callback) is intentionally unused — this signer authorizes with its own
  // Keypair instead. See the `AuthorizeEntryFn` doc comment above for why the
  // signature must still match `authorizeEntry` positionally.
  const authorizeEntryFn: AuthorizeEntryFn = (entry: xdr.SorobanAuthorizationEntry, _signer, validUntilLedgerSeq: number, networkPassphrase: string, forAddress?: string) =>
    baseAuthorizeEntry(entry, keypair, validUntilLedgerSeq, networkPassphrase, forAddress);

  return { publicKey, keypair, signTransaction, authorizeEntry: authorizeEntryFn };
}
