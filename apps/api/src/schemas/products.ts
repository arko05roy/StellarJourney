import { z } from "zod";
import { BoundedDurationSecondsSchema, DecimalAmountSchema, StellarContractAddressSchema } from "./common.js";

const BaseProductFields = {
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  assetAddress: StellarContractAddressSchema,
  /** Declared decimals of `assetAddress` — required for decimal<->base-unit conversion (CLAUDE.md §9); no bare default is assumed. */
  assetDecimals: z.number().int().min(0).max(24),
  maxPerPeriod: DecimalAmountSchema,
  periodSeconds: BoundedDurationSecondsSchema,
  minIntervalSeconds: z.number().int().nonnegative(),
  /** 0 = unlimited, mirroring the contract's own convention. */
  maxSuccessfulCharges: z.number().int().nonnegative(),
  defaultDurationSeconds: BoundedDurationSecondsSchema,
};

/** Every public input passes a Zod schema (CLAUDE.md §10). `amountType` discriminates which amount field is required, mirroring `contracts/mandate-registry/src/types.rs::AmountRule`. */
export const CreateProductSchema = z.discriminatedUnion("amountType", [
  z.object({ amountType: z.literal("fixed"), fixedAmount: DecimalAmountSchema, ...BaseProductFields }),
  z.object({ amountType: z.literal("variable"), maxPerCharge: DecimalAmountSchema, ...BaseProductFields }),
]);
export type CreateProductInput = z.infer<typeof CreateProductSchema>;
