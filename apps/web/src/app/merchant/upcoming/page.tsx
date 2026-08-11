import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { requireMerchantSession } from "@/lib/merchant-guard";
import { listMandates, listProducts, type MerchantMandateListRow } from "@/lib/merchant-api";
import {
  formatMandateAmountRule,
  resolveAssetDecimals,
  toBigintMandate,
} from "@/lib/merchant-mandate-display";
import { formatDate } from "@/lib/format";
import { computeNextEligibleChargeDate } from "@/lib/mandate-status";
import { EmptyState } from "@/components/dashboard/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function UpcomingCollectionsPage() {
  const apiKey = await requireMerchantSession();
  const [rows, products] = await Promise.all([listMandates(apiKey), listProducts(apiKey)]);

  function isLiveActive(
    row: MerchantMandateListRow,
  ): row is Extract<MerchantMandateListRow, { live: true }> {
    return row.live && row.mandate.status === "Active";
  }

  const upcoming: {
    row: Extract<MerchantMandateListRow, { live: true }>;
    nextEligibleAt: bigint;
  }[] = rows
    .filter(isLiveActive)
    .map((row) => ({
      row,
      nextEligibleAt: computeNextEligibleChargeDate(toBigintMandate(row.mandate)),
    }))
    .filter(
      (
        entry,
      ): entry is {
        row: Extract<MerchantMandateListRow, { live: true }>;
        nextEligibleAt: bigint;
      } => entry.nextEligibleAt !== undefined,
    )
    .sort((a, b) =>
      a.nextEligibleAt < b.nextEligibleAt ? -1 : a.nextEligibleAt > b.nextEligibleAt ? 1 : 0,
    );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Upcoming collections</h2>
        <p className="text-sm text-muted-foreground">
          The next date each active mandate becomes eligible for a charge, computed from live
          on-chain state — not a schedule this API enforces on its own.
        </p>
      </div>
      {upcoming.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="size-6" />}
          title="Nothing upcoming"
          description="Active mandates eligible for a future charge will appear here."
        />
      ) : (
        <Table data-testid="upcoming-collections-table">
          <TableHeader>
            <TableRow>
              <TableHead>Payer</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Next eligible</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {upcoming.map(({ row, nextEligibleAt }) => (
              <TableRow key={row.mandateId} data-testid={`upcoming-row-${row.mandateId}`}>
                <TableCell className="font-mono text-xs">
                  {row.mandate.payer.slice(0, 6)}…{row.mandate.payer.slice(-6)}
                </TableCell>
                <TableCell>
                  {formatMandateAmountRule(
                    row.mandate,
                    resolveAssetDecimals(products, row.mandate.asset),
                  )}
                </TableCell>
                <TableCell>{formatDate(nextEligibleAt)}</TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/merchant/mandates/${row.mandateId}`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
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
