"use client";

import { useActionState } from "react";
import { connectWithApiKeyAction, type ConnectActionState } from "@/lib/merchant-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

/**
 * Pastes an already-issued API key to resume a session. The key is only
 * ever sent in this form's own POST (a Server Action request, not a
 * client-side `fetch`) — it never touches `merchant-api.ts` from the
 * browser and is never echoed back into this component's props or state
 * (`ConnectActionState`'s success case carries no key at all, see
 * `lib/merchant-actions.ts`).
 */
export function ConnectForm() {
  const [state, formAction, pending] = useActionState<ConnectActionState, FormData>(connectWithApiKeyAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="connect-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="apiKey">API key</Label>
        <Input id="apiKey" name="apiKey" type="password" autoComplete="off" placeholder="pmk_live_..." required data-testid="connect-api-key-input" />
      </div>
      {state && !state.ok ? (
        <Alert variant="destructive" data-testid="connect-form-error">
          <AlertTriangle />
          <AlertTitle>{state.error}</AlertTitle>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} data-testid="connect-submit-button">
        {pending ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}
