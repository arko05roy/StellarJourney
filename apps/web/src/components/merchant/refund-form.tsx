"use client";

import { useActionState, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { createRefundAction, type RefundActionState } from "@/lib/merchant-actions";
import { validateRefundAmount } from "@/lib/merchant-refund-form";
import { baseUnitsToDecimalString } from "@paymap/shared/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";

export interface RefundFormProps {
  paymentId: string;
  decimals: number;
  remainingBaseUnits: string;
  assetSymbol: string;
}

/** Enforces `amount <= remaining refundable` client-side (`validateRefundAmount`, unit tested) before the round-trip to `createRefundAction`, which re-validates identically server-side against the same bigint math (CLAUDE.md §20). */
export function RefundForm({ paymentId, decimals, remainingBaseUnits, assetSymbol }: RefundFormProps) {
  const [state, formAction, pending] = useActionState<RefundActionState, FormData>(createRefundAction, undefined);
  const [clientError, setClientError] = useState<string | undefined>(undefined);
  const remaining = BigInt(remainingBaseUnits);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const amount = String(formData.get("amount") ?? "");
    const result = validateRefundAmount(amount, decimals, remaining);
    if (!result.valid) {
      event.preventDefault();
      setClientError(result.error);
    } else {
      setClientError(undefined);
    }
  }

  const error = clientError ?? (state && !state.ok ? state.error : undefined);

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="flex flex-col gap-4" data-testid="refund-form">
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="decimals" value={decimals} />
      <input type="hidden" name="remainingBaseUnits" value={remainingBaseUnits} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="amount">Refund amount</Label>
        <Input id="amount" name="amount" placeholder="0.00" required data-testid="refund-amount-input" aria-invalid={Boolean(error)} />
        <p className="text-xs text-muted-foreground">
          Up to {baseUnitsToDecimalString(remaining, decimals)} {assetSymbol} remaining refundable.
        </p>
      </div>
      {error ? (
        <Alert variant="destructive" data-testid="refund-form-error">
          <AlertTriangle />
          <AlertTitle>{error}</AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending || remaining <= 0n} className="self-start" data-testid="refund-submit-button">
        {pending ? "Refunding…" : "Issue refund"}
      </Button>
    </form>
  );
}
