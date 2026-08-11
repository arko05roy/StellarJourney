import { requireMerchantSession } from "@/lib/merchant-guard";
import { ProductForm } from "@/components/merchant/product-form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default async function NewProductPage() {
  await requireMerchantSession();

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>New product</CardTitle>
        <CardDescription>
          Every term here becomes part of the mandate a payer authorizes at checkout — nothing is
          hidden or adjustable later.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ProductForm />
      </CardContent>
    </Card>
  );
}
