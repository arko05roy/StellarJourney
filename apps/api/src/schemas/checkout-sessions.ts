import { z } from "zod";
import { HexId32Schema, Iso8601Schema, StellarAccountAddressSchema } from "./common.js";

export const CreateCheckoutSessionSchema = z.object({
  productId: z.string().uuid(),
  clientReference: z.string().max(255).optional(),
  payerAddress: StellarAccountAddressSchema.optional(),
  /** Defaults to `now + product.defaultDurationSeconds` when omitted (never unbounded — CLAUDE.md §10). */
  expiresAt: Iso8601Schema.optional(),
});
export type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionSchema>;

/**
 * Body for `POST /checkout-sessions/:id/mandate` (Phase 10) — the consumer
 * checkout page reports the `mandate_id` it just created on-chain back to
 * the session. Unauthenticated (the consumer browser never holds a merchant
 * API key), so the route handler itself re-verifies the mandate on-chain
 * (existence, merchant, asset, payer) before trusting anything here — this
 * schema only shapes the input, it grants no authority (CLAUDE.md §2, the
 * database/this payload is never the source of truth).
 */
export const LinkMandateToCheckoutSessionSchema = z.object({
  mandateId: HexId32Schema,
  payerAddress: StellarAccountAddressSchema,
});
export type LinkMandateToCheckoutSessionInput = z.infer<typeof LinkMandateToCheckoutSessionSchema>;
