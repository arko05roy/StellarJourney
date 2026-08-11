/**
 * Server Actions for the merchant dashboard (`app/merchant/**`). Every
 * mutation here reads the merchant's API key from the httpOnly cookie
 * (`merchant-session.ts`) server-side and calls the merchant API
 * (`merchant-api.ts`) server-side — the browser never sees the key, whether
 * on success or failure (this file is itself `"use server"`-only code,
 * never bundled to the client; only the plain-object *results* it returns
 * cross the wire, and none of them ever contain the API key itself except
 * the three explicit "show a new/rotated secret once" actions, which is the
 * same one-time-display contract `apps/api`'s own key-issuance endpoints
 * use).
 *
 * Pattern: every action returns a discriminated `{ ok: true, ... } | { ok:
 * false, error, fieldErrors? }` result for `useActionState` rather than
 * throwing, so the calling Client Component always has a real error state
 * to render (CLAUDE.md §13 / the design skill's "real empty/loading/error
 * states" bar) — `redirect()` is only ever called *after* a successful
 * mutation, outside any try/catch, since Next.js's redirect mechanism must
 * never be swallowed by a generic catch block.
 */
"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { clearMerchantApiKey, getMerchantApiKey, setMerchantApiKey } from "./merchant-session";
import {
  MerchantApiError,
  createCheckoutSession,
  createMerchant,
  createProduct,
  createRefund,
  getWebhookEndpointStatus,
  registerWebhookEndpoint,
  rotateApiKey,
  type CreateMerchantResponse,
  type RegisterWebhookEndpointResponse,
  type RotateApiKeyResponse,
} from "./merchant-api";
import { validateProductForm, type ProductFormErrors, type ProductFormValues } from "./merchant-product-form";
import { validateRefundAmount } from "./merchant-refund-form";

export interface ActionError {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------------------
// Connect / bootstrap / disconnect
// ---------------------------------------------------------------------------

export type ConnectActionState = { ok: false; error: string } | { ok: true } | undefined;

/** Verifies the pasted key actually authenticates (a cheap real API call, not just a format check) before storing it — a merchant pasting a stale/revoked key gets a clear error immediately, not a broken dashboard later. */
export async function connectWithApiKeyAction(_prevState: ConnectActionState, formData: FormData): Promise<ConnectActionState> {
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  if (apiKey.length === 0) {
    return { ok: false, error: "Enter your API key." };
  }
  try {
    await getWebhookEndpointStatus(apiKey);
  } catch (error) {
    if (error instanceof MerchantApiError) {
      return { ok: false, error: error.status === 401 ? "That API key was not recognized." : error.message };
    }
    throw error;
  }
  await setMerchantApiKey(apiKey);
  redirect("/merchant/products");
}

export type CreateMerchantActionState = { ok: false; error: string } | { ok: true; result: CreateMerchantResponse } | undefined;

/**
 * Bootstrap a brand-new merchant account. Unlike every other action here,
 * this one does NOT redirect on success — the newly-issued key must be
 * shown to the merchant right now (it can never be retrieved again,
 * CLAUDE.md §10), so the calling Client Component keeps it in local state
 * for exactly one render and offers a "Continue" link once the merchant has
 * copied it.
 */
export async function createMerchantAction(_prevState: CreateMerchantActionState, formData: FormData): Promise<CreateMerchantActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const walletAddress = String(formData.get("walletAddress") ?? "").trim();
  if (name.length === 0) return { ok: false, error: "Business name is required." };
  if (walletAddress.length === 0) return { ok: false, error: "Your Stellar wallet address is required." };

  try {
    const result = await createMerchant({ name, walletAddress });
    await setMerchantApiKey(result.apiKey);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function disconnectAction(): Promise<void> {
  await clearMerchantApiKey();
  redirect("/merchant/connect");
}

// ---------------------------------------------------------------------------
// Developers — API key rotation
// ---------------------------------------------------------------------------

export type RotateApiKeyActionState = { ok: false; error: string } | { ok: true; result: RotateApiKeyResponse } | undefined;

export async function rotateApiKeyAction(_prevState: RotateApiKeyActionState): Promise<RotateApiKeyActionState> {
  const apiKey = await getMerchantApiKey();
  if (!apiKey) return { ok: false, error: "Not connected." };
  try {
    const result = await rotateApiKey(apiKey);
    // The old key is revoked the instant this call returns (`apps/api`'s
    // `rotateApiKey` marks it `revoked` before responding) — the cookie
    // must be swapped immediately or every subsequent request on this
    // dashboard would start failing with 401s using the now-dead key.
    await setMerchantApiKey(result.apiKey);
    return { ok: true, result };
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type ProductActionState = { ok: false; error: string; fieldErrors?: ProductFormErrors } | { ok: true } | undefined;

function extractProductFormValues(formData: FormData): ProductFormValues {
  const get = (key: string) => String(formData.get(key) ?? "");
  return {
    name: get("name"),
    description: get("description"),
    assetAddress: get("assetAddress"),
    assetDecimals: get("assetDecimals"),
    amountType: get("amountType") === "variable" ? "variable" : "fixed",
    fixedAmount: get("fixedAmount"),
    maxPerCharge: get("maxPerCharge"),
    maxPerPeriod: get("maxPerPeriod"),
    periodSeconds: get("periodSeconds"),
    minIntervalSeconds: get("minIntervalSeconds"),
    maxSuccessfulCharges: get("maxSuccessfulCharges"),
    defaultDurationSeconds: get("defaultDurationSeconds"),
  };
}

export async function createProductAction(_prevState: ProductActionState, formData: FormData): Promise<ProductActionState> {
  const apiKey = await getMerchantApiKey();
  if (!apiKey) return { ok: false, error: "Not connected." };

  const validation = validateProductForm(extractProductFormValues(formData));
  if (!validation.valid) {
    return { ok: false, error: "Fix the highlighted fields before continuing.", fieldErrors: validation.errors };
  }

  try {
    await createProduct(apiKey, validation.input);
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/merchant/products");
  redirect("/merchant/products");
}

// ---------------------------------------------------------------------------
// Checkout links
// ---------------------------------------------------------------------------

export type CheckoutLinkActionState = ActionError | undefined;

export async function generateCheckoutLinkAction(_prevState: CheckoutLinkActionState, formData: FormData): Promise<CheckoutLinkActionState> {
  const apiKey = await getMerchantApiKey();
  if (!apiKey) return { ok: false, error: "Not connected." };
  const productId = String(formData.get("productId") ?? "").trim();
  if (productId.length === 0) return { ok: false, error: "Choose a product first." };

  try {
    await createCheckoutSession(apiKey, { productId });
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/merchant/checkout-links");
  redirect("/merchant/checkout-links");
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export type RefundActionState = ActionError | undefined;

export async function createRefundAction(_prevState: RefundActionState, formData: FormData): Promise<RefundActionState> {
  const apiKey = await getMerchantApiKey();
  if (!apiKey) return { ok: false, error: "Not connected." };
  const paymentId = String(formData.get("paymentId") ?? "").trim();
  const amount = String(formData.get("amount") ?? "").trim();
  const decimals = Number(formData.get("decimals") ?? "7");
  const remainingBaseUnits = BigInt(String(formData.get("remainingBaseUnits") ?? "0"));

  const validation = validateRefundAmount(amount, decimals, remainingBaseUnits);
  if (!validation.valid) return { ok: false, error: validation.error };

  try {
    await createRefund(apiKey, paymentId, amount);
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
  revalidatePath("/merchant/refunds");
  revalidatePath("/merchant/payments");
  redirect("/merchant/refunds");
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type RegisterWebhookActionState = { ok: false; error: string } | { ok: true; result: RegisterWebhookEndpointResponse } | undefined;

export async function registerWebhookEndpointAction(_prevState: RegisterWebhookActionState, formData: FormData): Promise<RegisterWebhookActionState> {
  const apiKey = await getMerchantApiKey();
  if (!apiKey) return { ok: false, error: "Not connected." };
  const url = String(formData.get("url") ?? "").trim();
  if (url.length === 0) return { ok: false, error: "Enter a webhook URL." };

  try {
    const result = await registerWebhookEndpoint(apiKey, url);
    revalidatePath("/merchant/webhooks");
    return { ok: true, result };
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
}
