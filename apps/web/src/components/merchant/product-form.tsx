"use client";

import { useActionState, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { createProductAction, type ProductActionState } from "@/lib/merchant-actions";
import { EMPTY_PRODUCT_FORM_VALUES, validateProductForm, type ProductFormErrors, type ProductFormValues } from "@/lib/merchant-product-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle } from "@/components/ui/alert";

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="text-xs text-destructive" role="alert">
      {message}
    </p>
  );
}

/**
 * The plan/mandate-terms form (PLAN.md §16.3, this phase's scope): fixed vs
 * variable amount branching, caps, billing period, minimum interval,
 * mandate lifetime, and max charge count. Validated client-side first
 * (`validateProductForm`, unit tested in `lib/merchant-product-form.test.ts`
 * — instant feedback, including the over-precision rejection) and again
 * server-side inside `createProductAction` (the authoritative check, since
 * this component's own validation can never be trusted as the boundary —
 * CLAUDE.md §10).
 */
export function ProductForm() {
  const [state, formAction, pending] = useActionState<ProductActionState, FormData>(createProductAction, undefined);
  const [amountType, setAmountType] = useState<"fixed" | "variable">("fixed");
  const [clientErrors, setClientErrors] = useState<ProductFormErrors>({});

  const serverErrors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const errors: ProductFormErrors = { ...clientErrors, ...serverErrors };

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const values: ProductFormValues = {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      assetAddress: String(formData.get("assetAddress") ?? ""),
      assetDecimals: String(formData.get("assetDecimals") ?? ""),
      amountType,
      fixedAmount: String(formData.get("fixedAmount") ?? ""),
      maxPerCharge: String(formData.get("maxPerCharge") ?? ""),
      maxPerPeriod: String(formData.get("maxPerPeriod") ?? ""),
      periodSeconds: String(formData.get("periodSeconds") ?? ""),
      minIntervalSeconds: String(formData.get("minIntervalSeconds") ?? ""),
      maxSuccessfulCharges: String(formData.get("maxSuccessfulCharges") ?? ""),
      defaultDurationSeconds: String(formData.get("defaultDurationSeconds") ?? ""),
    };
    const result = validateProductForm(values);
    if (!result.valid) {
      event.preventDefault();
      setClientErrors(result.errors);
    } else {
      setClientErrors({});
    }
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-5" data-testid="product-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Product name</Label>
        <Input id="name" name="name" required data-testid="product-name-input" aria-invalid={Boolean(errors.name)} />
        <FieldError message={errors.name} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="description">Description (optional)</Label>
        <Textarea id="description" name="description" rows={2} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assetAddress">Asset contract address</Label>
          <Input id="assetAddress" name="assetAddress" placeholder="C..." required data-testid="product-asset-address-input" aria-invalid={Boolean(errors.assetAddress)} />
          <FieldError message={errors.assetAddress} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assetDecimals">Asset decimals</Label>
          <Input
            id="assetDecimals"
            name="assetDecimals"
            type="number"
            min={0}
            max={24}
            defaultValue={EMPTY_PRODUCT_FORM_VALUES.assetDecimals}
            required
            data-testid="product-asset-decimals-input"
            aria-invalid={Boolean(errors.assetDecimals)}
          />
          <FieldError message={errors.assetDecimals} />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-foreground">Amount</legend>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="amountType"
              value="fixed"
              checked={amountType === "fixed"}
              onChange={() => setAmountType("fixed")}
              data-testid="product-amount-type-fixed"
            />
            Fixed amount
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="amountType"
              value="variable"
              checked={amountType === "variable"}
              onChange={() => setAmountType("variable")}
              data-testid="product-amount-type-variable"
            />
            Variable, up to a maximum
          </label>
        </div>
        {amountType === "fixed" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="fixedAmount">Fixed amount charged every time</Label>
            <Input id="fixedAmount" name="fixedAmount" placeholder="15.00" required data-testid="product-fixed-amount-input" aria-invalid={Boolean(errors.fixedAmount)} />
            <FieldError message={errors.fixedAmount} />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="maxPerCharge">Maximum charge</Label>
            <Input id="maxPerCharge" name="maxPerCharge" placeholder="50.00" required data-testid="product-max-per-charge-input" aria-invalid={Boolean(errors.maxPerCharge)} />
            <FieldError message={errors.maxPerCharge} />
          </div>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="maxPerPeriod">Maximum per billing period</Label>
          <Input id="maxPerPeriod" name="maxPerPeriod" placeholder="50.00" required data-testid="product-max-per-period-input" aria-invalid={Boolean(errors.maxPerPeriod)} />
          <FieldError message={errors.maxPerPeriod} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="periodSeconds">Billing period (seconds)</Label>
          <Input
            id="periodSeconds"
            name="periodSeconds"
            type="number"
            min={1}
            defaultValue={EMPTY_PRODUCT_FORM_VALUES.periodSeconds}
            required
            data-testid="product-period-seconds-input"
            aria-invalid={Boolean(errors.periodSeconds)}
          />
          <FieldError message={errors.periodSeconds} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="minIntervalSeconds">Minimum interval between charges (seconds)</Label>
          <Input id="minIntervalSeconds" name="minIntervalSeconds" type="number" min={0} defaultValue={EMPTY_PRODUCT_FORM_VALUES.minIntervalSeconds} required />
          <FieldError message={errors.minIntervalSeconds} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="maxSuccessfulCharges">Maximum number of charges (0 = unlimited)</Label>
          <Input id="maxSuccessfulCharges" name="maxSuccessfulCharges" type="number" min={0} defaultValue={EMPTY_PRODUCT_FORM_VALUES.maxSuccessfulCharges} required />
          <FieldError message={errors.maxSuccessfulCharges} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="defaultDurationSeconds">Mandate lifetime (seconds)</Label>
          <Input
            id="defaultDurationSeconds"
            name="defaultDurationSeconds"
            type="number"
            min={1}
            defaultValue={EMPTY_PRODUCT_FORM_VALUES.defaultDurationSeconds}
            required
          />
          <FieldError message={errors.defaultDurationSeconds} />
        </div>
      </div>

      {state && !state.ok ? (
        <Alert variant="destructive" data-testid="product-form-error">
          <AlertTriangle />
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start" data-testid="product-form-submit-button">
        {pending ? "Creating…" : "Create product"}
      </Button>
    </form>
  );
}
