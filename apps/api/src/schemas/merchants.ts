import { z } from "zod";
import { StellarAccountAddressSchema } from "./common.js";
import { API_KEY_SCOPES } from "../auth/scopes.js";

export const CreateMerchantSchema = z.object({
  name: z.string().min(1).max(200),
  walletAddress: StellarAccountAddressSchema,
});
export type CreateMerchantInput = z.infer<typeof CreateMerchantSchema>;

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
});
