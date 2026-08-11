import Link from "next/link";
import { requireMerchantSession } from "@/lib/merchant-guard";
import { getMandate, listPayments, listProducts, MerchantApiError } from "@/lib/merchant-api";
import {
  formatMandateAmountRule,
  resolveAssetDecimals,
  toBigintMandate,
} from "@/lib/merchant-mandate-display";
import {
  formatAmount,
  formatAssetSymbol,
  formatBillingFrequency,
  formatDate,
  formatMinInterval,
} from "@/lib/format";
import { computeEffectivePeriodUsage, computeNextEligibleChargeDate } from "@/lib/mandate-status";
import { MandateStatusBadge } from "@/components/dashboard/status-badge";
import { PeriodUsageMeter } from "@/components/dashboard/period-usage-meter";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { notFound } from "next/navigation";
import { Receipt } from "lucide-react";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

export default async function MandateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const apiKey = await requireMerchantSession();
  const { id } = await params;

  let mandate;
  try {
    mandate = await getMandate(apiKey, id);
  } catch (error) {
    if (error instanceof MerchantApiError && error.status === 404) notFound();
    throw error;
  }

  const [products, payments] = await Promise.all([
    listProducts(apiKey),
    listPayments(apiKey, { mandateId: id }),
  ]);
  const decimals = resolveAssetDecimals(products, mandate.asset);
  const assetSymbol = formatAssetSymbol(mandate.asset);
  const bigintMandate = toBigintMandate(mandate);
  const nowUnixSeconds = BigInt(Math.floor(Date.now() / 1000));
  const periodUsage = computeEffectivePeriodUsage(bigintMandate, nowUnixSeconds);
  const nextEligible = computeNextEligibleChargeDate(bigintMandate);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/merchant/mandates"
          className="text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          &larr; Back to mandates
        </Link>
      </div>

      <Card data-testid="mandate-detail-card">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="font-mono text-sm">{mandate.payer}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mandate {mandate.id.slice(0, 10)}…
            </p>
          </div>
          <MandateStatusBadge status={mandate.status} />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="divide-y divide-border">
            <Field
              label={mandate.amountRule.kind === "fixed" ? "Amount" : "Maximum charge"}
              value={`${formatMandateAmountRule(mandate, decimals)} ${assetSymbol}`}
            />
            <Field
              label="Maximum per billing period"
              value={`${formatAmount(bigintMandate.maxPerPeriod, decimals)} ${assetSymbol}`}
            />
            <Field
              label="Billing frequency"
              value={formatBillingFrequency(bigintMandate.periodSeconds)}
            />
            <Field
              label="Minimum interval"
              value={formatMinInterval(bigintMandate.minIntervalSeconds)}
            />
            <Field label="Start" value={formatDate(bigintMandate.startAt)} />
            <Field label="Expiry" value={formatDate(bigintMandate.expiresAt)} />
            <Field
              label="Charges so far"
              value={
                mandate.maxSuccessfulCharges === 0
                  ? String(mandate.successfulCharges)
                  : `${String(mandate.successfulCharges)} / ${String(mandate.maxSuccessfulCharges)}`
              }
            />
            <Field
              label="Next eligible charge"
              value={
                nextEligible !== undefined
                  ? formatDate(nextEligible)
                  : "None — no future charge is possible"
              }
            />
          </dl>
          <PeriodUsageMeter
            usage={periodUsage}
            assetDecimals={decimals}
            assetSymbol={assetSymbol}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-foreground">Charge history</h2>
        {payments.length === 0 ? (
          <EmptyState
            icon={<Receipt className="size-6" />}
            title="No successful charges yet"
            description="Confirmed on-chain charges against this mandate will appear here."
          />
        ) : (
          <Table data-testid="mandate-payments-table">
            <TableHeader>
              <TableRow>
                <TableHead>Amount</TableHead>
                <TableHead>Refunded</TableHead>
                <TableHead>Transaction</TableHead>
                <TableHead className="text-right">Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((payment) => (
                <TableRow key={payment.paymentId}>
                  <TableCell>{payment.amount}</TableCell>
                  <TableCell className="text-muted-foreground">{payment.refundedTotal}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {payment.transactionHash.slice(0, 8)}…{payment.transactionHash.slice(-6)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {new Date(payment.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
