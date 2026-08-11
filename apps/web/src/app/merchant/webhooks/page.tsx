import { Webhook } from "lucide-react";
import { requireMerchantApiKey } from "@/lib/merchant-guard";
import { getWebhookEndpointStatus, listWebhookDeliveries } from "@/lib/merchant-api";
import { WebhookEndpointForm } from "@/components/merchant/webhook-endpoint-form";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const DELIVERY_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "secondary",
  delivering: "secondary",
  delivered: "default",
  retry_scheduled: "outline",
  dead_letter: "destructive",
};

/**
 * The honest current state of each event (`docs/merchant-api.md`'s "which
 * events actually have a producer today" table) — never implies an event is
 * flowing when nothing in this system actually produces it yet.
 */
const EVENT_PRODUCER_STATUS: ReadonlyArray<{ event: string; producing: boolean; note: string }> = [
  { event: "payment.succeeded", producing: true, note: "Fired by the relayer's charge pipeline on every confirmed charge." },
  { event: "payment.failed", producing: true, note: "Fired on a permanently failed charge attempt (not on every retry)." },
  { event: "mandate.completed", producing: true, note: "Fired when a charge brings the mandate to its maximum charge count." },
  { event: "mandate.active", producing: true, note: "Phase 12c: the on-chain event indexer observes the contract's own mandate_created event." },
  { event: "mandate.paused", producing: true, note: "Phase 12c: the on-chain event indexer observes the contract's own mandate_paused event." },
  { event: "mandate.resumed", producing: true, note: "Phase 12c: the on-chain event indexer observes the contract's own mandate_resumed event." },
  { event: "mandate.revoked", producing: true, note: "Phase 12c: the on-chain event indexer observes the contract's own mandate_revoked event." },
  { event: "refund.succeeded", producing: false, note: "No relayer pipeline submits refund transactions on-chain yet." },
];

export default async function WebhooksPage() {
  const apiKey = await requireMerchantApiKey();
  const [status, deliveries] = await Promise.all([getWebhookEndpointStatus(apiKey), listWebhookDeliveries(apiKey)]);

  return (
    <div className="flex flex-col gap-6">
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Endpoint</CardTitle>
          <CardDescription>
            {status.configured ? `Currently sending to ${status.webhookUrl ?? ""}.` : "No webhook endpoint configured yet."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <WebhookEndpointForm currentUrl={status.webhookUrl} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Event coverage</CardTitle>
          <CardDescription>Which of the 8 protocol events this deployment actually produces today.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {EVENT_PRODUCER_STATUS.map((entry) => (
            <div key={entry.event} className="flex items-start justify-between gap-4 py-2.5" data-testid={`event-producer-${entry.event}`}>
              <div>
                <p className="font-mono text-sm text-foreground">{entry.event}</p>
                <p className="text-xs text-muted-foreground">{entry.note}</p>
              </div>
              <Badge variant={entry.producing ? "default" : "outline"} className="shrink-0">
                {entry.producing ? "Producing" : "Not wired yet"}
              </Badge>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-foreground">Delivery history</h2>
        {deliveries.length === 0 ? (
          <EmptyState icon={<Webhook className="size-6" />} title="No deliveries yet" description="Once events start flowing, their delivery status and attempt counts will appear here." />
        ) : (
          <Table data-testid="webhook-deliveries-table">
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead className="text-right">Last updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => (
                <TableRow key={delivery.id} data-testid={`webhook-delivery-row-${delivery.id}`}>
                  <TableCell className="font-mono text-xs">{delivery.eventType}</TableCell>
                  <TableCell>
                    <Badge variant={DELIVERY_STATUS_VARIANT[delivery.status] ?? "outline"}>{delivery.status.replace(/_/g, " ")}</Badge>
                  </TableCell>
                  <TableCell>{delivery.attemptCount}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{new Date(delivery.updatedAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
