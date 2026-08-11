import { z } from "zod";
import { DecimalAmountSchema, HexId32Schema, Iso8601Schema } from "./common.js";

export const CreateChargeSchema = z.object({
  amount: DecimalAmountSchema,
  invoiceHash: HexId32Schema,
  /** Defaults to now when omitted. */
  scheduledFor: Iso8601Schema.optional(),
});
export type CreateChargeInput = z.infer<typeof CreateChargeSchema>;

export const CompleteChargeAuthorizationSchema = z.object({
  signedAuthorizationEntryXdr: z.string().min(1).max(65_536),
});
