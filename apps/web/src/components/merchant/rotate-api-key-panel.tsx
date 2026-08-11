"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound } from "lucide-react";
import { rotateApiKeyAction, type RotateApiKeyActionState } from "@/lib/merchant-actions";
import { Button } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

/**
 * CLAUDE.md §10: "never re-display an existing key — Phase 8 hashes them
 * and cannot recover them; the UI must not pretend otherwise." This panel
 * never shows the merchant's *current* key anywhere — it only ever shows a
 * *freshly rotated* one, exactly once, immediately after rotation, and
 * explicitly warns that the old key stopped working the instant this
 * happened.
 */
export function RotateApiKeyPanel() {
  const [state, formAction, pending] = useActionState<RotateApiKeyActionState, FormData>(rotateApiKeyAction, undefined);
  const [copied, setCopied] = useState(false);

  if (state?.ok) {
    const { apiKey } = state.result;
    return (
      <div className="flex flex-col gap-3" data-testid="rotate-api-key-success">
        <Alert data-testid="rotated-api-key-banner">
          <KeyRound />
          <AlertTitle>Your API key was rotated. Save it now, it will not be shown again.</AlertTitle>
          <AlertDescription>The previous key stopped working immediately.</AlertDescription>
        </Alert>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <code className="flex-1 overflow-x-auto text-sm" data-testid="rotated-api-key-value">
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
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Your current API key is never shown again after it was first issued — this only issues a brand-new one and revokes the old one immediately.</p>
      {state && !state.ok ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" variant="outline" disabled={pending} className="self-start" data-testid="rotate-api-key-button">
        {pending ? "Rotating…" : "Rotate API key"}
      </Button>
    </form>
  );
}
