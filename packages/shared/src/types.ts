/**
 * Zod schemas mirroring `contracts/mandate-registry/src/types.rs` exactly
 * (CLAUDE.md §20 — contract rules are canonical, this is a mirror, never a
 * second definition of a business rule). TS types are re-exported from
 * `@paymap/contract-client`'s domain layer rather than redefined here, so
 * there is exactly one source of truth for the shape; this module only adds
 * runtime validation at untrusted boundaries (CLAUDE.md §5).
 *
 * Scope note: this covers the mandate/payment(charge)/refund shapes that
 * exist today. A `Product`/checkout-session schema belongs to the merchant
 * API (Phase 8, PLAN.md §14) and is deliberately not introduced here yet —
 * inventing its shape ahead of that phase's actual endpoints would be
 * exactly the speculative work CLAUDE.md §3 warns against.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { AmountRule, Mandate, MandateInput, MandateStatus, PaymentReceipt, RefundReceipt } from "@paymap/contract-client";

/** A 32-byte contract id (`mandate_id`, `charge_id`, `payment_id`, `refund_id`, `metadata_hash`, `invoice_hash`), lowercase or uppercase hex. */
export const HexId32Schema = z.string().regex(/^[0-9a-f]{64}$/i, "expected a 32-byte (64 hex character) id");

/** A classic Stellar account address (`G...`), checksum-validated via `StrKey`. */
export const StellarAccountAddressSchema = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), "expected a valid Stellar account address (G...)");

/** A Soroban contract address (`C...`), checksum-validated via `StrKey`. */
export const StellarContractAddressSchema = z
  .string()
  .refine((value) => StrKey.isValidContract(value), "expected a valid Stellar contract address (C...)");

/** Either a classic account or a Soroban contract — the generic `Address` shape the contract itself uses for `payer`/`merchant`/`asset`. */
export const StellarAddressSchema = z
  .string()
  .refine(
    (value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value),
    "expected a valid Stellar account (G...) or contract (C...) address",
  );

/** Mirrors `contracts/mandate-registry/src/types.rs::MandateStatus`. */
export const MandateStatusSchema = z.enum(["Active", "Paused", "Revoked", "Completed", "Expired"]);
type _MandateStatusSchemaMatches = z.infer<typeof MandateStatusSchema> extends MandateStatus ? true : never;
const _mandateStatusSchemaMatchesContractType: _MandateStatusSchemaMatches = true;

/**
 * Mirrors `contracts/mandate-registry/src/types.rs::AmountRule`. Both
 * branches require a positive amount — `create_mandate` rejects a
 * non-positive `Fixed`/`Variable` value with `InvalidAmount`
 * (`docs/contract-invariants.md` Phase 2 table), so this schema rejects it
 * at the same boundary rather than deferring to a contract round-trip.
 */
export const AmountRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), amount: z.bigint().positive() }),
  z.object({ kind: z.literal("variable"), maxPerCharge: z.bigint().positive() }),
]);

/**
 * Mirrors `contracts/mandate-registry/src/types.rs::MandateInput`. Bound
 * checks that are cheap and unambiguous to mirror are included (see the
 * `.refine`s below); everything else — `max_per_period` vs. the per-charge
 * cap, `period_seconds`, count/interval bounds — is intentionally left to
 * the contract's own `lifecycle::validate_input`, which remains the single
 * canonical authority (CLAUDE.md §20).
 */
export const MandateInputSchema = z
  .object({
    payer: StellarAccountAddressSchema,
    merchant: StellarAccountAddressSchema,
    asset: StellarAddressSchema,
    amountRule: AmountRuleSchema,
    maxPerPeriod: z.bigint().positive(),
    periodSeconds: z.bigint().positive(),
    minIntervalSeconds: z.bigint().nonnegative(),
    startAt: z.bigint().nonnegative(),
    expiresAt: z.bigint().positive(),
    maxSuccessfulCharges: z.number().int().nonnegative(),
    metadataHash: HexId32Schema,
    clientNonce: HexId32Schema,
  })
  .refine((input) => input.expiresAt > input.startAt, {
    message: "expiresAt must be after startAt",
    path: ["expiresAt"],
  })
  .refine((input) => input.payer !== input.merchant, {
    message: "payer and merchant must differ (no self-mandates)",
    path: ["merchant"],
  });
type _MandateInputSchemaMatches = z.infer<typeof MandateInputSchema> extends MandateInput ? true : never;
const _mandateInputSchemaMatchesContractType: _MandateInputSchemaMatches = true;

/** Mirrors `contracts/mandate-registry/src/types.rs::Mandate`. */
export const MandateSchema = z.object({
  id: HexId32Schema,
  payer: StellarAccountAddressSchema,
  merchant: StellarAccountAddressSchema,
  asset: StellarAddressSchema,
  status: MandateStatusSchema,
  amountRule: AmountRuleSchema,
  maxPerPeriod: z.bigint().positive(),
  periodSeconds: z.bigint().positive(),
  minIntervalSeconds: z.bigint().nonnegative(),
  startAt: z.bigint().nonnegative(),
  expiresAt: z.bigint().positive(),
  maxSuccessfulCharges: z.number().int().nonnegative(),
  successfulCharges: z.number().int().nonnegative(),
  totalCollected: z.bigint().nonnegative(),
  currentPeriodStart: z.bigint().nonnegative(),
  currentPeriodCollected: z.bigint().nonnegative(),
  lastChargedAt: z.union([z.bigint().nonnegative(), z.undefined()]),
  createdAt: z.bigint().nonnegative(),
  metadataHash: HexId32Schema,
});
// No compile-time `z.infer<...> extends Mandate` assertion here (unlike the
// other schemas below): Zod always infers a field whose output includes
// `undefined` as an *optional* TS property (`lastChargedAt?: bigint`),
// regardless of whether `.optional()` or `z.union([..., z.undefined()])`
// was used to declare it — that never matches the domain type's
// required-but-possibly-undefined `lastChargedAt: bigint | undefined`
// (mirroring the contract's `Option<u64>`) under `exactOptionalPropertyTypes`.
// Runtime coverage (`types.test.ts`) instead directly proves `MandateSchema`
// accepts real `Mandate` values with `lastChargedAt` both set and
// `undefined`.

/** Mirrors `contracts/mandate-registry/src/types.rs::PaymentReceipt` — the "charge" shape. */
export const PaymentReceiptSchema = z.object({
  paymentId: HexId32Schema,
  mandateId: HexId32Schema,
  chargeId: HexId32Schema,
  payer: StellarAccountAddressSchema,
  merchant: StellarAccountAddressSchema,
  asset: StellarAddressSchema,
  amount: z.bigint().positive(),
  invoiceHash: HexId32Schema,
  timestamp: z.bigint().nonnegative(),
});
type _PaymentReceiptSchemaMatches = z.infer<typeof PaymentReceiptSchema> extends PaymentReceipt ? true : never;
const _paymentReceiptSchemaMatchesContractType: _PaymentReceiptSchemaMatches = true;

/** Mirrors `contracts/mandate-registry/src/types.rs::RefundReceipt`. */
export const RefundReceiptSchema = z.object({
  refundId: HexId32Schema,
  paymentId: HexId32Schema,
  amount: z.bigint().positive(),
  timestamp: z.bigint().nonnegative(),
});
type _RefundReceiptSchemaMatches = z.infer<typeof RefundReceiptSchema> extends RefundReceipt ? true : never;
const _refundReceiptSchemaMatchesContractType: _RefundReceiptSchemaMatches = true;

export type { AmountRule, Mandate, MandateInput, MandateStatus, PaymentReceipt, RefundReceipt };
