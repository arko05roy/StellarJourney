import { z } from "zod";
import { StellarAccountAddressSchema } from "./common.js";
import { API_KEY_SCOPES } from "../auth/scopes.js";

export const CreateMerchantAuthChallengeSchema = z.object({
  walletAddress: StellarAccountAddressSchema,
});

export const CompleteMerchantAuthChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  message: z.string().min(1).max(2_000),
  signature: z.string().min(1).max(256),
  signerAddress: StellarAccountAddressSchema,
});

export const RegisterVerifiedMerchantSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
});
