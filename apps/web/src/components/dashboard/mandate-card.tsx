/**
 * Every field PLAN.md §16.1 requires on a mandate card, sourced from a live
 * `get_mandate` read (`mandate` prop) — never the `MandateIndex` DB cache
 * (CLAUDE.md §2). Controls are enabled/disabled per
 * `lib/mandate-status.ts::deriveControlAvailability`, mirroring the
 * contract's own legal-transition table so a disabled button can never be
 * clicked into a rejected call.
 */
import { Ban, Pause, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorBanner } from "@/components/checkout/error-banner";
import { formatAmount, formatAssetSymbol, formatBillingFrequency, formatDate } from "@/lib/format";
import {
  computeEffectivePeriodUsage,
  computeNextEligibleChargeDate,
  deriveControlAvailability,
  deriveEffectiveStatus,
} from "@/lib/mandate-status";
import type { DisplayError } from "@/lib/errors";
import type { Mandate } from "@paymap/contract-client";
import { MandateStatusBadge } from "./status-badge";
import { PeriodUsageMeter } from "./period-usage-meter";

export type MandateCardAction = "pause" | "resume";
export interface MandateCardActionState {
  pending?: MandateCardAction;
  error?: { action: MandateCardAction; display: DisplayError };
}

export interface MandateCardProps {
  mandate: Mandate;
  merchantName: string;
  /** Resolved from the merchant's product catalog (`/v1/consumer/mandates`'s `assetDecimals`, falling back to 7) — the on-chain `Mandate` itself carries no decimals field (CLAUDE.md §9). */
  assetDecimals: number;
  nowUnixSeconds: bigint;
  actionState?: MandateCardActionState | undefined;
  onPause?: () => void;
  onResume?: () => void;
  onCancelAutopay?: () => void;
  onViewHistory?: () => void;
}

function Field({ label, value, detail }: { label: string; value: string; detail?: string | undefined }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">
        {value}
        {detail !== undefined ? <span className="ml-1.5 font-normal text-muted-foreground">{detail}</span> : null}
      </dd>
    </div>
  );
}

export function MandateCard({ mandate, merchantName, assetDecimals, nowUnixSeconds, actionState = {}, onPause, onResume, onCancelAutopay, onViewHistory }: MandateCardProps) {
  const status = deriveEffectiveStatus(mandate, nowUnixSeconds);
  const availability = deriveControlAvailability(status);
  const assetSymbol = formatAssetSymbol(mandate.asset);
  const nextEligible = computeNextEligibleChargeDate({ ...mandate, status });
  const periodUsage = computeEffectivePeriodUsage(mandate, nowUnixSeconds);

  const amountLabel =
    mandate.amountRule.kind === "fixed"
      ? `${formatAmount(mandate.amountRule.amount, assetDecimals)} ${assetSymbol}`
      : `Up to ${formatAmount(mandate.amountRule.maxPerCharge, assetDecimals)} ${assetSymbol}`;

  return (
    <Card data-testid={`mandate-card-item-${mandate.id}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{merchantName}</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">{formatBillingFrequency(mandate.periodSeconds)}</p>
        </div>
        <MandateStatusBadge status={status} />
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <dl className="divide-y divide-border" data-testid="mandate-card-fields">
          <Field label="Payment asset" value={assetSymbol} detail={`(${mandate.asset.slice(0, 6)}…${mandate.asset.slice(-4)})`} />
          <Field label={mandate.amountRule.kind === "fixed" ? "Amount" : "Maximum charge"} value={amountLabel} />
          <Field
            label="Next eligible charge"
            value={nextEligible !== undefined ? formatDate(nextEligible) : "None"}
            detail={nextEligible === undefined ? "no future charge is possible" : undefined}
          />
          <Field label="Expiry" value={formatDate(mandate.expiresAt)} />
          <Field
            label="Charges so far"
            value={mandate.maxSuccessfulCharges === 0 ? `${String(mandate.successfulCharges)}` : `${String(mandate.successfulCharges)} / ${String(mandate.maxSuccessfulCharges)}`}
          />
        </dl>

        <PeriodUsageMeter usage={periodUsage} assetDecimals={assetDecimals} assetSymbol={assetSymbol} />

        {actionState.error ? <ErrorBanner error={actionState.error.display} /> : null}

        <div className="flex flex-wrap gap-2">
          {availability.canPause ? (
            <Button type="button" variant="outline" size="sm" disabled={actionState.pending === "pause"} onClick={onPause} data-testid="pause-button">
              <Pause data-icon="inline-start" />
              {actionState.pending === "pause" ? "Pausing…" : "Pause"}
            </Button>
          ) : null}
          {availability.canResume ? (
            <Button type="button" variant="outline" size="sm" disabled={actionState.pending === "resume"} onClick={onResume} data-testid="resume-button">
              <Play data-icon="inline-start" />
              {actionState.pending === "resume" ? "Resuming…" : "Resume"}
            </Button>
          ) : null}
          {availability.canCancelAutopay ? (
            <Button type="button" variant="destructive" size="sm" onClick={onCancelAutopay} data-testid="cancel-autopay-button">
              <Ban data-icon="inline-start" />
              Cancel autopay
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={onViewHistory} data-testid="view-history-button" className="ml-auto">
            View history
          </Button>
        </div>

        {status === "Revoked" || status === "Completed" || status === "Expired" ? (
          <Badge variant="outline" className="w-fit" data-testid="mandate-terminal-note">
            No further charges are possible.
          </Badge>
        ) : null}
      </CardContent>
    </Card>
  );
}
