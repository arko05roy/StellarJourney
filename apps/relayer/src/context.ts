/**
 * Resolves the two pieces of expected-state context the pipeline's
 * post-simulation verification step (decision #3) checks a fresh on-chain
 * simulation against: the merchant's own wallet address (never the mandate
 * argument — read from the `Merchant` row this `ChargeRequest` belongs to)
 * and the asset the originating `Product` declared (mirrors
 * `apps/api/src/services/asset-decimals.ts`'s join, extended to the address
 * rather than just `decimals`).
 */
import type { PrismaClient } from "./db.js";

export interface ChargeContext {
  merchantWalletAddress: string;
  expectedAssetAddress: string;
}

export class ChargeContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChargeContextError";
  }
}

export async function resolveChargeContext(prisma: PrismaClient, merchantId: string, mandateId: string): Promise<ChargeContext> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) {
    throw new ChargeContextError(`Merchant "${merchantId}" not found.`);
  }
  const checkoutSession = await prisma.checkoutSession.findFirst({
    where: { merchantId, mandateId },
    include: { product: true },
  });
  if (!checkoutSession) {
    throw new ChargeContextError(`No checkout session links merchant "${merchantId}" to mandate "${mandateId}" — cannot resolve expected asset.`);
  }
  return { merchantWalletAddress: merchant.walletAddress, expectedAssetAddress: checkoutSession.product.assetAddress };
}
