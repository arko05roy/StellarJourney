/**
 * Shared Zod primitives for the merchant API boundary (CLAUDE.md §10 — every
 * public input passes a Zod schema). Address/id schemas are re-exported
 * from `@paymap/shared` rather than redefined (CLAUDE.md §20 — one source
 * of truth).
 */
import { z } from "zod";
import { HexId32Schema, StellarAccountAddressSchema, StellarAddressSchema, StellarContractAddressSchema } from "@paymap/shared";

export { HexId32Schema, StellarAccountAddressSchema, StellarAddressSchema, StellarContractAddressSchema };

/** Non-negative decimal literal (e.g. `"15.00"`, `"0"`); sign/exponent/whitespace all rejected. Zero and precision bounds are enforced downstream via `@paymap/shared`'s conversion, once the asset's `decimals` is known. */
export const DecimalAmountSchema = z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal amount string, e.g. \"15.00\"");

/** ISO 8601 timestamp (CLAUDE.md §9 — ISO 8601 in APIs, UTC everywhere). */
export const Iso8601Schema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be a valid ISO 8601 timestamp");

/** CLAUDE.md §10 — no arbitrary webhook protocols. */
export const WebhookUrlSchema = z
  .string()
  .url()
  .refine((url) => url.startsWith("http://") || url.startsWith("https://"), "webhook URL must use http or https");

export const IdempotencyKeyHeaderSchema = z.string().min(1).max(255);

/** A bounded duration in seconds — rejects unbounded/absurd values (CLAUDE.md §10). ~10 years is a generous, clearly-bounded ceiling. */
export const BoundedDurationSecondsSchema = z
  .number()
  .int()
  .positive()
  .max(60 * 60 * 24 * 365 * 10, "duration must be bounded (max ~10 years)");
