import { Undo2 } from "lucide-react";
import { requireMerchantApiKey } from "@/lib/merchant-guard";
import { listRefunds } from "@/lib/merchant-api";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  scheduled: "secondary",
  processing: "secondary",
  simulated: "secondary",
  submitted: "secondary",
  succeeded: "default",
  retryable_failed: "outline",
  permanently_failed: "destructive",
};

export default async function RefundsPage() {
  const apiKey = await requireMerchantApiKey();
  const refunds = await listRefunds(apiKey);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Refunds</h2>
        <p className="text-sm text-muted-foreground">Initiate a refund from a payment's row on the Payments page. Every refund here is tracked to its original payment, full or partial.</p>
      </div>
      {refunds.length === 0 ? (
        <EmptyState icon={<Undo2 className="size-6" />} title="No refunds yet" description="Refunds you issue from a payment's row will appear here." />
      ) : (
        <Table data-testid="refunds-table">
          <TableHeader>
            <TableRow>
              <TableHead>Amount</TableHead>
              <TableHead>Payment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Requested</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {refunds.map((refund) => (
              <TableRow key={refund.id} data-testid={`refund-row-${refund.id}`}>
                <TableCell className="font-medium">{refund.amount}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {refund.paymentId.slice(0, 8)}…{refund.paymentId.slice(-6)}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[refund.status] ?? "outline"}>{refund.status.replace(/_/g, " ")}</Badge>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{new Date(refund.createdAt).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
