import { z } from "zod";
import { StellarAccountAddressSchema } from "./common.js";

export const CreateMerchantSchema = z.object({
  name: z.string().min(1).max(200),
  walletAddress: StellarAccountAddressSchema,
});
export type CreateMerchantInput = z.infer<typeof CreateMerchantSchema>;
