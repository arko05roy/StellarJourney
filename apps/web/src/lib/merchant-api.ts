/**
 * Server-only typed client for the merchant-authenticated `/v1/*` API
 * (`apps/api/src/routes/*`). `import "server-only"` (see
 * `merchant-session.ts`'s identical comment) makes it a build error for any
 * Client Component to import this module. Human dashboard calls use the
 * opaque merchant session from an httpOnly cookie; scoped API keys are only
 * shown once when explicitly created for an integration.
 *
 * Every response is parsed with Zod (CLAUDE.md §5/§10) — nothing downstream
 * trusts an unvalidated network response, mirroring `lib/api.ts`'s
 * consumer-facing convention.
 */
import "server-only";
import { z } from "zod";
import { env } from "./env";

export class MerchantApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MerchantApiError";
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  apiKey?: string;
  body?: unknown;
  idempotencyKey?: string;
  query?: Record<string, string | undefined>;
}

async function merchantFetch<T>(
  path: string,
  options: RequestOptions,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(`${env.NEXT_PUBLIC_API_URL}/v1${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
  if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: "no-store",
  });

  const json: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const code =
      typeof json === "object" && json !== null && "code" in json && typeof json.code === "string"
        ? json.code
        : "UNKNOWN_ERROR";
    const message =
      typeof json === "object" &&
      json !== null &&
      "message" in json &&
      typeof json.message === "string"
        ? json.message
        : `Request failed with status ${String(response.status)}`;
    throw new MerchantApiError(response.status, code, message);
  }

  return schema.parse(json);
}

/** A fresh idempotency key for every mutating call this module makes on the merchant's behalf — the dashboard never reuses one across distinct user actions. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Wallet authentication + merchant profile
// ---------------------------------------------------------------------------

const MerchantAuthChallengeSchema = z.object({
  challengeId: z.string(),
  message: z.string(),
  networkPassphrase: z.string(),
  expiresAt: z.string(),
});
export type MerchantAuthChallenge = z.infer<typeof MerchantAuthChallengeSchema>;

export async function createMerchantAuthChallenge(
  walletAddress: string,
): Promise<MerchantAuthChallenge> {
  return merchantFetch(
    "/merchant-auth/challenges",
    { method: "POST", body: { walletAddress } },
    MerchantAuthChallengeSchema,
  );
}

const MerchantAuthResultSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.string(),
  profileRequired: z.boolean(),
  merchant: z.object({ id: z.string(), name: z.string(), walletAddress: z.string() }).optional(),
});
export type MerchantAuthResult = z.infer<typeof MerchantAuthResultSchema>;

export async function completeMerchantAuth(input: {
  challengeId: string;
  message: string;
  signature: string;
  signerAddress: string;
}): Promise<MerchantAuthResult> {
  return merchantFetch(
    "/merchant-auth/complete",
    { method: "POST", body: input },
    MerchantAuthResultSchema,
  );
}

const MerchantProfileSchema = z.object({
  merchantId: z.string(),
  name: z.string(),
  walletAddress: z.string(),
});
export type MerchantProfile = z.infer<typeof MerchantProfileSchema>;

export async function registerMerchantProfile(
  sessionToken: string,
  name: string,
): Promise<MerchantProfile> {
  return merchantFetch(
    "/merchant-auth/register",
    { method: "POST", apiKey: sessionToken, body: { name } },
    MerchantProfileSchema,
  );
}

export async function logoutMerchantSession(sessionToken: string): Promise<void> {
  return merchantFetch(
    "/merchant-auth/logout",
    { method: "POST", apiKey: sessionToken },
    z.undefined(),
  );
}

// ---------------------------------------------------------------------------
// Scoped integration API keys
// ---------------------------------------------------------------------------

export const MerchantApiKeyScopeSchema = z.enum([
  "products:read",
  "products:write",
  "checkout_sessions:read",
  "checkout_sessions:write",
  "mandates:read",
  "charges:read",
  "charges:write",
  "payments:read",
  "refunds:read",
  "refunds:write",
  "webhooks:read",
  "webhooks:write",
  "api_keys:manage",
]);
export type MerchantApiKeyScope = z.infer<typeof MerchantApiKeyScopeSchema>;

const MerchantApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: z.array(MerchantApiKeyScopeSchema),
  status: z.enum(["active", "revoked"]),
  lastUsedAt: z.string().optional(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
});
export type MerchantApiKey = z.infer<typeof MerchantApiKeySchema>;

export async function listMerchantApiKeys(sessionToken: string): Promise<MerchantApiKey[]> {
  const { data } = await merchantFetch(
    "/merchants/me/api-keys",
    { apiKey: sessionToken },
    z.object({ data: z.array(MerchantApiKeySchema) }),
  );
  return data;
}

const CreateMerchantApiKeyResponseSchema = z.object({
  apiKeyId: z.string(),
  name: z.string(),
  scopes: z.array(MerchantApiKeyScopeSchema),
  apiKey: z.string(),
});
export type CreateMerchantApiKeyResponse = z.infer<typeof CreateMerchantApiKeyResponseSchema>;

export async function createMerchantApiKey(
  sessionToken: string,
  input: { name: string; scopes: MerchantApiKeyScope[] },
): Promise<CreateMerchantApiKeyResponse> {
  return merchantFetch(
    "/merchants/me/api-keys",
    { method: "POST", apiKey: sessionToken, body: input },
    CreateMerchantApiKeyResponseSchema,
  );
}

export async function revokeMerchantApiKey(sessionToken: string, apiKeyId: string): Promise<void> {
  return merchantFetch(
    `/merchants/me/api-keys/${encodeURIComponent(apiKeyId)}`,
    { method: "DELETE", apiKey: sessionToken },
    z.undefined(),
  );
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  assetAddress: z.string(),
  assetDecimals: z.number().int(),
  amountType: z.enum(["fixed", "variable"]),
  fixedAmount: z.string().optional(),
  maxPerCharge: z.string().optional(),
  maxPerPeriod: z.string(),
  periodSeconds: z.number().int(),
  minIntervalSeconds: z.number().int(),
  maxSuccessfulCharges: z.number().int(),
  defaultDurationSeconds: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type MerchantProduct = z.infer<typeof ProductSchema>;

export async function listProducts(apiKey: string): Promise<MerchantProduct[]> {
  const { data } = await merchantFetch(
    "/products",
    { apiKey },
    z.object({ data: z.array(ProductSchema) }),
  );
  return data;
}

export interface CreateProductInput {
  name: string;
  description?: string;
  assetAddress: string;
  assetDecimals: number;
  amountType: "fixed" | "variable";
  fixedAmount?: string;
  maxPerCharge?: string;
  maxPerPeriod: string;
  periodSeconds: number;
  minIntervalSeconds: number;
  maxSuccessfulCharges: number;
  defaultDurationSeconds: number;
}

export async function createProduct(
  apiKey: string,
  input: CreateProductInput,
): Promise<MerchantProduct> {
  return merchantFetch("/products", { method: "POST", apiKey, body: input }, ProductSchema);
}

// ---------------------------------------------------------------------------
// Checkout sessions ("Checkout links")
// ---------------------------------------------------------------------------

const CheckoutSessionSchema = z.object({
  id: z.string(),
  merchantId: z.string(),
  productId: z.string(),
  clientReference: z.string().optional(),
  payerAddress: z.string().optional(),
  expiresAt: z.string(),
  status: z.enum(["pending", "completed", "expired", "canceled"]),
  mandateId: z.string().optional(),
  createdAt: z.string(),
});
export type MerchantCheckoutSession = z.infer<typeof CheckoutSessionSchema>;

export async function listCheckoutSessions(
  apiKey: string,
  options: { productId?: string } = {},
): Promise<MerchantCheckoutSession[]> {
  const { data } = await merchantFetch(
    "/checkout-sessions",
    { apiKey, query: { productId: options.productId } },
    z.object({ data: z.array(CheckoutSessionSchema) }),
  );
  return data;
}

export async function createCheckoutSession(
  apiKey: string,
  input: { productId: string; clientReference?: string },
): Promise<MerchantCheckoutSession> {
  return merchantFetch(
    "/checkout-sessions",
    { method: "POST", apiKey, body: input, idempotencyKey: newIdempotencyKey() },
    CheckoutSessionSchema,
  );
}

// ---------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------

const MandateAmountRuleSchema = z.union([
  z.object({ kind: z.literal("fixed"), amountBaseUnits: z.string() }),
  z.object({ kind: z.literal("variable"), maxPerChargeBaseUnits: z.string() }),
]);

const MandateSchema = z.object({
  id: z.string(),
  payer: z.string(),
  merchant: z.string(),
  asset: z.string(),
  status: z.enum(["Active", "Paused", "Revoked", "Completed", "Expired"]),
  amountRule: MandateAmountRuleSchema,
  maxPerPeriodBaseUnits: z.string(),
  periodSeconds: z.string(),
  minIntervalSeconds: z.string(),
  startAt: z.string(),
  expiresAt: z.string(),
  maxSuccessfulCharges: z.number().int(),
  successfulCharges: z.number().int(),
  totalCollectedBaseUnits: z.string(),
  currentPeriodStart: z.string(),
  currentPeriodCollectedBaseUnits: z.string(),
  lastChargedAt: z.string().optional(),
  createdAt: z.string(),
});
export type MerchantMandate = z.infer<typeof MandateSchema>;

const MandateListRowSchema = z.union([
  z.object({ live: z.literal(true), mandateId: z.string(), mandate: MandateSchema }),
  z.object({
    live: z.literal(false),
    mandateId: z.string(),
    cachedStatus: z.string(),
    lastIndexedAt: z.string().optional(),
  }),
]);
export type MerchantMandateListRow = z.infer<typeof MandateListRowSchema>;

export async function listMandates(apiKey: string): Promise<MerchantMandateListRow[]> {
  const { data } = await merchantFetch(
    "/mandates",
    { apiKey },
    z.object({ data: z.array(MandateListRowSchema) }),
  );
  return data;
}

export async function getMandate(apiKey: string, mandateId: string): Promise<MerchantMandate> {
  return merchantFetch(`/mandates/${encodeURIComponent(mandateId)}`, { apiKey }, MandateSchema);
}

// ---------------------------------------------------------------------------
// Charge requests ("Upcoming collections" / "Failed collections")
// ---------------------------------------------------------------------------

const ChargeRequestSchema = z.object({
  id: z.string(),
  mandateId: z.string(),
  chargeId: z.string(),
  amount: z.string(),
  invoiceHash: z.string(),
  scheduledFor: z.string(),
  status: z.enum([
    "scheduled",
    "processing",
    "simulated",
    "submitted",
    "succeeded",
    "retryable_failed",
    "permanently_failed",
  ]),
  attemptCount: z.number().int(),
  failureCode: z.string().optional(),
  transactionHash: z.string().optional(),
  createdAt: z.string(),
});
export type MerchantChargeRequest = z.infer<typeof ChargeRequestSchema>;

export async function listCharges(
  apiKey: string,
  options: { status?: string[]; mandateId?: string } = {},
): Promise<MerchantChargeRequest[]> {
  const { data } = await merchantFetch(
    "/charges",
    { apiKey, query: { status: options.status?.join(","), mandateId: options.mandateId } },
    z.object({ data: z.array(ChargeRequestSchema) }),
  );
  return data;
}

// ---------------------------------------------------------------------------
// Payments + refunds
// ---------------------------------------------------------------------------

const PaymentSchema = z.object({
  paymentId: z.string(),
  mandateId: z.string(),
  chargeId: z.string(),
  amount: z.string(),
  assetAddress: z.string(),
  transactionHash: z.string(),
  ledger: z.string(),
  refundedTotal: z.string(),
  createdAt: z.string(),
});
export type MerchantPayment = z.infer<typeof PaymentSchema>;

export async function listPayments(
  apiKey: string,
  options: { mandateId?: string } = {},
): Promise<MerchantPayment[]> {
  const { data } = await merchantFetch(
    "/payments",
    { apiKey, query: { mandateId: options.mandateId } },
    z.object({ data: z.array(PaymentSchema) }),
  );
  return data;
}

const RefundRequestSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  refundId: z.string(),
  amount: z.string(),
  status: z.enum([
    "scheduled",
    "processing",
    "simulated",
    "submitted",
    "succeeded",
    "retryable_failed",
    "permanently_failed",
  ]),
  transactionHash: z.string().optional(),
  createdAt: z.string(),
});
export type MerchantRefundRequest = z.infer<typeof RefundRequestSchema>;

export async function listRefunds(
  apiKey: string,
  options: { paymentId?: string } = {},
): Promise<MerchantRefundRequest[]> {
  const { data } = await merchantFetch(
    "/refunds",
    { apiKey, query: { paymentId: options.paymentId } },
    z.object({ data: z.array(RefundRequestSchema) }),
  );
  return data;
}

export async function createRefund(
  apiKey: string,
  paymentId: string,
  amount: string,
): Promise<MerchantRefundRequest> {
  return merchantFetch(
    `/payments/${encodeURIComponent(paymentId)}/refunds`,
    { method: "POST", apiKey, body: { amount }, idempotencyKey: newIdempotencyKey() },
    RefundRequestSchema,
  );
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const WebhookEndpointStatusSchema = z.object({
  configured: z.boolean(),
  webhookUrl: z.string().optional(),
});
export type WebhookEndpointStatus = z.infer<typeof WebhookEndpointStatusSchema>;

export async function getWebhookEndpointStatus(apiKey: string): Promise<WebhookEndpointStatus> {
  return merchantFetch("/webhook-endpoints", { apiKey }, WebhookEndpointStatusSchema);
}

const RegisterWebhookEndpointResponseSchema = z.object({
  webhookUrl: z.string(),
  webhookSecret: z.string(),
});
export type RegisterWebhookEndpointResponse = z.infer<typeof RegisterWebhookEndpointResponseSchema>;

/** Register or rotate (same call — CLAUDE.md §12, Phase 12a's documented deviation: register == rotate, one endpoint). */
export async function registerWebhookEndpoint(
  apiKey: string,
  url: string,
): Promise<RegisterWebhookEndpointResponse> {
  return merchantFetch(
    "/webhook-endpoints",
    { method: "POST", apiKey, body: { url } },
    RegisterWebhookEndpointResponseSchema,
  );
}

const WebhookDeliverySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  status: z.enum(["pending", "delivering", "delivered", "retry_scheduled", "dead_letter"]),
  attemptCount: z.number().int(),
  nextAttemptAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MerchantWebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export async function listWebhookDeliveries(
  apiKey: string,
  options: { status?: string[] } = {},
): Promise<MerchantWebhookDelivery[]> {
  const { data } = await merchantFetch(
    "/webhook-deliveries",
    { apiKey, query: { status: options.status?.join(",") } },
    z.object({ data: z.array(WebhookDeliverySchema) }),
  );
  return data;
}
