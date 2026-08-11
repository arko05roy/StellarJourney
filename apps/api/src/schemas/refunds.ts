import { z } from "zod";
import { DecimalAmountSchema } from "./common.js";

export const CreateRefundSchema = z.object({
  amount: DecimalAmountSchema,
});
export type CreateRefundInput = z.infer<typeof CreateRefundSchema>;
