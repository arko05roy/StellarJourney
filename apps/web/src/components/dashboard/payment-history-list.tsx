/**
 * Payment history: successful payments *and* failed charge attempts with a
 * human-readable reason (`tasks/todo.md` Phase 11 requirement). A failed
 * attempt is presented as proof the protection worked, not as a scary
 * error — `describeFailureReason` (`lib/failure-reasons.ts`) frames it that
 * way; the stable machine code is always shown alongside, small, for
 * support (CLAUDE.md §8).
 */
import { CheckCircle2, ShieldCheck } from "lucide-react";
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
  /** Resolver since each row's decimals may differ by merchant/mandate (a single dashboard spans every merchant this payer has authorized). */
  assetDecimalsFor: (mandateId: string) => number;
}

/** `unixSecondsFromIso` — the API returns ISO 8601 (CLAUDE.md §9); display formatting here works in Unix seconds like the rest of this app's date helpers. */
function unixSecondsFromIso(iso: string): bigint {
  return BigInt(Math.floor(new Date(iso).getTime() / 1000));
}

function PaymentRow({ payment, decimals }: { payment: ConsumerPayment; decimals: number }) {
  const amount = decimalToBaseUnits(payment.amount, decimals);
  return (
    <div className="flex items-center justify-between gap-4 py-3" data-testid="payment-history-success-row">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div>
          <p className="text-sm font-medium text-foreground">{payment.merchant.name}</p>
          <p className="text-xs text-muted-foreground">{formatDateTime(unixSecondsFromIso(payment.createdAt))}</p>
        </div>
      </div>
      <p className="text-sm font-medium tabular-nums text-foreground">
        {formatAmount(amount, decimals)} {formatAssetSymbol(payment.assetAddress)}
      </p>
    </div>
  );
}

function FailedAttemptRow({ attempt }: { attempt: ConsumerFailedAttempt }) {
  const reason = describeFailureReason(attempt.failureCode ?? "");
  return (
    <div className="flex items-start justify-between gap-4 py-3" data-testid="payment-history-failed-row">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div>
          <p className="text-sm font-medium text-foreground">{reason.headline}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{reason.explanation}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {attempt.merchant.name} · {formatDateTime(unixSecondsFromIso(attempt.attemptedAt))}
          </p>
        </div>
      </div>
      <Badge variant="outline" className="shrink-0 font-mono text-[10px]" title="Machine-readable code, for support">
        {reason.code}
      </Badge>
    </div>
  );
}

export function PaymentHistoryList({ payments, failedAttempts, assetDecimalsFor }: PaymentHistoryListProps) {
  if (payments.length === 0 && failedAttempts.length === 0) {
    return (
      <Card data-testid="payment-history-empty">
        <CardContent className="flex flex-col items-center gap-1 py-10 text-center">
          <p className="text-sm font-medium text-foreground">No payments yet</p>
          <p className="text-sm text-muted-foreground">Successful charges and any blocked attempts will show up here.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {payments.length > 0 ? (
        <Card>
          <CardContent className="divide-y divide-border">
            {payments.map((payment) => (
              <PaymentRow key={payment.paymentId} payment={payment} decimals={assetDecimalsFor(payment.mandateId)} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {failedAttempts.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-medium text-foreground">Blocked attempts</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Every one of these is your automatic payment's protection working as intended — a charge that didn't match your terms was
            blocked before any money moved.
          </p>
          <Card>
            <CardContent className="divide-y divide-border">
              {failedAttempts.map((attempt) => (
                <FailedAttemptRow key={attempt.id} attempt={attempt} />
              ))}
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
