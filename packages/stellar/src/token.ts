/**
 * SEP-41 token (`approve`/`allowance`) transaction builders for the payer's
 * bounded-allowance step of the checkout flow (PLAN.md §10.10, CLAUDE.md §2
 * — never an unlimited approval). The mandate-registry's own generated
 * client (`packages/contract-client`) only knows the mandate-registry ABI;
 * a SAC/SEP-41 asset contract is a *different* contract with no published
 * Wasm to derive a `ContractSpec` from (Stellar Asset Contracts are a
 * built-in host implementation), so `AssembledTransaction.build` is driven
 * here directly with hand-built `ScVal` args instead of a generated
 * `Client` subclass — the same low-level primitive the generated client
 * itself is built on (`@stellar/stellar-sdk/contract`).
 */
import { nativeToScVal, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type { SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";

export interface TokenClientContext {
  /** The SEP-41 token contract (SAC) address (`C...`). */
  tokenContractId: string;
  networkPassphrase: string;
  rpcUrl: string;
  /** Source account paying the fee/sequence — the payer, for both `approve` and the read-only `allowance` query. */
  publicKey: string;
  signTransaction?: SignTransaction;
  signAuthEntry?: SignAuthEntry;
  allowHttp?: boolean;
}

export interface ApproveArgs {
  from: string;
  spender: string;
  /** Base units. Bounded — never pass an unbounded/max-i128 sentinel here (CLAUDE.md §2). */
  amount: bigint;
  /** Ledger sequence at which this approval expires. Bounded, never `u32::MAX` — see `computeApprovalLiveUntilLedger`. */
  liveUntilLedgerSeq: number;
}

/**
 * Builds (and simulates) the `approve(from, spender, amount, live_until_ledger)`
 * transaction. Requires `from.require_auth()` — the caller must construct
 * this with `from` as `publicKey`/`signTransaction`, mirroring
 * `submit.ts::submitAsInvoker`'s payer-signs-and-submits flow exactly (the
 * payer is both the invocation's required signer and the transaction
 * source, so a plain `signAndSend()` covers both).
 */
export async function buildApprove(context: TokenClientContext, args: ApproveArgs): Promise<AssembledTransaction<null>> {
  return AssembledTransaction.build<null>({
    contractId: context.tokenContractId,
    networkPassphrase: context.networkPassphrase,
    rpcUrl: context.rpcUrl,
    publicKey: context.publicKey,
    ...(context.signTransaction !== undefined ? { signTransaction: context.signTransaction } : {}),
    ...(context.signAuthEntry !== undefined ? { signAuthEntry: context.signAuthEntry } : {}),
    ...(context.allowHttp !== undefined ? { allowHttp: context.allowHttp } : {}),
    method: "approve",
    args: [
      nativeToScVal(args.from, { type: "address" }),
      nativeToScVal(args.spender, { type: "address" }),
      nativeToScVal(args.amount, { type: "i128" }),
      nativeToScVal(args.liveUntilLedgerSeq, { type: "u32" }),
    ],
    parseResultXdr: () => null,
  });
}

/** Read-only. Current allowance `from` has granted `spender`, in base units (`0n` if none). Used by the allowance-change flow (PLAN.md §10.10) to confirm a zeroing `approve` actually landed before setting the new amount. */
export async function queryAllowance(
  context: Omit<TokenClientContext, "signTransaction" | "signAuthEntry">,
  args: { from: string; spender: string },
): Promise<bigint> {
  const tx = await AssembledTransaction.build<bigint>({
    contractId: context.tokenContractId,
    networkPassphrase: context.networkPassphrase,
    rpcUrl: context.rpcUrl,
    publicKey: context.publicKey,
    ...(context.allowHttp !== undefined ? { allowHttp: context.allowHttp } : {}),
    method: "allowance",
    args: [nativeToScVal(args.from, { type: "address" }), nativeToScVal(args.spender, { type: "address" })],
    parseResultXdr: (result: xdr.ScVal) => scValToNative(result) as bigint,
    simulate: true,
  });
  return tx.result;
}

const LEDGER_CLOSE_TIME_SECONDS = 5;
/** Extra ledgers of headroom beyond the raw duration-derived count, so a few slow ledger closes near the boundary don't tip the approval into "already expired" (~30 min at 5s/ledger). */
const APPROVAL_SAFETY_BUFFER_LEDGERS = 360;
/** Soroban's own ceiling on how far in the future a ledger-based expiration may be set (roughly 1 year at 5s/ledger) — never request more than this regardless of a very long-lived mandate. */
const MAX_ENTRY_TTL_LEDGERS = 6_312_000;

/**
 * Derives a bounded `live_until_ledger` for the approval: far enough out to
 * cover the mandate's own `expiresAt`, never further, and never an
 * unbounded/maximal value. `currentLedger` comes from a fresh
 * `Server.getLatestLedger()` call (the caller's responsibility — this
 * function stays a pure, easily-testable calculation).
 */
export function computeApprovalLiveUntilLedger(currentLedger: number, nowUnixSeconds: bigint, mandateExpiresAtUnixSeconds: bigint): number {
  const secondsUntilExpiry = mandateExpiresAtUnixSeconds > nowUnixSeconds ? mandateExpiresAtUnixSeconds - nowUnixSeconds : 0n;
  const ledgersUntilExpiry = Number(secondsUntilExpiry / BigInt(LEDGER_CLOSE_TIME_SECONDS)) + APPROVAL_SAFETY_BUFFER_LEDGERS;
  const boundedLedgers = Math.min(ledgersUntilExpiry, MAX_ENTRY_TTL_LEDGERS);
  return currentLedger + boundedLedgers;
}
