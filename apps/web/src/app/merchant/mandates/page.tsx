import Link from "next/link";
import { Users } from "lucide-react";
import { requireMerchantApiKey } from "@/lib/merchant-guard";
import { listMandates, listProducts } from "@/lib/merchant-api";
import { formatMandateAmountRule, resolveAssetDecimals } from "@/lib/merchant-mandate-display";
import { formatBillingFrequency } from "@/lib/format";
import { MandateStatusBadge } from "@/components/dashboard/status-badge";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default async function MandatesPage() {
  const apiKey = await requireMerchantApiKey();
  const [rows, products] = await Promise.all([listMandates(apiKey), listProducts(apiKey)]);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-foreground">Active mandates</h2>
      {rows.length === 0 ? (
        <EmptyState
          icon={<Users className="size-6" />}
          title="No mandates yet"
          description="Once a customer authorizes a checkout link, their mandate will appear here with its live on-chain status."
        />
      ) : (
        <Table data-testid="mandates-table">
          <TableHeader>
            <TableRow>
              <TableHead>Payer</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.mandateId} data-testid={`mandate-row-${row.mandateId}`}>
                {row.live ? (
                  <>
                    <TableCell className="font-mono text-xs">{row.mandate.payer.slice(0, 6)}…{row.mandate.payer.slice(-6)}</TableCell>
                    <TableCell>{formatMandateAmountRule(row.mandate, resolveAssetDecimals(products, row.mandate.asset))}</TableCell>
                    <TableCell>{formatBillingFrequency(BigInt(row.mandate.periodSeconds))}</TableCell>
                    <TableCell>
                      <MandateStatusBadge status={row.mandate.status} />
                    </TableCell>
                  </>
                ) : (
                  <>
                    <TableCell colSpan={3} className="text-sm text-muted-foreground">
                      Could not read live on-chain state for this mandate right now.
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" title="Last known status — not a live on-chain read">
                        {row.cachedStatus} (cached)
                      </Badge>
                    </TableCell>
                  </>
                )}
                <TableCell className="text-right">
                  <Link href={`/merchant/mandates/${row.mandateId}`} className="text-sm font-medium text-primary hover:underline" data-testid={`mandate-detail-link-${row.mandateId}`}>
                    View
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
