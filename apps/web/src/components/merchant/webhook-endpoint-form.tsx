"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound } from "lucide-react";
import { registerWebhookEndpointAction, type RegisterWebhookActionState } from "@/lib/merchant-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export interface WebhookEndpointFormProps {
  currentUrl: string | undefined;
}

/** Registering and rotating are the same call (Phase 12a's documented deviation) — the returned secret is shown exactly once, same discipline as the API-key panel. */
export function WebhookEndpointForm({ currentUrl }: WebhookEndpointFormProps) {
  const [state, formAction, pending] = useActionState<RegisterWebhookActionState, FormData>(registerWebhookEndpointAction, undefined);
  const [copied, setCopied] = useState(false);

  if (state?.ok) {
    const { webhookUrl, webhookSecret } = state.result;
    return (
      <div className="flex flex-col gap-3" data-testid="webhook-endpoint-success">
        <Alert data-testid="new-webhook-secret-banner">
          <KeyRound />
          <AlertTitle>Save your webhook signing secret now. It will not be shown again.</AlertTitle>
          <AlertDescription>Endpoint set to {webhookUrl}. Use this secret to verify the `Paymap-Signature` header on every delivery.</AlertDescription>
        </Alert>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <code className="flex-1 overflow-x-auto text-sm" data-testid="new-webhook-secret-value">
            {webhookSecret}
          </code>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Copy webhook secret"
            onClick={() => {
              void navigator.clipboard.writeText(webhookSecret);
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="url">Webhook URL</Label>
        <Input id="url" name="url" type="url" placeholder="https://merchant.example.com/webhooks/paymap" defaultValue={currentUrl} required data-testid="webhook-url-input" />
        {currentUrl ? <p className="text-xs text-muted-foreground">Submitting issues a brand-new signing secret, even for the same URL.</p> : null}
      </div>
      {state && !state.ok ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="self-start" data-testid="register-webhook-button">
        {pending ? "Saving…" : currentUrl ? "Rotate endpoint & secret" : "Register endpoint"}
      </Button>
    </form>
  );
}
