/**
 * Every mandate term, always visible, on one screen (CLAUDE.md §13: "Never
 * hide critical terms inside an expandable section"). This component
 * intentionally contains no `<details>`, no accordion/collapse primitive,
 * and no "show more" affordance anywhere — `terms-list.test.tsx` asserts
 * that directly. Consumer language first ("Automatic payment", "Maximum
 * charge", "Billing frequency"), the underlying technical value shown
 * secondarily (PLAN.md §16.4).
 */
import { formatAmount, formatBillingFrequency, formatDate, formatMinInterval } from "@/lib/format";
import type { MandateTerms } from "@/lib/mandate-terms";

export interface TermsListProps {
  merchantName: string;
  productName: string;
  assetSymbol: string;
  terms: MandateTerms;
}

function Term({ label, value, detail }: { label: string; value: string; detail?: string | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">
        {value}
        {detail !== undefined ? <span className="ml-1.5 font-normal text-muted-foreground">{detail}</span> : null}
      </dd>
    </div>
  );
}

export function TermsList({ merchantName, productName, assetSymbol, terms }: TermsListProps) {
  const amountLabel =
    terms.amountRule.kind === "fixed"
      ? `${formatAmount(terms.amountRule.amount, terms.assetDecimals)} ${assetSymbol}`
      : `Up to ${formatAmount(terms.amountRule.maxPerCharge, terms.assetDecimals)} ${assetSymbol}`;

  return (
    <dl className="divide-y divide-border" data-testid="terms-list">
      <Term label="Merchant" value={merchantName} />
      <Term label="Product" value={productName} />
      <Term label="Payment asset" value={assetSymbol} detail={`(${terms.assetAddress.slice(0, 6)}…${terms.assetAddress.slice(-4)})`} />
      <Term
        label={terms.amountRule.kind === "fixed" ? "Amount" : "Maximum charge"}
        value={amountLabel}
        detail={terms.amountRule.kind === "fixed" ? "fixed amount" : "variable, capped"}
      />
      <Term
        label="Maximum per billing period"
        value={`${formatAmount(terms.maxPerPeriod, terms.assetDecimals)} ${assetSymbol}`}
      />
      <Term label="Billing frequency" value={formatBillingFrequency(terms.periodSeconds)} />
      <Term label="Minimum time between charges" value={formatMinInterval(terms.minIntervalSeconds)} />
      <Term label="Start date" value={formatDate(terms.startAt)} />
      <Term label="Expiry date" value={formatDate(terms.expiresAt)} />
      <Term
        label="Maximum number of charges"
        value={terms.maxSuccessfulCharges === 0 ? "No limit" : String(terms.maxSuccessfulCharges)}
        detail={terms.maxSuccessfulCharges === 0 ? "bounded only by the period and expiry limits above" : undefined}
      />
    </dl>
  );
}
