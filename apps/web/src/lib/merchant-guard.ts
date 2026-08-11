/**
 * Every `app/merchant/**\/page.tsx` (except `connect/page.tsx` itself) calls
 * this first. Server-only (re-exports the cookie read), so the guard itself
 * can never be reached from a Client Component either.
 */
import "server-only";
import { redirect } from "next/navigation";
import { getMerchantSessionToken } from "./merchant-session";

/** Returns the opaque dashboard session token, or redirects to wallet sign-in. */
export async function requireMerchantSession(): Promise<string> {
  const sessionToken = await getMerchantSessionToken();
  if (sessionToken === undefined) {
    redirect("/merchant/connect");
  }
  return sessionToken;
}
