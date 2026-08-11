/**
 * Typed client for the merchant API's *unauthenticated* checkout endpoints
 * (`apps/api/src/routes/checkout-sessions.ts`'s `/public` and `/mandate`
 * routes, added alongside this checkout page — the consumer's browser never
 * holds a merchant API key, so it can only ever call the public surface).
 * Every response is parsed with Zod at this boundary (CLAUDE.md §5/§10) —
 * nothing downstream trusts an unvalidated network response.
 */
import { z } from "zod";
import { env } from "./env";

const PublicProductSchema = z.object({
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
export type PublicProduct = z.infer<typeof PublicProductSchema>;

const PublicCheckoutSessionSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "completed", "expired", "canceled"]),
  expiresAt: z.string(),
  clientReference: z.string().optional(),
  mandateId: z.string().optional(),
  payerAddress: z.string().optional(),
  merchant: z.object({ name: z.string(), walletAddress: z.string() }),
  product: PublicProductSchema,
});
export type PublicCheckoutSession = z.infer<typeof PublicCheckoutSessionSchema>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseErrorBody(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "code" in body && "message" in body) {
      const { code, message } = body as { code: unknown; message: unknown };
      if (typeof code === "string" && typeof message === "string") {
        return { code, message };
      }
    }
  } catch {
    // fall through to the generic fallback below
  }
  return { code: "UNKNOWN_ERROR", message: `Request failed with status ${String(response.status)}` };
}

/** Loads the display-safe checkout session (merchant, product/mandate terms, session status) — no authentication, mirrors the checkout link the merchant handed the payer. */
export async function fetchPublicCheckoutSession(sessionId: string): Promise<PublicCheckoutSession> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_URL}/v1/checkout-sessions/${encodeURIComponent(sessionId)}/public`, {
    cache: "no-store",
  });
  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    throw new ApiError(response.status, code, message);
  }
  return PublicCheckoutSessionSchema.parse(await response.json());
}

/** Reports the `mandate_id` the payer just created on-chain back to the checkout session, so the merchant dashboard can find it. The API independently re-verifies the mandate on-chain before trusting this (CLAUDE.md §2) — this call grants no authority on its own. */
export async function linkMandateToCheckoutSession(
  sessionId: string,
  input: { mandateId: string; payerAddress: string },
): Promise<PublicCheckoutSession> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_URL}/v1/checkout-sessions/${encodeURIComponent(sessionId)}/mandate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    throw new ApiError(response.status, code, message);
  }
  return PublicCheckoutSessionSchema.parse(await response.json());
}
