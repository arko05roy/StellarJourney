"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Copy, KeyRound } from "lucide-react";
import { createMerchantAction, type CreateMerchantActionState } from "@/lib/merchant-actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";

/**
 * Bootstraps a brand-new merchant account. On success the API key exists
 * only in this component's own render — never in a URL, never re-fetchable
 * (CLAUDE.md §10 "show a new API key only once", `apps/api`'s `ApiKey`
 * table stores only a hash, this exact value cannot be recovered later by
 * this app or anyone else).
 */
export function CreateMerchantForm() {
  const [state, formAction, pending] = useActionState<CreateMerchantActionState, FormData>(createMerchantAction, undefined);
  const [copied, setCopied] = useState(false);

  if (state?.ok) {
    const { apiKey } = state.result;
    return (
      <div className="flex flex-col gap-4" data-testid="create-merchant-success">
        <Alert data-testid="new-api-key-banner">
          <KeyRound />
          <AlertTitle>Save your API key now. It will not be shown again.</AlertTitle>
        </Alert>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <code className="flex-1 overflow-x-auto text-sm" data-testid="new-api-key-value">
            {apiKey}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Copy API key"
            onClick={() => {
              void navigator.clipboard.writeText(apiKey);
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <Link href="/merchant/products" data-testid="continue-to-dashboard-link" className={buttonVariants({})}>
          Continue to dashboard
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="create-merchant-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Business name</Label>
        <Input id="name" name="name" required data-testid="create-merchant-name-input" />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="walletAddress">Your Stellar wallet address</Label>
        <Input id="walletAddress" name="walletAddress" placeholder="G..." required data-testid="create-merchant-wallet-input" />
        <p className="text-xs text-muted-foreground">Charges you request will be authorized to pay out to this address.</p>
      </div>
      {state && !state.ok ? (
        <Alert variant="destructive" data-testid="create-merchant-error">
          <AlertTriangle />
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} data-testid="create-merchant-submit-button">
        {pending ? "Creating…" : "Create merchant account"}
      </Button>
    </form>
  );
}
