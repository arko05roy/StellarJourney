import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { requireMerchantApiKey } from "@/lib/merchant-guard";
import { listCharges } from "@/lib/merchant-api";
import { describeFailureReason } from "@/lib/failure-reasons";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/** The three infra-transient reasons the relayer's classifier can attach (`apps/relayer/src/classify.ts`) — everything else is one of the 24 frozen contract error names, i.e. the protocol correctly enforcing a mandate's own limits. */
const INFRA_TRANSIENT_CODES = new Set(["RPC_UNAVAILABLE", "SEND_FAILED", "TX_NOT_INCLUDED"]);

export default async function FailedCollectionsPage() {
  const apiKey = await requireMerchantApiKey();
  const charges = await listCharges(apiKey, { status: ["retryable_failed", "permanently_failed"] });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Failed collections</h2>
        <p className="text-sm text-muted-foreground">
          Most of these are the protocol correctly blocking a charge that did not match the mandate's own terms — not a bug, and no money
          moved. A smaller number are temporary network/submission issues, marked separately below.
        </p>
      </div>
      {charges.length === 0 ? (
        <EmptyState icon={<ShieldCheck className="size-6" />} title="No failed collections" description="Blocked or failed charge attempts will appear here with the exact reason." />
      ) : (
        <Card data-testid="failed-collections-list">
          <CardContent className="divide-y divide-border">
            {charges.map((charge) => {
              const reason = describeFailureReason(charge.failureCode ?? "");
              const isInfra = charge.failureCode !== undefined && INFRA_TRANSIENT_CODES.has(charge.failureCode);
              return (
                <div key={charge.id} className="flex items-start justify-between gap-4 py-3" data-testid={`failed-charge-row-${charge.id}`}>
                  <div>
                    <p className="text-sm font-medium text-foreground">{reason.headline}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{reason.explanation}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {charge.amount} ·{" "}
                      <Link href={`/merchant/mandates/${charge.mandateId}`} className="hover:underline">
                        View mandate
                      </Link>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant={isInfra ? "secondary" : "outline"} title={isInfra ? "Temporary network/submission issue, not a policy rejection" : "The mandate's own rules correctly blocked this charge"}>
                      {isInfra ? "Temporary issue" : "Blocked by mandate rules"}
                    </Badge>
                    <Badge variant="outline" className="font-mono text-[10px]" title="Machine-readable code, for support">
                      {reason.code}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
