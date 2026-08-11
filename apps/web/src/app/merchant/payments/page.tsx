import Link from "next/link";
import { Receipt } from "lucide-react";
import { requireMerchantApiKey } from "@/lib/merchant-guard";
import { listPayments } from "@/lib/merchant-api";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buttonVariants } from "@/components/ui/button";

export default async function PaymentsPage() {
  const apiKey = await requireMerchantApiKey();
  const payments = await listPayments(apiKey);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-foreground">Payments</h2>
      {payments.length === 0 ? (
        <EmptyState icon={<Receipt className="size-6" />} title="No payments yet" description="Confirmed on-chain charges will appear here." />
      ) : (
        <Table data-testid="payments-table">
          <TableHeader>
            <TableRow>
              <TableHead>Amount</TableHead>
              <TableHead>Refunded</TableHead>
              <TableHead>Mandate</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((payment) => (
              <TableRow key={payment.paymentId} data-testid={`payment-row-${payment.paymentId}`}>
                <TableCell className="font-medium">{payment.amount}</TableCell>
                <TableCell className="text-muted-foreground">{payment.refundedTotal}</TableCell>
                <TableCell>
                  <Link href={`/merchant/mandates/${payment.mandateId}`} className="text-sm text-primary hover:underline">
                    {payment.mandateId.slice(0, 8)}…
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground">{new Date(payment.createdAt).toLocaleDateString()}</TableCell>
                <TableCell className="text-right">
                  <Link href={`/merchant/payments/${payment.paymentId}/refund`} className={buttonVariants({ variant: "outline", size: "sm" })} data-testid={`refund-link-${payment.paymentId}`}>
                    Refund
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
