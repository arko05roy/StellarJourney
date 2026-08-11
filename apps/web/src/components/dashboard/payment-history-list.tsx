/**
 * Payment history: successful payments *and* failed charge attempts with a
 * human-readable reason (`tasks/todo.md` Phase 11 requirement). A failed
 * attempt is presented as proof the protection worked, not as a scary
 * error — `describeFailureReason` (`lib/failure-reasons.ts`) frames it that
 * way; the stable machine code is always shown alongside, small, for
 * support (CLAUDE.md §8).
 */
import { CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";
// Narrow subpath import — see `apps/web/src/lib/format.ts`'s identical comment.
import { decimalToBaseUnits } from "@paymap/shared/money";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatAmount, formatAssetSymbol, formatDateTime } from "@/lib/format";
import { describeFailureReason } from "@/lib/failure-reasons";
import type { ConsumerFailedAttempt, ConsumerPayment } from "@/lib/dashboard-api";

export interface PaymentHistoryListProps {
  payments: ConsumerPayment[];
  failedAttempts: ConsumerFailedAttempt[];
  network: string;
  /** Resolver since each row's decimals may differ by merchant/mandate (a single dashboard spans every merchant this payer has authorized). */
  assetDecimalsFor: (mandateId: string) => number;
}

/** `unixSecondsFromIso` — the API returns ISO 8601 (CLAUDE.md §9); display formatting here works in Unix seconds like the rest of this app's date helpers. */
function unixSecondsFromIso(iso: string): bigint {
  return BigInt(Math.floor(new Date(iso).getTime() / 1000));
}

function PaymentRow({
  payment,
  decimals,
  network,
}: {
  payment: ConsumerPayment;
  decimals: number;
  network: string;
}) {
  const amount = decimalToBaseUnits(payment.amount, decimals);
  return (
    <li
      className="relative grid grid-cols-[2rem_1fr] gap-3 pb-7 last:pb-0"
      data-testid="payment-history-success-row"
    >
      <div className="relative z-10 flex size-8 items-center justify-center rounded-full border border-emerald-600/30 bg-background text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="size-4" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-col gap-2 pt-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{payment.merchant.name}</p>
          <p className="text-xs text-muted-foreground">
            Payment settled · {formatDateTime(unixSecondsFromIso(payment.createdAt))}
          </p>
          <a
            href={`https://stellar.expert/explorer/${network}/tx/${payment.transactionHash}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex max-w-full items-center gap-1 font-mono text-[10px] text-muted-foreground underline decoration-foreground/20 underline-offset-4 hover:text-foreground"
            aria-label={`View transaction ${payment.transactionHash} on Stellar Expert`}
          >
            <span className="truncate">
              {payment.transactionHash.slice(0, 12)}…{payment.transactionHash.slice(-8)}
            </span>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </a>
        </div>
        <p className="shrink-0 text-sm font-medium tabular-nums text-foreground">
          {formatAmount(amount, decimals)} {formatAssetSymbol(payment.assetAddress)}
        </p>
      </div>
    </li>
  );
}

function FailedAttemptRow({ attempt }: { attempt: ConsumerFailedAttempt }) {
  const reason = describeFailureReason(attempt.failureCode ?? "");
  return (
    <li
      className="relative grid grid-cols-[2rem_1fr] gap-3 pb-7 last:pb-0"
      data-testid="payment-history-failed-row"
    >
      <div className="relative z-10 flex size-8 items-center justify-center rounded-full border border-amber-600/30 bg-background text-amber-700 dark:text-amber-400">
        <ShieldCheck className="size-4" aria-hidden="true" />
      </div>
      <div className="flex min-w-0 items-start justify-between gap-4 pt-1">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{reason.headline}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{reason.explanation}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {attempt.merchant.name} · Blocked{" "}
            {formatDateTime(unixSecondsFromIso(attempt.attemptedAt))}
          </p>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 font-mono text-[10px]"
          title="Machine-readable code, for support"
        >
          {reason.code}
        </Badge>
      </div>
    </li>
  );
}

type TimelineItem =
  | { kind: "payment"; timestamp: string; value: ConsumerPayment }
  | { kind: "failed"; timestamp: string; value: ConsumerFailedAttempt };

export function PaymentHistoryList({
  payments,
  failedAttempts,
  network,
  assetDecimalsFor,
}: PaymentHistoryListProps) {
  if (payments.length === 0 && failedAttempts.length === 0) {
    return (
      <Card data-testid="payment-history-empty">
        <CardContent className="flex flex-col items-center gap-1 py-10 text-center">
          <p className="text-sm font-medium text-foreground">No payments yet</p>
          <p className="text-sm text-muted-foreground">
            Successful charges and any blocked attempts will show up here.
          </p>
        </CardContent>
      </Card>
    );
  }

  const timeline: TimelineItem[] = [
    ...payments.map((value): TimelineItem => ({
      kind: "payment",
      timestamp: value.createdAt,
      value,
    })),
    ...failedAttempts.map((value): TimelineItem => ({
      kind: "failed",
      timestamp: value.attemptedAt,
      value,
    })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          Ledger activity
        </p>
        <h3 className="mt-1 text-base font-medium text-foreground">Transaction timeline</h3>
        <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
          Settled payments and blocked attempts, ordered newest first. Blocked entries prove your
          on-chain limits stopped money before it moved.
        </p>
      </div>
      <Card data-testid="transaction-timeline">
        <CardContent className="relative py-5 before:absolute before:bottom-8 before:left-[2.01rem] before:top-8 before:w-px before:bg-border">
          <ol aria-label="Transaction timeline">
            {timeline.map((item) =>
              item.kind === "payment" ? (
                <PaymentRow
                  key={`payment:${item.value.paymentId}`}
                  payment={item.value}
                  decimals={assetDecimalsFor(item.value.mandateId)}
                  network={network}
                />
              ) : (
                <FailedAttemptRow key={`failed:${item.value.id}`} attempt={item.value} />
              ),
            )}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
