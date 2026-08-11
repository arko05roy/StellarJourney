import { CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatAmount, formatDate } from "@/lib/format";
import type { MandateTerms } from "@/lib/mandate-terms";

export interface ConfirmationCardProps {
  mandateId: string;
  merchantName: string;
  terms: MandateTerms;
  assetSymbol: string;
  allowanceTotal: bigint;
}

export function ConfirmationCard({ mandateId, merchantName, terms, assetSymbol, allowanceTotal }: ConfirmationCardProps) {
  const amountLabel =
    terms.amountRule.kind === "fixed"
      ? `${formatAmount(terms.amountRule.amount, terms.assetDecimals)} ${assetSymbol}`
      : `up to ${formatAmount(terms.amountRule.maxPerCharge, terms.assetDecimals)} ${assetSymbol}`;

  return (
    <Card data-testid="confirmation-card">
      <CardHeader className="flex flex-row items-center gap-2">
        <CheckCircle2 className="text-foreground" />
        <CardTitle>Automatic payment set up</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          You authorized {merchantName} to charge {amountLabel}, {" "}
          {formatBillingPhrase(terms)}, starting {formatDate(terms.startAt)}.
        </p>

        <Separator />

        <dl className="grid grid-cols-1 gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Automatic payment ID</dt>
            <dd className="break-all text-right font-mono text-xs">{mandateId}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Merchant can charge starting</dt>
            <dd className="text-right font-medium">{formatDate(terms.startAt)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Approved spending limit</dt>
            <dd className="text-right font-medium">
              {formatAmount(allowanceTotal, terms.assetDecimals)} {assetSymbol}
            </dd>
          </div>
        </dl>

        <Separator />

        <p className="text-sm text-muted-foreground">
          You can cancel autopay at any time from your payment dashboard. Cancelling stops every future charge
          immediately.
        </p>
      </CardContent>
    </Card>
  );
}

function formatBillingPhrase(terms: MandateTerms): string {
  const seconds = Number(terms.periodSeconds);
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `every ${days === 30 ? "30 days" : `${String(days)} day${days === 1 ? "" : "s"}`}`;
  }
  return `every ${String(seconds)} seconds`;
}
