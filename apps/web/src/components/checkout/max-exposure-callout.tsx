/**
 * The single most important number on the checkout screen (tasks/todo.md's
 * explicit Phase 10 requirement): the maximum this merchant could ever
 * collect in total under this mandate. Always rendered, never collapsed.
 */
import { formatAmount } from "@/lib/format";

export interface MaxExposureCalloutProps {
  maxExposureBaseUnits: bigint;
  assetDecimals: number;
  assetSymbol: string;
}

export function MaxExposureCallout({ maxExposureBaseUnits, assetDecimals, assetSymbol }: MaxExposureCalloutProps) {
  return (
    <div className="rounded-lg border border-foreground/15 bg-muted/40 px-4 py-3.5" data-testid="max-exposure-callout">
      <p className="text-xs font-medium text-muted-foreground">Maximum you could ever be charged</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
        {formatAmount(maxExposureBaseUnits, assetDecimals)} <span className="text-base font-medium text-muted-foreground">{assetSymbol}</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        This merchant can never collect more than this amount in total, across the entire lifetime of this automatic payment.
      </p>
    </div>
  );
}
