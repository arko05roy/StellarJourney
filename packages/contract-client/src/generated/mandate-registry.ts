// GENERATED FILE — do not hand-edit.
//
// Produced by (Phase 7, re-run to regenerate after any contract ABI change):
//   stellar contract bindings typescript \
//     --wasm target/wasm32v1-none/release/mandate_registry.optimized.wasm \
//     --output-dir packages/contract-client/src/generated \
//     --overwrite
// then: mv src/generated/src/index.ts src/generated/mandate-registry.ts
//       rm -rf src/generated/{src,README.md,.gitignore,package.json,tsconfig.json}
// (the codegen tool scaffolds a standalone npm package; only the single
// source file is kept, wrapped by ../index.ts's hand-written facade).
//
// Generated from the local wasm file directly (no network/RPC call needed),
// so this file has no `networks` export — the facade supplies
// `contractId`/`networkPassphrase`/`rpcUrl` from the deployment registry
// (`deployments/<network>.json`) instead. Excluded from ESLint via the
// shared `**/generated/**` ignore glob (packages/config/eslint.config.mjs);
// still typechecked normally as part of `pnpm typecheck`.
/* eslint-disable */
import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}




export const Errors = {
  1: {message:"MandateNotFound"},
  2: {message:"MandateNotActive"},
  3: {message:"MandatePaused"},
  4: {message:"MandateRevoked"},
  5: {message:"MandateCompleted"},
  6: {message:"MandateExpired"},
  7: {message:"ChargeBeforeStart"},
  8: {message:"ChargeTooSoon"},
  9: {message:"InvalidAmount"},
  10: {message:"AmountExceedsChargeLimit"},
  11: {message:"AmountExceedsPeriodLimit"},
  12: {message:"ChargeCountExceeded"},
  13: {message:"DuplicateCharge"},
  14: {message:"UnauthorizedMerchant"},
  15: {message:"InsufficientAllowance"},
  /**
   * Payer's token balance is too low (`charge`), or, since Phase 5,
   * merchant's token balance is too low for a `refund` — same code, same
   * advisory-pre-flight-before-the-real-transfer-call role in both
   * callers.
   */
  16: {message:"InsufficientBalance"},
  17: {message:"PaymentNotFound"},
  18: {message:"RefundExceedsPayment"},
  19: {message:"DuplicateRefund"},
  20: {message:"ArithmeticOverflow"},
  /**
   * A `create_mandate` input violates one of the bound checks enumerated
   * in `lifecycle::validate_input` (non-positive amount rule value,
   * `max_per_period` non-positive or below the per-charge cap,
   * `period_seconds == 0`, `expires_at <= start_at`, `expires_at` already
   * in the past, or `payer == merchant`). See `docs/contract-invariants.md`
   * for the full bound table.
   */
  21: {message:"InvalidMandateInput"},
  /**
   * `create_mandate` derived an id that already has a stored mandate.
   * Ids are derived deterministically from `(network_id, contract_address,
   * payer, merchant, asset, client_nonce)`; a distinct `client_nonce`
   * always produces a distinct id, so this only fires on a genuine replay
   * of an identical input tuple.
   */
  22: {message:"DuplicateMandate"},
  /**
   * A lifecycle transition was requested that the state machine does not
   * define, and no more specific status error applies. Currently only
   * `resume_mandate` called on an `Active` mandate (Active is not a legal
   * resume source and isn't itself a rejection reason like Paused/Revoked/
   * Completed/Expired).
   */
  23: {message:"InvalidStateTransition"},
  /**
   * `get_refund` found no stored `RefundReceipt` for the given
   * `refund_id`. Added in Phase 5, genuinely new: no existing code fits —
   * `DuplicateRefund` means the opposite thing (a refund_id already used
   * by a *successful* refund), so reusing it here would misreport "not
   * found" as "already refunded", exactly the generic-error mislabeling
   * CLAUDE.md §8 forbids. Parity with `PaymentNotFound` (17) for
   * `get_payment`.
   */
  24: {message:"RefundNotFound"}
}


/**
 * A recurring-payment authorization. See PLAN.md §10.3 for the field
 * contract and CLAUDE.md §6 for the validation order that guards every
 * mutation of this struct once `charge` lands in Phase 3.
 */
export interface Mandate {
  amount_rule: AmountRule;
  asset: string;
  created_at: u64;
  current_period_collected: i128;
  current_period_start: u64;
  expires_at: u64;
  id: Buffer;
  last_charged_at: Option<u64>;
  max_per_period: i128;
  max_successful_charges: u32;
  merchant: string;
  metadata_hash: Buffer;
  min_interval_seconds: u64;
  payer: string;
  period_seconds: u64;
  start_at: u64;
  status: MandateStatus;
  successful_charges: u32;
  total_collected: i128;
}

/**
 * Fixed vs. variable-capped billing rule for a mandate.
 * 
 * # Deviation from PLAN.md §10.3
 * 
 * PLAN.md sketches `Variable { max_per_charge: i128 }` as a named-field
 * enum variant. `soroban-sdk` 27's `#[contracttype]` macro rejects named
 * (struct-style) enum fields outright — see
 * `soroban-sdk-macros-27.0.2/src/derive_enum.rs:65` ("enum variant ... has
 * unsupported named fields"); only unit and non-empty tuple variants are
 * supported. `Variable(i128)` is the semantics-preserving equivalent: the
 * single field is the same `max_per_charge` value, just carried
 * positionally instead of by name. No business rule changes.
 */
export type AmountRule = {tag: "Fixed", values: readonly [i128]} | {tag: "Variable", values: readonly [i128]};


/**
 * Argument struct for `create_mandate` (Phase 2). Not itself stored — a
 * `Mandate` is built from this plus derived fields (`id`, `status`,
 * `successful_charges`, accounting counters, `created_at`).
 * 
 * `client_nonce` is a 32-byte value the checkout flow generates client-side
 * (e.g. a random value or a hash of the checkout session id) so that the
 * same `(payer, merchant, asset)` triple can mint distinct mandates on
 * request, and so the derived `mandate_id` (see `id::derive_mandate_id`)
 * stays collision-resistant.
 */
export interface MandateInput {
  amount_rule: AmountRule;
  asset: string;
  client_nonce: Buffer;
  expires_at: u64;
  max_per_period: i128;
  max_successful_charges: u32;
  merchant: string;
  metadata_hash: Buffer;
  min_interval_seconds: u64;
  payer: string;
  period_seconds: u64;
  start_at: u64;
}

/**
 * Lifecycle status of a mandate.
 * 
 * `Expired` is intentionally never written by a getter: `get_mandate`
 * computes it on the read path as `now >= expires_at` without mutating
 * storage (PLAN.md §10.8). A write path (Phase 2+) may still persist
 * `Expired` explicitly once it observes the condition during another state
 * transition, but reads alone must stay side-effect free.
 */
export type MandateStatus = {tag: "Active", values: void} | {tag: "Paused", values: void} | {tag: "Revoked", values: void} | {tag: "Completed", values: void} | {tag: "Expired", values: void};


/**
 * Immutable receipt for one successful refund.
 */
export interface RefundReceipt {
  amount: i128;
  payment_id: Buffer;
  refund_id: Buffer;
  timestamp: u64;
}


/**
 * Immutable receipt for one successful charge. Never deleted, including on
 * mandate revocation (CLAUDE.md §7 State invariants).
 */
export interface PaymentReceipt {
  amount: i128;
  asset: string;
  charge_id: Buffer;
  invoice_hash: Buffer;
  mandate_id: Buffer;
  merchant: string;
  payer: string;
  payment_id: Buffer;
  timestamp: u64;
}








export type DataKey = {tag: "Mandate", values: readonly [Buffer]} | {tag: "Payment", values: readonly [Buffer]} | {tag: "UsedCharge", values: readonly [Buffer, Buffer]} | {tag: "UsedRefund", values: readonly [Buffer]} | {tag: "RefundedTotal", values: readonly [Buffer]} | {tag: "Refund", values: readonly [Buffer]};

export interface Client {
  /**
   * Construct and simulate a ping transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Trivial health-check method carried over from Phase 0.
   */
  ping: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a charge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Execute one charge. Requires `mandate.merchant.require_auth()` —
   * never the relayer, which has no spending authority (CLAUDE.md §11).
   * See `charge.rs` for the full CLAUDE.md §6 validation order.
   */
  charge: ({mandate_id, charge_id, amount, invoice_hash}: {mandate_id: Buffer, charge_id: Buffer, amount: i128, invoice_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PaymentReceipt>>>

  /**
   * Construct and simulate a refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Execute one refund against `payment_id` (must belong to
   * `mandate_id`). Requires `mandate.merchant.require_auth()` — the
   * merchant gives up the funds. Permitted regardless of the mandate's
   * current status (revoked/paused/expired/completed all allowed); see
   * `refund.rs` for the full validation order and the no-headroom-
   * restoration rule.
   */
  refund: ({mandate_id, payment_id, amount, refund_id}: {mandate_id: Buffer, payment_id: Buffer, amount: i128, refund_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<RefundReceipt>>>

  /**
   * Construct and simulate a get_refund transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only. `RefundNotFound` if no receipt exists for `refund_id`.
   */
  get_refund: ({refund_id}: {refund_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<RefundReceipt>>>

  /**
   * Construct and simulate a get_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only. Reports `Expired` when `now >= expires_at` for a stored
   * `Active`/`Paused` mandate without writing storage.
   */
  get_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Mandate>>>

  /**
   * Construct and simulate a get_payment transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only. `PaymentNotFound` if no receipt exists for `payment_id`.
   */
  get_payment: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<PaymentReceipt>>>

  /**
   * Construct and simulate a pause_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `Active -> Paused`. Requires the payer's authorization.
   */
  pause_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a create_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Create a new mandate. Requires `input.payer.require_auth()` — the
   * merchant and the relayer are never sufficient (PLAN.md §10.5).
   */
  create_mandate: ({input}: {input: MandateInput}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Buffer>>>

  /**
   * Construct and simulate a resume_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `Paused -> Active`. Requires the payer's authorization.
   */
  resume_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a revoke_mandate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * `Active|Paused|Expired -> Revoked`, unconditionally at the payer's
   * request. Requires the payer's authorization; never the merchant's.
   */
  revoke_mandate: ({mandate_id}: {mandate_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_refunded_total transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Read-only. Cumulative amount refunded against `payment_id` so far
   * (`0` if none). Convenience for backend/dashboard consumers.
   */
  get_refunded_total: ({payment_id}: {payment_id: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAADZUcml2aWFsIGhlYWx0aC1jaGVjayBtZXRob2QgY2FycmllZCBvdmVyIGZyb20gUGhhc2UgMC4AAAAAAARwaW5nAAAAAAAAAAEAAAAE",
        "AAAAAAAAAMRFeGVjdXRlIG9uZSBjaGFyZ2UuIFJlcXVpcmVzIGBtYW5kYXRlLm1lcmNoYW50LnJlcXVpcmVfYXV0aCgpYCDigJQKbmV2ZXIgdGhlIHJlbGF5ZXIsIHdoaWNoIGhhcyBubyBzcGVuZGluZyBhdXRob3JpdHkgKENMQVVERS5tZCDCpzExKS4KU2VlIGBjaGFyZ2UucnNgIGZvciB0aGUgZnVsbCBDTEFVREUubWQgwqc2IHZhbGlkYXRpb24gb3JkZXIuAAAABmNoYXJnZQAAAAAABAAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAAAAAAACWNoYXJnZV9pZAAAAAAAA+4AAAAgAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAADGludm9pY2VfaGFzaAAAA+4AAAAgAAAAAQAAA+kAAAfQAAAADlBheW1lbnRSZWNlaXB0AAAAAAAD",
        "AAAAAAAAAVBFeGVjdXRlIG9uZSByZWZ1bmQgYWdhaW5zdCBgcGF5bWVudF9pZGAgKG11c3QgYmVsb25nIHRvCmBtYW5kYXRlX2lkYCkuIFJlcXVpcmVzIGBtYW5kYXRlLm1lcmNoYW50LnJlcXVpcmVfYXV0aCgpYCDigJQgdGhlCm1lcmNoYW50IGdpdmVzIHVwIHRoZSBmdW5kcy4gUGVybWl0dGVkIHJlZ2FyZGxlc3Mgb2YgdGhlIG1hbmRhdGUncwpjdXJyZW50IHN0YXR1cyAocmV2b2tlZC9wYXVzZWQvZXhwaXJlZC9jb21wbGV0ZWQgYWxsIGFsbG93ZWQpOyBzZWUKYHJlZnVuZC5yc2AgZm9yIHRoZSBmdWxsIHZhbGlkYXRpb24gb3JkZXIgYW5kIHRoZSBuby1oZWFkcm9vbS0KcmVzdG9yYXRpb24gcnVsZS4AAAAGcmVmdW5kAAAAAAAEAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAJcmVmdW5kX2lkAAAAAAAD7gAAACAAAAABAAAD6QAAB9AAAAANUmVmdW5kUmVjZWlwdAAAAAAAAAM=",
        "AAAAAAAAAEFSZWFkLW9ubHkuIGBSZWZ1bmROb3RGb3VuZGAgaWYgbm8gcmVjZWlwdCBleGlzdHMgZm9yIGByZWZ1bmRfaWRgLgAAAAAAAApnZXRfcmVmdW5kAAAAAAABAAAAAAAAAAlyZWZ1bmRfaWQAAAAAAAPuAAAAIAAAAAEAAAPpAAAH0AAAAA1SZWZ1bmRSZWNlaXB0AAAAAAAAAw==",
        "AAAAAAAAAHVSZWFkLW9ubHkuIFJlcG9ydHMgYEV4cGlyZWRgIHdoZW4gYG5vdyA+PSBleHBpcmVzX2F0YCBmb3IgYSBzdG9yZWQKYEFjdGl2ZWAvYFBhdXNlZGAgbWFuZGF0ZSB3aXRob3V0IHdyaXRpbmcgc3RvcmFnZS4AAAAAAAALZ2V0X21hbmRhdGUAAAAAAQAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAABAAAD6QAAB9AAAAAHTWFuZGF0ZQAAAAAD",
        "AAAAAAAAAENSZWFkLW9ubHkuIGBQYXltZW50Tm90Rm91bmRgIGlmIG5vIHJlY2VpcHQgZXhpc3RzIGZvciBgcGF5bWVudF9pZGAuAAAAAAtnZXRfcGF5bWVudAAAAAABAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAH0AAAAA5QYXltZW50UmVjZWlwdAAAAAAAAw==",
        "AAAAAAAAADdgQWN0aXZlIC0+IFBhdXNlZGAuIFJlcXVpcmVzIHRoZSBwYXllcidzIGF1dGhvcml6YXRpb24uAAAAAA1wYXVzZV9tYW5kYXRlAAAAAAAAAQAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAINDcmVhdGUgYSBuZXcgbWFuZGF0ZS4gUmVxdWlyZXMgYGlucHV0LnBheWVyLnJlcXVpcmVfYXV0aCgpYCDigJQgdGhlCm1lcmNoYW50IGFuZCB0aGUgcmVsYXllciBhcmUgbmV2ZXIgc3VmZmljaWVudCAoUExBTi5tZCDCpzEwLjUpLgAAAAAOY3JlYXRlX21hbmRhdGUAAAAAAAEAAAAAAAAABWlucHV0AAAAAAAH0AAAAAxNYW5kYXRlSW5wdXQAAAABAAAD6QAAA+4AAAAgAAAAAw==",
        "AAAAAAAAADdgUGF1c2VkIC0+IEFjdGl2ZWAuIFJlcXVpcmVzIHRoZSBwYXllcidzIGF1dGhvcml6YXRpb24uAAAAAA5yZXN1bWVfbWFuZGF0ZQAAAAAAAQAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAIVgQWN0aXZlfFBhdXNlZHxFeHBpcmVkIC0+IFJldm9rZWRgLCB1bmNvbmRpdGlvbmFsbHkgYXQgdGhlIHBheWVyJ3MKcmVxdWVzdC4gUmVxdWlyZXMgdGhlIHBheWVyJ3MgYXV0aG9yaXphdGlvbjsgbmV2ZXIgdGhlIG1lcmNoYW50J3MuAAAAAAAADnJldm9rZV9tYW5kYXRlAAAAAAABAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAH1SZWFkLW9ubHkuIEN1bXVsYXRpdmUgYW1vdW50IHJlZnVuZGVkIGFnYWluc3QgYHBheW1lbnRfaWRgIHNvIGZhcgooYDBgIGlmIG5vbmUpLiBDb252ZW5pZW5jZSBmb3IgYmFja2VuZC9kYXNoYm9hcmQgY29uc3VtZXJzLgAAAAAAABJnZXRfcmVmdW5kZWRfdG90YWwAAAAAAAEAAAAAAAAACnBheW1lbnRfaWQAAAAAA+4AAAAgAAAAAQAAAAs=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAGAAAAAAAAAAPTWFuZGF0ZU5vdEZvdW5kAAAAAAEAAAAAAAAAEE1hbmRhdGVOb3RBY3RpdmUAAAACAAAAAAAAAA1NYW5kYXRlUGF1c2VkAAAAAAAAAwAAAAAAAAAOTWFuZGF0ZVJldm9rZWQAAAAAAAQAAAAAAAAAEE1hbmRhdGVDb21wbGV0ZWQAAAAFAAAAAAAAAA5NYW5kYXRlRXhwaXJlZAAAAAAABgAAAAAAAAARQ2hhcmdlQmVmb3JlU3RhcnQAAAAAAAAHAAAAAAAAAA1DaGFyZ2VUb29Tb29uAAAAAAAACAAAAAAAAAANSW52YWxpZEFtb3VudAAAAAAAAAkAAAAAAAAAGEFtb3VudEV4Y2VlZHNDaGFyZ2VMaW1pdAAAAAoAAAAAAAAAGEFtb3VudEV4Y2VlZHNQZXJpb2RMaW1pdAAAAAsAAAAAAAAAE0NoYXJnZUNvdW50RXhjZWVkZWQAAAAADAAAAAAAAAAPRHVwbGljYXRlQ2hhcmdlAAAAAA0AAAAAAAAAFFVuYXV0aG9yaXplZE1lcmNoYW50AAAADgAAAAAAAAAVSW5zdWZmaWNpZW50QWxsb3dhbmNlAAAAAAAADwAAAM5QYXllcidzIHRva2VuIGJhbGFuY2UgaXMgdG9vIGxvdyAoYGNoYXJnZWApLCBvciwgc2luY2UgUGhhc2UgNSwKbWVyY2hhbnQncyB0b2tlbiBiYWxhbmNlIGlzIHRvbyBsb3cgZm9yIGEgYHJlZnVuZGAg4oCUIHNhbWUgY29kZSwgc2FtZQphZHZpc29yeS1wcmUtZmxpZ2h0LWJlZm9yZS10aGUtcmVhbC10cmFuc2Zlci1jYWxsIHJvbGUgaW4gYm90aApjYWxsZXJzLgAAAAAAE0luc3VmZmljaWVudEJhbGFuY2UAAAAAEAAAAAAAAAAPUGF5bWVudE5vdEZvdW5kAAAAABEAAAAAAAAAFFJlZnVuZEV4Y2VlZHNQYXltZW50AAAAEgAAAAAAAAAPRHVwbGljYXRlUmVmdW5kAAAAABMAAAAAAAAAEkFyaXRobWV0aWNPdmVyZmxvdwAAAAAAFAAAAWdBIGBjcmVhdGVfbWFuZGF0ZWAgaW5wdXQgdmlvbGF0ZXMgb25lIG9mIHRoZSBib3VuZCBjaGVja3MgZW51bWVyYXRlZAppbiBgbGlmZWN5Y2xlOjp2YWxpZGF0ZV9pbnB1dGAgKG5vbi1wb3NpdGl2ZSBhbW91bnQgcnVsZSB2YWx1ZSwKYG1heF9wZXJfcGVyaW9kYCBub24tcG9zaXRpdmUgb3IgYmVsb3cgdGhlIHBlci1jaGFyZ2UgY2FwLApgcGVyaW9kX3NlY29uZHMgPT0gMGAsIGBleHBpcmVzX2F0IDw9IHN0YXJ0X2F0YCwgYGV4cGlyZXNfYXRgIGFscmVhZHkKaW4gdGhlIHBhc3QsIG9yIGBwYXllciA9PSBtZXJjaGFudGApLiBTZWUgYGRvY3MvY29udHJhY3QtaW52YXJpYW50cy5tZGAKZm9yIHRoZSBmdWxsIGJvdW5kIHRhYmxlLgAAAAATSW52YWxpZE1hbmRhdGVJbnB1dAAAAAAVAAABLWBjcmVhdGVfbWFuZGF0ZWAgZGVyaXZlZCBhbiBpZCB0aGF0IGFscmVhZHkgaGFzIGEgc3RvcmVkIG1hbmRhdGUuCklkcyBhcmUgZGVyaXZlZCBkZXRlcm1pbmlzdGljYWxseSBmcm9tIGAobmV0d29ya19pZCwgY29udHJhY3RfYWRkcmVzcywKcGF5ZXIsIG1lcmNoYW50LCBhc3NldCwgY2xpZW50X25vbmNlKWA7IGEgZGlzdGluY3QgYGNsaWVudF9ub25jZWAKYWx3YXlzIHByb2R1Y2VzIGEgZGlzdGluY3QgaWQsIHNvIHRoaXMgb25seSBmaXJlcyBvbiBhIGdlbnVpbmUgcmVwbGF5Cm9mIGFuIGlkZW50aWNhbCBpbnB1dCB0dXBsZS4AAAAAAAAQRHVwbGljYXRlTWFuZGF0ZQAAABYAAAEnQSBsaWZlY3ljbGUgdHJhbnNpdGlvbiB3YXMgcmVxdWVzdGVkIHRoYXQgdGhlIHN0YXRlIG1hY2hpbmUgZG9lcyBub3QKZGVmaW5lLCBhbmQgbm8gbW9yZSBzcGVjaWZpYyBzdGF0dXMgZXJyb3IgYXBwbGllcy4gQ3VycmVudGx5IG9ubHkKYHJlc3VtZV9tYW5kYXRlYCBjYWxsZWQgb24gYW4gYEFjdGl2ZWAgbWFuZGF0ZSAoQWN0aXZlIGlzIG5vdCBhIGxlZ2FsCnJlc3VtZSBzb3VyY2UgYW5kIGlzbid0IGl0c2VsZiBhIHJlamVjdGlvbiByZWFzb24gbGlrZSBQYXVzZWQvUmV2b2tlZC8KQ29tcGxldGVkL0V4cGlyZWQpLgAAAAAWSW52YWxpZFN0YXRlVHJhbnNpdGlvbgAAAAAAFwAAAZtgZ2V0X3JlZnVuZGAgZm91bmQgbm8gc3RvcmVkIGBSZWZ1bmRSZWNlaXB0YCBmb3IgdGhlIGdpdmVuCmByZWZ1bmRfaWRgLiBBZGRlZCBpbiBQaGFzZSA1LCBnZW51aW5lbHkgbmV3OiBubyBleGlzdGluZyBjb2RlIGZpdHMg4oCUCmBEdXBsaWNhdGVSZWZ1bmRgIG1lYW5zIHRoZSBvcHBvc2l0ZSB0aGluZyAoYSByZWZ1bmRfaWQgYWxyZWFkeSB1c2VkCmJ5IGEgKnN1Y2Nlc3NmdWwqIHJlZnVuZCksIHNvIHJldXNpbmcgaXQgaGVyZSB3b3VsZCBtaXNyZXBvcnQgIm5vdApmb3VuZCIgYXMgImFscmVhZHkgcmVmdW5kZWQiLCBleGFjdGx5IHRoZSBnZW5lcmljLWVycm9yIG1pc2xhYmVsaW5nCkNMQVVERS5tZCDCpzggZm9yYmlkcy4gUGFyaXR5IHdpdGggYFBheW1lbnROb3RGb3VuZGAgKDE3KSBmb3IKYGdldF9wYXltZW50YC4AAAAADlJlZnVuZE5vdEZvdW5kAAAAAAAY",
        "AAAAAQAAAMFBIHJlY3VycmluZy1wYXltZW50IGF1dGhvcml6YXRpb24uIFNlZSBQTEFOLm1kIMKnMTAuMyBmb3IgdGhlIGZpZWxkCmNvbnRyYWN0IGFuZCBDTEFVREUubWQgwqc2IGZvciB0aGUgdmFsaWRhdGlvbiBvcmRlciB0aGF0IGd1YXJkcyBldmVyeQptdXRhdGlvbiBvZiB0aGlzIHN0cnVjdCBvbmNlIGBjaGFyZ2VgIGxhbmRzIGluIFBoYXNlIDMuAAAAAAAAAAAAAAdNYW5kYXRlAAAAABMAAAAAAAAAC2Ftb3VudF9ydWxlAAAAB9AAAAAKQW1vdW50UnVsZQAAAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAACmNyZWF0ZWRfYXQAAAAAAAYAAAAAAAAAGGN1cnJlbnRfcGVyaW9kX2NvbGxlY3RlZAAAAAsAAAAAAAAAFGN1cnJlbnRfcGVyaW9kX3N0YXJ0AAAABgAAAAAAAAAKZXhwaXJlc19hdAAAAAAABgAAAAAAAAACaWQAAAAAA+4AAAAgAAAAAAAAAA9sYXN0X2NoYXJnZWRfYXQAAAAD6AAAAAYAAAAAAAAADm1heF9wZXJfcGVyaW9kAAAAAAALAAAAAAAAABZtYXhfc3VjY2Vzc2Z1bF9jaGFyZ2VzAAAAAAAEAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAADW1ldGFkYXRhX2hhc2gAAAAAAAPuAAAAIAAAAAAAAAAUbWluX2ludGVydmFsX3NlY29uZHMAAAAGAAAAAAAAAAVwYXllcgAAAAAAABMAAAAAAAAADnBlcmlvZF9zZWNvbmRzAAAAAAAGAAAAAAAAAAhzdGFydF9hdAAAAAYAAAAAAAAABnN0YXR1cwAAAAAH0AAAAA1NYW5kYXRlU3RhdHVzAAAAAAAAAAAAABJzdWNjZXNzZnVsX2NoYXJnZXMAAAAAAAQAAAAAAAAAD3RvdGFsX2NvbGxlY3RlZAAAAAAL",
        "AAAAAgAAAmFGaXhlZCB2cy4gdmFyaWFibGUtY2FwcGVkIGJpbGxpbmcgcnVsZSBmb3IgYSBtYW5kYXRlLgoKIyBEZXZpYXRpb24gZnJvbSBQTEFOLm1kIMKnMTAuMwoKUExBTi5tZCBza2V0Y2hlcyBgVmFyaWFibGUgeyBtYXhfcGVyX2NoYXJnZTogaTEyOCB9YCBhcyBhIG5hbWVkLWZpZWxkCmVudW0gdmFyaWFudC4gYHNvcm9iYW4tc2RrYCAyNydzIGAjW2NvbnRyYWN0dHlwZV1gIG1hY3JvIHJlamVjdHMgbmFtZWQKKHN0cnVjdC1zdHlsZSkgZW51bSBmaWVsZHMgb3V0cmlnaHQg4oCUIHNlZQpgc29yb2Jhbi1zZGstbWFjcm9zLTI3LjAuMi9zcmMvZGVyaXZlX2VudW0ucnM6NjVgICgiZW51bSB2YXJpYW50IC4uLiBoYXMKdW5zdXBwb3J0ZWQgbmFtZWQgZmllbGRzIik7IG9ubHkgdW5pdCBhbmQgbm9uLWVtcHR5IHR1cGxlIHZhcmlhbnRzIGFyZQpzdXBwb3J0ZWQuIGBWYXJpYWJsZShpMTI4KWAgaXMgdGhlIHNlbWFudGljcy1wcmVzZXJ2aW5nIGVxdWl2YWxlbnQ6IHRoZQpzaW5nbGUgZmllbGQgaXMgdGhlIHNhbWUgYG1heF9wZXJfY2hhcmdlYCB2YWx1ZSwganVzdCBjYXJyaWVkCnBvc2l0aW9uYWxseSBpbnN0ZWFkIG9mIGJ5IG5hbWUuIE5vIGJ1c2luZXNzIHJ1bGUgY2hhbmdlcy4AAAAAAAAAAAAACkFtb3VudFJ1bGUAAAAAAAIAAAABAAAAAAAAAAVGaXhlZAAAAAAAAAEAAAALAAAAAQAAAIRgbWF4X3Blcl9jaGFyZ2VgIOKAlCBzZWUgdGhlIGRldmlhdGlvbiBub3RlIGFib3ZlIGZvciB3aHkgdGhpcyBpcyBhCnR1cGxlIHZhcmlhbnQgcmF0aGVyIHRoYW4gdGhlIG5hbWVkLWZpZWxkIGZvcm0gUExBTi5tZCBza2V0Y2hlcy4AAAAIVmFyaWFibGUAAAABAAAACw==",
        "AAAAAQAAAfxBcmd1bWVudCBzdHJ1Y3QgZm9yIGBjcmVhdGVfbWFuZGF0ZWAgKFBoYXNlIDIpLiBOb3QgaXRzZWxmIHN0b3JlZCDigJQgYQpgTWFuZGF0ZWAgaXMgYnVpbHQgZnJvbSB0aGlzIHBsdXMgZGVyaXZlZCBmaWVsZHMgKGBpZGAsIGBzdGF0dXNgLApgc3VjY2Vzc2Z1bF9jaGFyZ2VzYCwgYWNjb3VudGluZyBjb3VudGVycywgYGNyZWF0ZWRfYXRgKS4KCmBjbGllbnRfbm9uY2VgIGlzIGEgMzItYnl0ZSB2YWx1ZSB0aGUgY2hlY2tvdXQgZmxvdyBnZW5lcmF0ZXMgY2xpZW50LXNpZGUKKGUuZy4gYSByYW5kb20gdmFsdWUgb3IgYSBoYXNoIG9mIHRoZSBjaGVja291dCBzZXNzaW9uIGlkKSBzbyB0aGF0IHRoZQpzYW1lIGAocGF5ZXIsIG1lcmNoYW50LCBhc3NldClgIHRyaXBsZSBjYW4gbWludCBkaXN0aW5jdCBtYW5kYXRlcyBvbgpyZXF1ZXN0LCBhbmQgc28gdGhlIGRlcml2ZWQgYG1hbmRhdGVfaWRgIChzZWUgYGlkOjpkZXJpdmVfbWFuZGF0ZV9pZGApCnN0YXlzIGNvbGxpc2lvbi1yZXNpc3RhbnQuAAAAAAAAAAxNYW5kYXRlSW5wdXQAAAAMAAAAAAAAAAthbW91bnRfcnVsZQAAAAfQAAAACkFtb3VudFJ1bGUAAAAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAxjbGllbnRfbm9uY2UAAAPuAAAAIAAAAAAAAAAKZXhwaXJlc19hdAAAAAAABgAAAAAAAAAObWF4X3Blcl9wZXJpb2QAAAAAAAsAAAAAAAAAFm1heF9zdWNjZXNzZnVsX2NoYXJnZXMAAAAAAAQAAAAAAAAACG1lcmNoYW50AAAAEwAAAAAAAAANbWV0YWRhdGFfaGFzaAAAAAAAA+4AAAAgAAAAAAAAABRtaW5faW50ZXJ2YWxfc2Vjb25kcwAAAAYAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAOcGVyaW9kX3NlY29uZHMAAAAAAAYAAAAAAAAACHN0YXJ0X2F0AAAABg==",
        "AAAAAgAAAW1MaWZlY3ljbGUgc3RhdHVzIG9mIGEgbWFuZGF0ZS4KCmBFeHBpcmVkYCBpcyBpbnRlbnRpb25hbGx5IG5ldmVyIHdyaXR0ZW4gYnkgYSBnZXR0ZXI6IGBnZXRfbWFuZGF0ZWAKY29tcHV0ZXMgaXQgb24gdGhlIHJlYWQgcGF0aCBhcyBgbm93ID49IGV4cGlyZXNfYXRgIHdpdGhvdXQgbXV0YXRpbmcKc3RvcmFnZSAoUExBTi5tZCDCpzEwLjgpLiBBIHdyaXRlIHBhdGggKFBoYXNlIDIrKSBtYXkgc3RpbGwgcGVyc2lzdApgRXhwaXJlZGAgZXhwbGljaXRseSBvbmNlIGl0IG9ic2VydmVzIHRoZSBjb25kaXRpb24gZHVyaW5nIGFub3RoZXIgc3RhdGUKdHJhbnNpdGlvbiwgYnV0IHJlYWRzIGFsb25lIG11c3Qgc3RheSBzaWRlLWVmZmVjdCBmcmVlLgAAAAAAAAAAAAANTWFuZGF0ZVN0YXR1cwAAAAAAAAUAAAAAAAAAAAAAAAZBY3RpdmUAAAAAAAAAAAAAAAAABlBhdXNlZAAAAAAAAAAAAAAAAAAHUmV2b2tlZAAAAAAAAAAAAAAAAAlDb21wbGV0ZWQAAAAAAAAAAAAAAAAAAAdFeHBpcmVkAA==",
        "AAAAAQAAACxJbW11dGFibGUgcmVjZWlwdCBmb3Igb25lIHN1Y2Nlc3NmdWwgcmVmdW5kLgAAAAAAAAANUmVmdW5kUmVjZWlwdAAAAAAAAAQAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAACXJlZnVuZF9pZAAAAAAAA+4AAAAgAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAG",
        "AAAAAQAAAH1JbW11dGFibGUgcmVjZWlwdCBmb3Igb25lIHN1Y2Nlc3NmdWwgY2hhcmdlLiBOZXZlciBkZWxldGVkLCBpbmNsdWRpbmcgb24KbWFuZGF0ZSByZXZvY2F0aW9uIChDTEFVREUubWQgwqc3IFN0YXRlIGludmFyaWFudHMpLgAAAAAAAAAAAAAOUGF5bWVudFJlY2VpcHQAAAAAAAkAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAljaGFyZ2VfaWQAAAAAAAPuAAAAIAAAAAAAAAAMaW52b2ljZV9oYXNoAAAD7gAAACAAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAAAAAAhtZXJjaGFudAAAABMAAAAAAAAABXBheWVyAAAAAAAAEwAAAAAAAAAKcGF5bWVudF9pZAAAAAAD7gAAACAAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAY=",
        "AAAABQAAAElFbWl0dGVkIGJ5IGBwYXVzZV9tYW5kYXRlYCBvbiBhIHN1Y2Nlc3NmdWwgYEFjdGl2ZSAtPiBQYXVzZWRgIHRyYW5zaXRpb24uAAAAAAAAAAAAAA1NYW5kYXRlUGF1c2VkAAAAAAAAAQAAAA5tYW5kYXRlX3BhdXNlZAAAAAAABAAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAABAAAAAAAAAAVwYXllcgAAAAAAABMAAAABAAAAAAAAAAhtZXJjaGFudAAAABMAAAABAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAEVFbWl0dGVkIG9uY2UgYnkgYGNyZWF0ZV9tYW5kYXRlYCBhZnRlciB0aGUgbWFuZGF0ZSBpcyBkdXJhYmx5IHN0b3JlZC4AAAAAAAAAAAAADk1hbmRhdGVDcmVhdGVkAAAAAAABAAAAD21hbmRhdGVfY3JlYXRlZAAAAAANAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAEAAAAAAAAABXBheWVyAAAAAAAAEwAAAAEAAAAAAAAACG1lcmNoYW50AAAAEwAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAAAAAAC2Ftb3VudF9ydWxlAAAAB9AAAAAKQW1vdW50UnVsZQAAAAAAAAAAAAAAAAAObWF4X3Blcl9wZXJpb2QAAAAAAAsAAAAAAAAAAAAAAA5wZXJpb2Rfc2Vjb25kcwAAAAAABgAAAAAAAAAAAAAAFG1pbl9pbnRlcnZhbF9zZWNvbmRzAAAABgAAAAAAAAAAAAAACHN0YXJ0X2F0AAAABgAAAAAAAAAAAAAACmV4cGlyZXNfYXQAAAAAAAYAAAAAAAAAAAAAABZtYXhfc3VjY2Vzc2Z1bF9jaGFyZ2VzAAAAAAAEAAAAAAAAAAAAAAANbWV0YWRhdGFfaGFzaAAAAAAAA+4AAAAgAAAAAAAAAAAAAAAJdGltZXN0YW1wAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAEpFbWl0dGVkIGJ5IGByZXN1bWVfbWFuZGF0ZWAgb24gYSBzdWNjZXNzZnVsIGBQYXVzZWQgLT4gQWN0aXZlYCB0cmFuc2l0aW9uLgAAAAAAAAAAAA5NYW5kYXRlUmVzdW1lZAAAAAAAAQAAAA9tYW5kYXRlX3Jlc3VtZWQAAAAABAAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAABAAAAAAAAAAVwYXllcgAAAAAAABMAAAABAAAAAAAAAAhtZXJjaGFudAAAABMAAAABAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAIpFbWl0dGVkIGJ5IGByZXZva2VfbWFuZGF0ZWAgb24gYSBzdWNjZXNzZnVsIHRyYW5zaXRpb24gdG8gYFJldm9rZWRgIChmcm9tCmBBY3RpdmVgLCBgUGF1c2VkYCwgb3IgYW4gZXhwaXJlZC1idXQtbm90LXlldC10ZXJtaW5hbCBtYW5kYXRlKS4AAAAAAAAAAAAOTWFuZGF0ZVJldm9rZWQAAAAAAAEAAAAPbWFuZGF0ZV9yZXZva2VkAAAAAAQAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAQAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAQAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAQAAAAAAAAAJdGltZXN0YW1wAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAiZFbWl0dGVkIGJ5IGBjaGFyZ2VgIChQaGFzZSAzKSBvbmNlIGEgcGF5bWVudCBoYXMgYmVlbiBkdXJhYmx5IHJlY29yZGVkIOKAlAppLmUuIG9ubHkgYWZ0ZXIgYFRva2VuQ2xpZW50Ojp0cmFuc2Zlcl9mcm9tYCBzdWNjZWVkZWQsIGFjY291bnRpbmcgd2FzCnVwZGF0ZWQsIGFuZCB0aGUgcmVjZWlwdCB3YXMgc3RvcmVkLiBGdWxsIGZpZWxkIHNldCBwZXIgUExBTi5tZCDCpzExLgpUb3BpY3MgZm9sbG93IHRoZSBzYW1lIGBtYW5kYXRlX2lkYC9gcGF5ZXJgL2BtZXJjaGFudGAgY29udmVudGlvbiBhcyB0aGUKbGlmZWN5Y2xlIGV2ZW50cyBhYm92ZSBzbyBpbmRleGVycyBjYW4gZmlsdGVyIGNoYXJnZXMgdGhlIHNhbWUgd2F5IHRoZXkKZmlsdGVyIGxpZmVjeWNsZSB0cmFuc2l0aW9uczsgYHBheW1lbnRfaWRgLCBgY2hhcmdlX2lkYCwgYW5kIHRoZSByZXN0IGFyZQpjYXJyaWVkIGFzIGRhdGEuIGBpbnZvaWNlX2hhc2hgIG9ubHkg4oCUIG5vIHBsYWludGV4dCBpbnZvaWNlIG1ldGFkYXRhIGV2ZXIKcmVhY2hlcyB0aGUgY2hhaW4gKENMQVVERS5tZCDCpzUsIMKnOSkuAAAAAAAAAAAAD0NoYXJnZVN1Y2NlZWRlZAAAAAABAAAAEGNoYXJnZV9zdWNjZWVkZWQAAAALAAAAAAAAAAptYW5kYXRlX2lkAAAAAAPuAAAAIAAAAAEAAAAAAAAABXBheWVyAAAAAAAAEwAAAAEAAAAAAAAACG1lcmNoYW50AAAAEwAAAAEAAAAAAAAACnBheW1lbnRfaWQAAAAAA+4AAAAgAAAAAAAAAAAAAAAJY2hhcmdlX2lkAAAAAAAD7gAAACAAAAAAAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAAAAAAAAZhbW91bnQAAAAAAAsAAAAAAAAAAAAAAAxpbnZvaWNlX2hhc2gAAAPuAAAAIAAAAAAAAAAAAAAADHBlcmlvZF9pbmRleAAAAAYAAAAAAAAAAAAAABhzdWNjZXNzZnVsX2NoYXJnZV9udW1iZXIAAAAEAAAAAAAAAAAAAAAJdGltZXN0YW1wAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAbhFbWl0dGVkIGJ5IGByZWZ1bmRgIChQaGFzZSA1KSBvbmNlIGEgcmVmdW5kIGhhcyBiZWVuIGR1cmFibHkgcmVjb3JkZWQg4oCUCmkuZS4gb25seSBhZnRlciBgVG9rZW5DbGllbnQ6OnRyYW5zZmVyYCAobWVyY2hhbnQgLT4gcGF5ZXIpIHN1Y2NlZWRlZCwKYFJlZnVuZGVkVG90YWxgIHdhcyB1cGRhdGVkLCBhbmQgdGhlIGBSZWZ1bmRSZWNlaXB0YCB3YXMgc3RvcmVkLiBTYW1lCnRvcGljIGNvbnZlbnRpb24gYXMgYENoYXJnZVN1Y2NlZWRlZGAuIGByZWZ1bmRlZF90b3RhbF9hZnRlcmAgaXMgdGhlCmN1bXVsYXRpdmUgcmVmdW5kZWQgYW1vdW50IGZvciBgcGF5bWVudF9pZGAgKmFmdGVyKiB0aGlzIHJlZnVuZCwgc28gYW4KaW5kZXhlciBuZXZlciBoYXMgdG8gc3VtIHJlY2VpcHRzIGl0c2VsZiB0byBrbm93IHdoZXRoZXIgYSBwYXltZW50IGlzCmZ1bGx5IHJlZnVuZGVkLgAAAAAAAAAPUmVmdW5kU3VjY2VlZGVkAAAAAAEAAAAQcmVmdW5kX3N1Y2NlZWRlZAAAAAkAAAAAAAAACm1hbmRhdGVfaWQAAAAAA+4AAAAgAAAAAQAAAAAAAAAFcGF5ZXIAAAAAAAATAAAAAQAAAAAAAAAIbWVyY2hhbnQAAAATAAAAAQAAAAAAAAAJcmVmdW5kX2lkAAAAAAAD7gAAACAAAAAAAAAAAAAAAApwYXltZW50X2lkAAAAAAPuAAAAIAAAAAAAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAAAAAABmFtb3VudAAAAAAACwAAAAAAAAAAAAAAFHJlZnVuZGVkX3RvdGFsX2FmdGVyAAAACwAAAAAAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAd5FbWl0dGVkIG9uY2UgYnkgYGNoYXJnZWAgKFBoYXNlIDQpIGluIHRoZSBzYW1lIGludm9jYXRpb24gdGhhdCBwdXNoZXMgYQptYW5kYXRlJ3MgYHN1Y2Nlc3NmdWxfY2hhcmdlc2AgdG8gaXRzIG5vbi16ZXJvIGBtYXhfc3VjY2Vzc2Z1bF9jaGFyZ2VzYApjYXAgKGAwYCBzdGlsbCBtZWFucyB1bmxpbWl0ZWQg4oCUIHRoaXMgZXZlbnQgY2FuIG5ldmVyIGZpcmUgZm9yIHRoYXQKY2FzZSkuIFB1Ymxpc2hlZCBhbG9uZ3NpZGUgYENoYXJnZVN1Y2NlZWRlZGAgaW4gdGhlIHBvc3QtdHJhbnNmZXIKYWNjb3VudGluZyBibG9jaywgc28gYm90aCBldmVudHMsIHRoZSBhY2NvdW50aW5nIHVwZGF0ZSwgYW5kIHRoZQpgQ29tcGxldGVkYCBzdGF0dXMgd3JpdGUgYXJlIGFsbCBwYXJ0IG9mIHRoZSBzYW1lIGF0b21pYyBvdXRjb21lOiBlaXRoZXIKbm9uZSBvZiB0aGVtIGhhcHBlbmVkICh0cmFuc2ZlciB0cmFwcGVkKSBvciBhbGwgb2YgdGhlbSBkaWQuAAAAAAAAAAAAEE1hbmRhdGVDb21wbGV0ZWQAAAABAAAAEW1hbmRhdGVfY29tcGxldGVkAAAAAAAABQAAAAAAAAAKbWFuZGF0ZV9pZAAAAAAD7gAAACAAAAABAAAAAAAAAAVwYXllcgAAAAAAABMAAAABAAAAAAAAAAhtZXJjaGFudAAAABMAAAABAAAAAAAAABJzdWNjZXNzZnVsX2NoYXJnZXMAAAAAAAQAAAAAAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAGAAAAAAAAAAI=",
        "AAAAAgAAAAAAAAAAAAAAB0RhdGFLZXkAAAAABgAAAAEAAAAAAAAAB01hbmRhdGUAAAAAAQAAA+4AAAAgAAAAAQAAAAAAAAAHUGF5bWVudAAAAAABAAAD7gAAACAAAAABAAAAfGAobWFuZGF0ZV9pZCwgY2hhcmdlX2lkKWAg4oCUIGEgY2hhcmdlIGlkIGlzIG9ubHkgdW5pcXVlICp3aXRoaW4qIGEKbWFuZGF0ZSwgc28gYm90aCBoYWx2ZXMgb2YgdGhlIHBhaXIgYXJlIHBhcnQgb2YgdGhlIGtleS4AAAAKVXNlZENoYXJnZQAAAAAAAgAAA+4AAAAgAAAD7gAAACAAAAABAAAAAAAAAApVc2VkUmVmdW5kAAAAAAABAAAD7gAAACAAAAABAAAAOEN1bXVsYXRpdmUgYW1vdW50IHJlZnVuZGVkIGFnYWluc3QgYSBnaXZlbiBgcGF5bWVudF9pZGAuAAAADVJlZnVuZGVkVG90YWwAAAAAAAABAAAD7gAAACAAAAABAAAAq1RoZSBzdG9yZWQgYFJlZnVuZFJlY2VpcHRgIGZvciBhIGdpdmVuIGByZWZ1bmRfaWRgLCBhZGRlZCBpbiBQaGFzZSA1CmZvciBwYXJpdHkgd2l0aCBgUGF5bWVudChwYXltZW50X2lkKWAg4oCUIGEgYGdldF9yZWZ1bmRgIHJlYWQgZW50cnlwb2ludApuZWVkcyBzb21ld2hlcmUgdG8gcmVhZCBmcm9tLgAAAAAGUmVmdW5kAAAAAAABAAAD7gAAACA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    ping: this.txFromJSON<u32>,
        charge: this.txFromJSON<Result<PaymentReceipt>>,
        refund: this.txFromJSON<Result<RefundReceipt>>,
        get_refund: this.txFromJSON<Result<RefundReceipt>>,
        get_mandate: this.txFromJSON<Result<Mandate>>,
        get_payment: this.txFromJSON<Result<PaymentReceipt>>,
        pause_mandate: this.txFromJSON<Result<void>>,
        create_mandate: this.txFromJSON<Result<Buffer>>,
        resume_mandate: this.txFromJSON<Result<void>>,
        revoke_mandate: this.txFromJSON<Result<void>>,
        get_refunded_total: this.txFromJSON<i128>
  }
}