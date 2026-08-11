"use client";

import { useActionState } from "react";
import { AlertTriangle } from "lucide-react";
import { generateCheckoutLinkAction, type CheckoutLinkActionState } from "@/lib/merchant-actions";
import type { MerchantProduct } from "@/lib/merchant-api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";

export interface CheckoutLinkFormProps {
  products: readonly MerchantProduct[];
  defaultProductId: string | undefined;
}

export function CheckoutLinkForm({ products, defaultProductId }: CheckoutLinkFormProps) {
  const [state, formAction, pending] = useActionState<CheckoutLinkActionState, FormData>(generateCheckoutLinkAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="checkout-link-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="productId">Product</Label>
        <select
          id="productId"
          name="productId"
          required
          defaultValue={defaultProductId ?? ""}
          data-testid="checkout-link-product-select"
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <option value="" disabled>
            Select a product
          </option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
      </div>
      {state && !state.ok ? (
        <Alert variant="destructive" data-testid="checkout-link-form-error">
          <AlertTriangle />
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending || products.length === 0} className="self-start" data-testid="generate-checkout-link-button">
        {pending ? "Generating…" : "Generate checkout link"}
      </Button>
    </form>
  );
}
