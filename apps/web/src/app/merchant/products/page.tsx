import Link from "next/link";
import { Plus } from "lucide-react";
import { requireMerchantSession } from "@/lib/merchant-guard";
import { listProducts } from "@/lib/merchant-api";
import { formatBillingFrequency, formatAssetSymbol } from "@/lib/format";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function ProductsPage() {
  const apiKey = await requireMerchantSession();
  const products = await listProducts(apiKey);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">Products</h2>
        <Link
          href="/merchant/products/new"
          className={buttonVariants({ size: "sm" })}
          data-testid="new-product-link"
        >
          <Plus data-icon="inline-start" /> New product
        </Link>
      </div>

      {products.length === 0 ? (
        <EmptyState
          icon={<Plus className="size-6" />}
          title="No products yet"
          description="Create a product to define its price, billing frequency, and limits — then generate a checkout link for it."
        />
      ) : (
        <Table data-testid="products-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Asset</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product) => (
              <TableRow key={product.id} data-testid={`product-row-${product.id}`}>
                <TableCell className="font-medium">{product.name}</TableCell>
                <TableCell>
                  {product.amountType === "fixed"
                    ? product.fixedAmount
                    : `Up to ${product.maxPerCharge ?? ""}`}
                </TableCell>
                <TableCell>{formatBillingFrequency(BigInt(product.periodSeconds))}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatAssetSymbol(product.assetAddress)}
                </TableCell>
                <TableCell>
                  <Badge variant={product.active ? "default" : "outline"}>
                    {product.active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    href={`/merchant/checkout-links?productId=${product.id}`}
                    data-testid={`generate-link-button-${product.id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    Generate checkout link
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
