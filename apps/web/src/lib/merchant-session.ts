/**
 * Server-only merchant API-key session (CLAUDE.md §10, this phase's lead
 * decision #1: "merchant-authenticated views use the API key path, never
 * leaked client-side, proxy through Next server components / route
 * handlers").
 *
 * There is no merchant login system in this MVP (no email/password, no
 * OAuth) — the merchant API's own identity is the API key itself
 * (`apps/api/src/auth/plugin.ts`). This module's job is to hold that raw key
 * in an httpOnly cookie so it never reaches client-side JavaScript
 * (`document.cookie` cannot read an httpOnly cookie, and it is never passed
 * as a prop to a Client Component), while every Server Component / Server
 * Action in `app/merchant/**` can read it to call the merchant API.
 *
 * `import "server-only"` is not a convention here, it's an enforced
 * constraint: this package throws a build-time error if any Client
 * Component (`"use client"`) is ever found to import this module, so the
 * "never leaked client-side" requirement is a `next build` failure, not a
 * code-review hope. See `docs/architecture.md` for the full data-flow
 * diagram and `src/lib/no-secret-leak.test.ts` for the accompanying static
 * check that no Client Component references this module or the cookie name
 * directly.
 */
import "server-only";
import { cookies } from "next/headers";

/** Not secret itself (just a cookie name), but kept here so exactly one module owns the wire format. */
export const MERCHANT_API_KEY_COOKIE = "paymap_merchant_api_key";

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days — this MVP has no refresh/re-auth flow, so the session outlives a typical demo/dev cycle.

/** Reads the merchant's raw API key from the httpOnly cookie, or `undefined` if never connected. */
export async function getMerchantApiKey(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(MERCHANT_API_KEY_COOKIE)?.value;
}

/**
 * Stores the merchant's raw API key httpOnly (JS on the page can never read
 * it, whether same-origin or via an injected script), `secure` outside
 * local development (a plain `http://localhost` dev server can't set
 * `secure` cookies), and `sameSite: "lax"` (the merchant navigates here
 * directly, no cross-site form posting needed).
 */
export async function setMerchantApiKey(apiKey: string): Promise<void> {
  const store = await cookies();
  store.set(MERCHANT_API_KEY_COOKIE, apiKey, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export async function clearMerchantApiKey(): Promise<void> {
  const store = await cookies();
  store.delete(MERCHANT_API_KEY_COOKIE);
}
