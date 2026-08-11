/**
 * Request/response DTOs mirroring `apps/api/src/schemas/*` and each route's
 * response shape exactly (`docs/merchant-api.md` is the canonical reference
 * these were transcribed from). Money fields are decimal strings
 * (CLAUDE.md §9 — never floating point); every timestamp is ISO 8601.
 */

// ---------------------------------------------------------------------------
// Checkout sessions
// ---------------------------------------------------------------------------

export interface CreateCheckoutSessionInput {
  productId: string;
  clientReference?: string;
  payerAddress?: string;
  /** Defaults server-side to `now + product.defaultDurationSeconds` when omitted. */
  expiresAt?: string;
  /**
   * Accepted for call-shape compatibility with PLAN.md §17's SDK example.
   * **Not yet enforced by the current API version** — the checkout page's
   * redirect targets are a frontend concern the merchant API doesn't model
   * yet (`docs/merchant-api.md` documents this gap explicitly). Forwarded
   * in the request body (harmlessly ignored server-side) rather than
   * silently dropped, so a future API version can pick it up with zero SDK
   * changes.
   */
  successUrl?: string;
  cancelUrl?: string;
  /** Auto-generated (`crypto.randomUUID()`) when omitted — every mutating call is idempotent-safe by default. */
  idempotencyKey?: string;
}

export interface CheckoutSessionResponse {
  id: string;
  merchantId: string;
  productId: string;
  clientReference?: string;
  payerAddress?: string;
  expiresAt: string;
  status: string;
  mandateId?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

export interface CreateChargeInput {
  mandateId: string;
  /** Decimal string, e.g. `"15.00"` — never a floating-point number. */
  amount: string;
  /**
   * Accepted for call-shape compatibility with PLAN.md §17's SDK example.
   * The mandate's own on-chain asset is authoritative and is what the
   * relayer/contract actually validate against (CLAUDE.md §1) — this field
   * is not sent to the API (there is nothing for it to do there) and exists
   * purely so the example call shape typechecks unmodified.
   */
  asset?: string;
  /**
   * A merchant-chosen invoice identifier (any string, e.g.
   * `"invoice_2026_08_001"`) — the API's `invoiceHash` field must be a
   * 32-byte hex hash, not a human-readable string, so the SDK computes
   * `sha256(invoiceId)` and sends *that*. This is deterministic (the same
   * `invoiceId` always hashes the same way), so retrying with the same
   * `invoiceId` is safe and consistent with the `idempotencyKey` below.
   */
  invoiceId: string;
  /** Defaults to now server-side when omitted. */
  scheduledFor?: string;
  /** Auto-generated when omitted. */
  idempotencyKey?: string;
}

export interface ChargeResponse {
  id: string;
  mandateId: string;
  chargeId: string;
  amount: string;
  invoiceHash: string;
  scheduledFor: string;
  status: string;
  attemptCount: number;
  failureCode?: string;
  transactionHash?: string;
  createdAt: string;
}

export interface ChargeAuthorizationChallenge {
  id: string;
  mandateId: string;
  chargeId: string;
  amount: string;
  invoiceHash: string;
  scheduledFor: string;
  merchantAddress: string;
  contractId: string;
  networkPassphrase: string;
  signatureExpirationLedger: number;
  unsignedAuthorizationEntryXdr: string;
  authorizationPreimageXdr: string;
  status: "pending";
}

// ---------------------------------------------------------------------------
// Payments / refunds
// ---------------------------------------------------------------------------

export interface ListPaymentsQuery {
  mandateId?: string;
  limit?: number;
}

export interface PaymentResponse {
  paymentId: string;
  mandateId: string;
  chargeId: string;
  amount: string;
  assetAddress: string;
  transactionHash: string;
  ledger: string;
  refundedTotal: string;
  createdAt: string;
}

export interface CreateRefundInput {
  paymentId: string;
  amount: string;
  idempotencyKey?: string;
}

export interface RefundResponse {
  id: string;
  paymentId: string;
  refundId: string;
  amount: string;
  status: string;
  transactionHash?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Mandates (live on-chain read — GET /v1/mandates/:id)
// ---------------------------------------------------------------------------

export type MandateAmountRule =
  { kind: "fixed"; amountBaseUnits: string } | { kind: "variable"; maxPerChargeBaseUnits: string };

export interface MandateResponse {
  id: string;
  payer: string;
  merchant: string;
  asset: string;
  status: "Active" | "Paused" | "Revoked" | "Completed" | "Expired";
  amountRule: MandateAmountRule;
  maxPerPeriodBaseUnits: string;
  periodSeconds: string;
  minIntervalSeconds: string;
  startAt: string;
  expiresAt: string;
  maxSuccessfulCharges: number;
  successfulCharges: number;
  totalCollectedBaseUnits: string;
  currentPeriodStart: string;
  currentPeriodCollectedBaseUnits: string;
  lastChargedAt?: string;
  createdAt: string;
}
