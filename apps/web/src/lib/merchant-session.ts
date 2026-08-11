/**
 * Server-only merchant dashboard session. Wallet authentication returns an
 * opaque, short-lived token that is stored only in this httpOnly cookie.
 * Paymap API keys are separate server-to-server integration credentials and
 * never become browser login state.
 */
import "server-only";
import { cookies } from "next/headers";

export const MERCHANT_SESSION_COOKIE = "paymap_merchant_session";
const LEGACY_API_KEY_COOKIE = "paymap_merchant_api_key";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24;

export async function getMerchantSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(MERCHANT_SESSION_COOKIE)?.value;
}

export async function setMerchantSessionToken(sessionToken: string): Promise<void> {
  const store = await cookies();
  store.set(MERCHANT_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  store.delete(LEGACY_API_KEY_COOKIE);
}

export async function clearMerchantSessionToken(): Promise<void> {
  const store = await cookies();
  store.delete(MERCHANT_SESSION_COOKIE);
  store.delete(LEGACY_API_KEY_COOKIE);
}
