/**
 * Typed client for the merchant API's *unauthenticated* consumer discovery
 * endpoints (`apps/api/src/routes/consumer.ts`) — the dashboard's own
 * browser never holds a merchant API key, mirroring `lib/api.ts`'s existing
 * checkout-session client exactly. Every response is Zod-parsed at this
 * boundary (CLAUDE.md §5/§10).
 *
 * These calls only ever drive *discovery* and *history enrichment*
 * (which mandate ids exist for this payer, merchant display names, past
 * payment/failure records) — never the authoritative status/limits/usage
 * shown on a mandate card, which always comes from a live `get_mandate`
 * read (`lib/mandate-gateway.ts`). See that module's doc for the full
 * "contract wins" reasoning (CLAUDE.md §2).
 */
import { z } from "zod";
import { env } from "./env";
import { ApiError } from "./api";

const ConsumerMandateSummarySchema = z.object({
  mandateId: z.string(),
  merchant: z.object({ name: z.string(), walletAddress: z.string() }),
  assetAddress: z.string(),
  assetDecimals: z.number().int(),
  cachedStatus: z.string(),
  lastIndexedAt: z.string().optional(),
});
export type ConsumerMandateSummary = z.infer<typeof ConsumerMandateSummarySchema>;

const ConsumerPaymentSchema = z.object({
  paymentId: z.string(),
  mandateId: z.string(),
  chargeId: z.string(),
  merchant: z.object({ name: z.string(), walletAddress: z.string() }),
  amount: z.string(),
  assetAddress: z.string(),
  transactionHash: z.string(),
  createdAt: z.string(),
});
export type ConsumerPayment = z.infer<typeof ConsumerPaymentSchema>;

const ConsumerFailedAttemptSchema = z.object({
  id: z.string(),
  mandateId: z.string(),
  chargeId: z.string(),
  merchant: z.object({ name: z.string(), walletAddress: z.string() }),
  amount: z.string(),
  status: z.string(),
  failureCode: z.string().optional(),
  attemptedAt: z.string(),
});
export type ConsumerFailedAttempt = z.infer<typeof ConsumerFailedAttemptSchema>;

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

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, { cache: "no-store" });
  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    throw new ApiError(response.status, code, message);
  }
  return response.json();
}

/** Discovers every mandate this payer address has ever created (`MandateIndex`, seeded when a checkout links a mandate). Enrichment only — always re-verify status/limits on-chain before displaying or acting. */
export async function fetchConsumerMandates(payerAddress: string): Promise<ConsumerMandateSummary[]> {
  const body = await getJson(`/v1/consumer/mandates?payerAddress=${encodeURIComponent(payerAddress)}`);
  return z.object({ data: z.array(ConsumerMandateSummarySchema) }).parse(body).data;
}

export interface ConsumerPaymentHistory {
  payments: ConsumerPayment[];
  failedAttempts: ConsumerFailedAttempt[];
}

/** Successful payments and failed charge attempts (with their failure code) across every mandate this payer address has. */
export async function fetchConsumerPaymentHistory(payerAddress: string): Promise<ConsumerPaymentHistory> {
  const body = await getJson(`/v1/consumer/payments?payerAddress=${encodeURIComponent(payerAddress)}`);
  return z.object({ payments: z.array(ConsumerPaymentSchema), failedAttempts: z.array(ConsumerFailedAttemptSchema) }).parse(body);
}
