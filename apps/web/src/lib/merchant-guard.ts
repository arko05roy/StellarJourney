/**
 * Every `app/merchant/**\/page.tsx` (except `connect/page.tsx` itself) calls
 * this first. Server-only (re-exports the cookie read), so the guard itself
 * can never be reached from a Client Component either.
 */
import "server-only";
import { redirect } from "next/navigation";
import { getMerchantApiKey } from "./merchant-session";

/** Returns the raw API key, or redirects to `/merchant/connect` if none is stored. Never returns `undefined` — callers can treat the result as a real key. */
export async function requireMerchantApiKey(): Promise<string> {
  const apiKey = await getMerchantApiKey();
  if (apiKey === undefined) {
    redirect("/merchant/connect");
  }
  return apiKey;
}
