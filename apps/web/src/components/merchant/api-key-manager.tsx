"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { createApiKeyAction, revokeApiKeyAction } from "@/lib/merchant-actions";
import type { MerchantApiKey, MerchantApiKeyScope } from "@/lib/merchant-api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const SCOPE_OPTIONS: readonly {
  value: MerchantApiKeyScope;
  label: string;
}[] = [
  { value: "products:read", label: "Read products" },
  { value: "products:write", label: "Manage products" },
  { value: "checkout_sessions:read", label: "Read checkout sessions" },
  { value: "checkout_sessions:write", label: "Create checkout sessions" },
  { value: "mandates:read", label: "Read mandates" },
  { value: "charges:read", label: "Read charges" },
  { value: "charges:write", label: "Request charges" },
  { value: "payments:read", label: "Read payments" },
  { value: "refunds:read", label: "Read refunds" },
  { value: "refunds:write", label: "Create refunds" },
  { value: "webhooks:read", label: "Read webhook status" },
  { value: "webhooks:write", label: "Manage webhooks" },
  { value: "api_keys:manage", label: "Manage API keys" },
];

export function ApiKeyManager({ keys }: { keys: MerchantApiKey[] }) {
  const [state, formAction, pending] = useActionState(createApiKeyAction, undefined);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-medium text-foreground">Create integration key</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Grant only the permissions required by this server or automation.
          </p>
        </div>
        {state?.ok ? (
          <Alert data-testid="new-scoped-api-key-banner">
            <KeyRound />
            <AlertTitle>Save this API key now. It will not be shown again.</AlertTitle>
            <AlertDescription className="mt-3 flex items-center gap-2">
              <code
                className="min-w-0 flex-1 overflow-x-auto rounded bg-background px-3 py-2 text-xs"
                data-testid="new-scoped-api-key-value"
              >
                {state.result.apiKey}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Copy API key"
                onClick={() => {
                  void navigator.clipboard.writeText(state.result.apiKey);
                  setCopied(true);
                }}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-name">Key name</Label>
            <Input
              id="api-key-name"
              name="name"
              placeholder="Production checkout service"
              required
              data-testid="api-key-name-input"
            />
          </div>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium text-foreground">Permissions</legend>
            {SCOPE_OPTIONS.map((scope) => (
              <label
                key={scope.value}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground"
              >
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope.value}
                  className="size-4 accent-primary"
                />
                {scope.label}
              </label>
            ))}
          </fieldset>
          {state && !state.ok ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>{state.error}</AlertTitle>
            </Alert>
          ) : null}
          <Button
            type="submit"
            disabled={pending}
            className="self-start"
            data-testid="create-api-key-button"
          >
            {pending ? "Creating…" : "Create scoped API key"}
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-medium text-foreground">Integration keys</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Raw secrets are never stored or displayed again.
          </p>
        </div>
        {keys.length === 0 ? (
          <div
            className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground"
            data-testid="api-keys-empty"
          >
            No API keys yet. Your wallet session is enough to use this dashboard.
          </div>
        ) : (
          <Table data-testid="api-keys-table">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Permissions</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="font-mono text-xs">{key.keyPrefix}…</TableCell>
                  <TableCell>
                    <span className="block max-w-72 truncate text-xs text-muted-foreground">
                      {key.scopes.join(", ")}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={key.status === "active" ? "secondary" : "outline"}>
                      {key.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {key.status === "active" ? (
                      <form action={revokeApiKeyAction}>
                        <input type="hidden" name="apiKeyId" value={key.id} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="sm"
                          data-testid={`revoke-api-key-${key.id}`}
                        >
                          <Trash2 />
                          Revoke
                        </Button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}
