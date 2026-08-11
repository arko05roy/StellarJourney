/**
 * Resolves the declared `decimals` for the asset a given mandate charges in
 * — needed for every decimal-string <-> base-unit conversion (CLAUDE.md
 * §9) at the charge/refund boundary. `Product` is the only place this API
 * knows an asset's decimals (PLAN.md §13 doesn't put `decimals` anywhere
 * else), and every mandate this API can act on originated from a
 * `CheckoutSession` created against one of the merchant's own `Product`s —
 * so that join is the canonical, non-duplicative source, not a workaround.
 */
import { notFoundError } from "../errors.js";
import type { PrismaClient } from "../db.js";

export async function resolveAssetDecimalsForMandate(prisma: PrismaClient, merchantId: string, mandateId: string): Promise<number> {
  const checkoutSession = await prisma.checkoutSession.findFirst({
    where: { merchantId, mandateId },
    include: { product: true },
  });
  if (!checkoutSession) {
    throw notFoundError(
      "MANDATE_NOT_LINKED_TO_PRODUCT",
      "No checkout session for this merchant created this mandate — its asset's decimals are unknown.",
    );
  }
  return checkoutSession.product.assetDecimals;
}
