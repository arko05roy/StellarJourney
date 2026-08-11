import type { ReactNode } from "react";
import { getMerchantApiKey } from "@/lib/merchant-session";
import { disconnectAction } from "@/lib/merchant-actions";
import { MerchantNav } from "@/components/merchant/merchant-nav";
import { Button } from "@/components/ui/button";

// Every view under /merchant either reads live on-chain state or fresh
// merchant-API data server-side (CLAUDE.md §2) — never statically cached.
export const dynamic = "force-dynamic";

/**
 * Shell for the whole merchant dashboard (PLAN.md §16.3). A Server
 * Component: it reads only whether a session cookie is *present* (never the
 * key value itself is passed to anything client-side — `apiKey` is read,
 * used to compute one boolean, and discarded before this function returns).
 * When not connected, the nav and "Disconnect" control are hidden and only
 * `/merchant/connect` is reachable in practice (every other page redirects
 * there itself via `requireMerchantApiKey`, see `lib/merchant-guard.ts`).
 */
export default async function MerchantLayout({ children }: { children: ReactNode }) {
  const apiKey = await getMerchantApiKey();
  const connected = apiKey !== undefined;

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-6 px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Merchant dashboard</h1>
          <p className="text-sm text-muted-foreground">Products, checkout links, mandates, collections, payments, and webhooks.</p>
        </div>
        {connected ? (
          <form action={disconnectAction}>
            <Button type="submit" variant="outline" size="sm" data-testid="merchant-disconnect-button">
              Disconnect
            </Button>
          </form>
        ) : null}
      </div>
      {connected ? <MerchantNav /> : null}
      {children}
    </div>
  );
}
