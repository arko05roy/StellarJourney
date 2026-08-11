import { requireMerchantSession } from "@/lib/merchant-guard";
import { listCheckoutSessions, listProducts } from "@/lib/merchant-api";
import { CheckoutLinkForm } from "@/components/merchant/checkout-link-form";
import { CopyLinkButton } from "@/components/merchant/copy-link-button";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link2 } from "lucide-react";

const SESSION_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  pending: "secondary",
  completed: "default",
  expired: "outline",
  canceled: "outline",
};

export default async function CheckoutLinksPage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string }>;
}) {
  const apiKey = await requireMerchantSession();
  const { productId } = await searchParams;
  const [products, sessions] = await Promise.all([
    listProducts(apiKey),
    listCheckoutSessions(apiKey),
  ]);
  const productNameById = new Map(products.map((p) => [p.id, p.name]));

  return (
    <div className="flex flex-col gap-6">
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Generate a checkout link</CardTitle>
          <CardDescription>
            Share this link with a customer to start the automatic-payment authorization flow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CheckoutLinkForm products={products} defaultProductId={productId} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        <h2 className="text-base font-semibold text-foreground">Recent checkout links</h2>
        {sessions.length === 0 ? (
          <EmptyState
            icon={<Link2 className="size-6" />}
            title="No checkout links yet"
            description="Generate one above to see it here, along with its status."
          />
        ) : (
          <Table data-testid="checkout-links-table">
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id} data-testid={`checkout-session-row-${session.id}`}>
                  <TableCell className="font-medium">
                    {productNameById.get(session.productId) ?? session.productId}
                  </TableCell>
                  <TableCell>
                    <Badge variant={SESSION_STATUS_VARIANT[session.status] ?? "outline"}>
                      {session.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(session.expiresAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <CopyLinkButton path={`/checkout/${session.id}`} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
