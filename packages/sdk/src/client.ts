/**
 * Merchant-facing TypeScript SDK client (PLAN.md §17, this phase's decision
 * #9 — supports the exact `mandates.checkoutSessions.create(...)` /
 * `mandates.charges.create(...)` call shapes PLAN.md §17 shows, plus
 * `payments.refunds.create` and a handful of reads).
 */
import { createHash, randomUUID } from "node:crypto";
import { HttpClient, type FetchLike } from "./http.js";
import type {
  ChargeResponse,
  CheckoutSessionResponse,
  CreateChargeInput,
  CreateCheckoutSessionInput,
  CreateRefundInput,
  ListPaymentsQuery,
  MandateResponse,
  PaymentResponse,
  RefundResponse,
} from "./types.js";

export * from "./errors.js";
export * from "./types.js";

export interface StellarMandatesOptions {
  apiKey: string;
  /** Defaults to the local dev API (`docs/merchant-api.md`) — override for any non-local deployment. */
  baseUrl?: string;
  /** Injectable — defaults to the runtime's global `fetch`. Tests supply a fake. */
  fetch?: FetchLike;
  /** Per-request timeout. Default 15s. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://localhost:3001/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

/** `sha256(invoiceId)` hex-encoded — always exactly 64 hex chars, matching the API's `invoiceHash` (`HexId32Schema`). Deterministic: the same `invoiceId` always produces the same hash, so retries stay consistent. */
function hashInvoiceId(invoiceId: string): string {
  return createHash("sha256").update(invoiceId, "utf8").digest("hex");
}

class CheckoutSessionsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * @example
   * ```ts
   * const checkout = await mandates.checkoutSessions.create({
   *   productId: "prod_monthly_ai",
   *   clientReference: "customer_123",
   *   successUrl: "https://merchant.example/success",
   *   cancelUrl: "https://merchant.example/cancel",
   * });
   * ```
   */
  async create(input: CreateCheckoutSessionInput): Promise<CheckoutSessionResponse> {
    const { idempotencyKey, ...body } = input;
    return this.http.request<CheckoutSessionResponse>("POST", "/checkout-sessions", body, idempotencyKey ?? randomUUID());
  }

  /**
   * @example
   * ```ts
   * const session = await mandates.checkoutSessions.get("cs_abc123");
   * ```
   */
  async get(checkoutSessionId: string): Promise<CheckoutSessionResponse> {
    return this.http.request<CheckoutSessionResponse>("GET", `/checkout-sessions/${encodeURIComponent(checkoutSessionId)}`);
  }
}

class ChargesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * @example
   * ```ts
   * await mandates.charges.create({
   *   mandateId: "mandate_...",
   *   amount: "15.00",
   *   asset: "USDC",
   *   invoiceId: "invoice_2026_08_001",
   *   idempotencyKey: "invoice_2026_08_001",
   * });
   * ```
   */
  async create(input: CreateChargeInput): Promise<ChargeResponse> {
    const { mandateId, asset: _asset, invoiceId, idempotencyKey, ...rest } = input;
    const body = { ...rest, invoiceHash: hashInvoiceId(invoiceId) };
    return this.http.request<ChargeResponse>("POST", `/mandates/${encodeURIComponent(mandateId)}/charges`, body, idempotencyKey ?? randomUUID());
  }

  /**
   * @example
   * ```ts
   * const charge = await mandates.charges.get("cr_abc123");
   * ```
   */
  async get(chargeRequestId: string): Promise<ChargeResponse> {
    return this.http.request<ChargeResponse>("GET", `/charges/${encodeURIComponent(chargeRequestId)}`);
  }
}

class RefundsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * @example
   * ```ts
   * await mandates.payments.refunds.create({
   *   paymentId: "pay_abc123",
   *   amount: "5.00",
   * });
   * ```
   */
  async create(input: CreateRefundInput): Promise<RefundResponse> {
    const { paymentId, idempotencyKey, ...rest } = input;
    return this.http.request<RefundResponse>("POST", `/payments/${encodeURIComponent(paymentId)}/refunds`, rest, idempotencyKey ?? randomUUID());
  }
}

class PaymentsResource {
  readonly refunds: RefundsResource;

  constructor(private readonly http: HttpClient) {
    this.refunds = new RefundsResource(http);
  }

  /**
   * @example
   * ```ts
   * const { data: payments } = await mandates.payments.list({ mandateId: "mandate_..." });
   * ```
   */
  async list(query: ListPaymentsQuery = {}): Promise<{ data: PaymentResponse[] }> {
    const params = new URLSearchParams();
    if (query.mandateId !== undefined) params.set("mandateId", query.mandateId);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const qs = params.toString();
    return this.http.request<{ data: PaymentResponse[] }>("GET", `/payments${qs ? `?${qs}` : ""}`);
  }
}

class MandatesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * @example
   * ```ts
   * const mandate = await mandates.mandates.get("mandate_...");
   * console.log(mandate.status); // "Active" | "Paused" | "Revoked" | "Completed" | "Expired"
   * ```
   */
  async get(mandateId: string): Promise<MandateResponse> {
    return this.http.request<MandateResponse>("GET", `/mandates/${encodeURIComponent(mandateId)}`);
  }
}

/**
 * @example
 * ```ts
 * import { StellarMandates } from "@paymap/sdk";
 *
 * const mandates = new StellarMandates({
 *   apiKey: process.env.STELLAR_MANDATES_API_KEY!,
 *   baseUrl: "https://api.paymap.example/v1",
 * });
 * ```
 */
export class StellarMandates {
  readonly checkoutSessions: CheckoutSessionsResource;
  readonly charges: ChargesResource;
  readonly payments: PaymentsResource;
  readonly mandates: MandatesResource;

  constructor(options: StellarMandatesOptions) {
    if (!options.apiKey) {
      throw new Error("StellarMandates requires a non-empty `apiKey`.");
    }
    const http = new HttpClient({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: options.apiKey,
      fetchImpl: options.fetch ?? fetch,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.checkoutSessions = new CheckoutSessionsResource(http);
    this.charges = new ChargesResource(http);
    this.payments = new PaymentsResource(http);
    this.mandates = new MandatesResource(http);
  }
}
