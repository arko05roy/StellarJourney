import { Progress } from "@/components/ui/progress";
import { formatAmount } from "@/lib/format";
import type { EffectivePeriodUsage } from "@/lib/mandate-status";

export interface PeriodUsageMeterProps {
  usage: EffectivePeriodUsage;
  assetDecimals: number;
  assetSymbol: string;
}

/** Collected-this-period vs `max_per_period`, as a meter — PLAN.md §16.1's "period usage" card field. `usage` is the *effective* (as-of-now) period, not the mandate's raw stored fields, so an idle mandate never shows a stale "full" meter (see `lib/mandate-status.ts`). */
export function PeriodUsageMeter({ usage, assetDecimals, assetSymbol }: PeriodUsageMeterProps) {
  const percent = usage.max > 0n ? Math.min(100, Number((usage.collected * 100n) / usage.max)) : 0;
  return (
    <div className="flex flex-col gap-1.5" data-testid="period-usage-meter">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">This billing period</span>
        <span className="font-medium tabular-nums text-foreground">
          {formatAmount(usage.collected, assetDecimals)} / {formatAmount(usage.max, assetDecimals)} {assetSymbol}
        </span>
      </div>
      {/* `Progress` (`components/ui/progress.tsx`) renders its own track/indicator internally — no nested children needed here. */}
      <Progress value={percent} aria-label="Amount collected this billing period" />
    </div>
  );
}
