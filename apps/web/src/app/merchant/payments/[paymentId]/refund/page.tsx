import { notFound } from "next/navigation";
import { requireMerchantApiKey } from "@/lib/merchant-guard";
import { listPayments, listProducts } from "@/lib/merchant-api";
import { computeRefundableRemainingBaseUnits } from "@/lib/merchant-refund-form";
import { resolveAssetDecimals } from "@/lib/merchant-mandate-display";
import { formatAssetSymbol } from "@/lib/format";
import { RefundForm } from "@/components/merchant/refund-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default async function RefundPaymentPage({ params }: { params: Promise<{ paymentId: string }> }) {
  const apiKey = await requireMerchantApiKey();
  const { paymentId } = await params;

  // No single-payment read endpoint exists yet (`apps/api` only exposes a
  // merchant-scoped list) — found by scanning the merchant's own recent
  // payments, which is correct (never another merchant's payment can match)
  // even if not the most efficient possible lookup for a very large history.
  const [payments, products] = await Promise.all([listPayments(apiKey), listProducts(apiKey)]);
  const payment = payments.find((p) => p.paymentId === paymentId);
  if (!payment) notFound();

  const decimals = resolveAssetDecimals(products, payment.assetAddress);
  const remaining = computeRefundableRemainingBaseUnits(payment, decimals);
  const assetSymbol = formatAssetSymbol(payment.assetAddress);

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle>Refund payment</CardTitle>
        <CardDescription>
          Original amount: {payment.amount} {assetSymbol}. Already refunded: {payment.refundedTotal} {assetSymbol}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RefundForm paymentId={payment.paymentId} decimals={decimals} remainingBaseUnits={remaining.toString()} assetSymbol={assetSymbol} />
      </CardContent>
    </Card>
  );
}
