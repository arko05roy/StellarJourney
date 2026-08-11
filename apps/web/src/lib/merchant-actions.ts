/**
 * Server Actions for the merchant dashboard (`app/merchant/**`). Every
 * mutation here reads the wallet-authenticated merchant session from an
 * httpOnly cookie and calls the merchant API server-side. Scoped integration
 * keys only cross the browser boundary in the explicit one-time create-key
 * response.
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
import {
  clearMerchantSessionToken,
  getMerchantSessionToken,
  setMerchantSessionToken,
} from "./merchant-session";
import {
  MerchantApiError,
  MerchantApiKeyScopeSchema,
  completeMerchantAuth,
  createCheckoutSession,
  createMerchantApiKey,
  createMerchantAuthChallenge,
  createProduct,
  createRefund,
  logoutMerchantSession,
  registerWebhookEndpoint,
  registerMerchantProfile,
  revokeMerchantApiKey,
  type CreateMerchantApiKeyResponse,
  type MerchantAuthChallenge,
  type MerchantApiKeyScope,
  type RegisterWebhookEndpointResponse,
} from "./merchant-api";
import {
  validateProductForm,
  type ProductFormErrors,
  type ProductFormValues,
} from "./merchant-product-form";
import { validateRefundAmount } from "./merchant-refund-form";

export interface ActionError {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------------------
// Wallet authentication / profile / disconnect
// ---------------------------------------------------------------------------

export type MerchantChallengeActionResult =
  { ok: true; challenge: MerchantAuthChallenge } | { ok: false; error: string };

export async function createMerchantChallengeAction(
  walletAddress: string,
): Promise<MerchantChallengeActionResult> {
  try {
    return {
      ok: true,
      challenge: await createMerchantAuthChallenge(walletAddress),
    };
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
}

export type CompleteMerchantAuthActionResult =
  { ok: true; profileRequired: true; walletAddress: string } | { ok: false; error: string };

export async function completeMerchantAuthAction(input: {
  challengeId: string;
  message: string;
  signature: string;
  signerAddress: string;
}): Promise<CompleteMerchantAuthActionResult> {
  let profileRequired = false;
  try {
    const result = await completeMerchantAuth(input);
    await setMerchantSessionToken(result.sessionToken);
    profileRequired = result.profileRequired;
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
  if (!profileRequired) redirect("/merchant/products");
  return {
    ok: true,
    profileRequired: true,
    walletAddress: input.signerAddress,
  };
}

export type RegisterMerchantActionState = { ok: false; error: string } | undefined;

export async function registerMerchantProfileAction(
  _prevState: RegisterMerchantActionState,
  formData: FormData,
): Promise<RegisterMerchantActionState> {
  const sessionToken = await getMerchantSessionToken();
  if (!sessionToken) return { ok: false, error: "Connect and sign with your wallet first." };
  const name = String(formData.get("name") ?? "").trim();
  if (name.length === 0) return { ok: false, error: "Business name is required." };
  try {
    await registerMerchantProfile(sessionToken, name);
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
  redirect("/merchant/products");
}

export async function disconnectAction(): Promise<void> {
  const sessionToken = await getMerchantSessionToken();
  if (sessionToken) {
    await logoutMerchantSession(sessionToken).catch(() => undefined);
  }
  await clearMerchantSessionToken();
  redirect("/merchant/connect");
}

// ---------------------------------------------------------------------------
// Developers — scoped integration API keys
// ---------------------------------------------------------------------------

export type CreateApiKeyActionState =
  { ok: false; error: string } | { ok: true; result: CreateMerchantApiKeyResponse } | undefined;

export async function createApiKeyAction(
  _prevState: CreateApiKeyActionState,
  formData: FormData,
): Promise<CreateApiKeyActionState> {
  const sessionToken = await getMerchantSessionToken();
  if (!sessionToken) return { ok: false, error: "Not connected." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Key name is required." };
  const parsedScopes = formData.getAll("scopes").map(String);
  const scopesResult = MerchantApiKeyScopeSchema.array().min(1).safeParse(parsedScopes);
  if (!scopesResult.success) return { ok: false, error: "Choose at least one permission." };
  try {
    const result = await createMerchantApiKey(sessionToken, {
      name,
      scopes: scopesResult.data as MerchantApiKeyScope[],
    });
    revalidatePath("/merchant/developers");
    return { ok: true, result };
  } catch (error) {
    if (error instanceof MerchantApiError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function revokeApiKeyAction(formData: FormData): Promise<void> {
  const sessionToken = await getMerchantSessionToken();
  if (!sessionToken) redirect("/merchant/connect");
  const apiKeyId = String(formData.get("apiKeyId") ?? "").trim();
  if (!apiKeyId) return;
  await revokeMerchantApiKey(sessionToken, apiKeyId);
  revalidatePath("/merchant/developers");
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type ProductActionState =
  { ok: false; error: string; fieldErrors?: ProductFormErrors } | { ok: true } | undefined;

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

export async function createProductAction(
  _prevState: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const apiKey = await getMerchantSessionToken();
  if (!apiKey) return { ok: false, error: "Not connected." };

  const validation = validateProductForm(extractProductFormValues(formData));
  if (!validation.valid) {
    return {
      ok: false,
      error: "Fix the highlighted fields before continuing.",
      fieldErrors: validation.errors,
    };
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

export async function generateCheckoutLinkAction(
  _prevState: CheckoutLinkActionState,
  formData: FormData,
): Promise<CheckoutLinkActionState> {
  const apiKey = await getMerchantSessionToken();
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

export async function createRefundAction(
  _prevState: RefundActionState,
  formData: FormData,
): Promise<RefundActionState> {
  const apiKey = await getMerchantSessionToken();
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

export type RegisterWebhookActionState =
  { ok: false; error: string } | { ok: true; result: RegisterWebhookEndpointResponse } | undefined;

export async function registerWebhookEndpointAction(
  _prevState: RegisterWebhookActionState,
  formData: FormData,
): Promise<RegisterWebhookActionState> {
  const apiKey = await getMerchantSessionToken();
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
