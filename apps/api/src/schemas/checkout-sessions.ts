import { z } from "zod";
import { Iso8601Schema, StellarAccountAddressSchema } from "./common.js";

export const CreateCheckoutSessionSchema = z.object({
  productId: z.string().uuid(),
  clientReference: z.string().max(255).optional(),
  payerAddress: StellarAccountAddressSchema.optional(),
  /** Defaults to `now + product.defaultDurationSeconds` when omitted (never unbounded — CLAUDE.md §10). */
  expiresAt: Iso8601Schema.optional(),
});
export type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionSchema>;
