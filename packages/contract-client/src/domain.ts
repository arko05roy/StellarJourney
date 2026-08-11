/**
 * Hand-written domain layer over the generated bindings
 * (`./generated/mandate-registry.js`). Every i128/u64 value is a `bigint`
 * here — never a JS `number` (CLAUDE.md §5) — and every 32-byte id is a
 * lowercase hex string rather than a raw `Buffer`, so callers outside this
 * package never have to think about the generated client's wire types.
 *
 * This file only converts shapes; it never re-implements a contract rule.
 */
import type {
  AmountRule as GenAmountRule,
  Mandate as GenMandate,
  MandateInput as GenMandateInput,
  MandateStatus as GenMandateStatus,
  PaymentReceipt as GenPaymentReceipt,
  RefundReceipt as GenRefundReceipt,
} from "./generated/mandate-registry.js";

const ID_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/** Encodes a 32-byte contract id (`mandate_id`, `charge_id`, `payment_id`, `refund_id`, `metadata_hash`, `invoice_hash`) as lowercase hex for use outside this package. */
export function idToHex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

/** Decodes a 32-byte hex id back into the `Buffer` the generated client's methods expect. Throws on anything that isn't exactly 64 hex characters. */
export function hexToId(hex: string): Buffer {
  if (!ID_HEX_PATTERN.test(hex)) {
    throw new Error(`expected a 32-byte (64 hex character) id, got "${hex}"`);
  }
  return Buffer.from(hex, "hex");
}

/** Mirrors `contracts/mandate-registry/src/types.rs::MandateStatus` — a plain string literal union instead of the generated `{tag, values}` shape. */
export type MandateStatus = GenMandateStatus["tag"];

export function toDomainMandateStatus(status: GenMandateStatus): MandateStatus {
  return status.tag;
}

/**
 * Mirrors `contracts/mandate-registry/src/types.rs::AmountRule`. The
 * contract's `Variable(i128)` tuple variant (a mechanical SDK-forced
 * deviation from PLAN.md's sketched named field, see that module's doc
 * comment) becomes a proper named field again at this boundary —
 * `maxPerCharge` — since nothing downstream of this package needs to know
 * about the SDK constraint that produced the positional form.
 */
export type AmountRule = { kind: "fixed"; amount: bigint } | { kind: "variable"; maxPerCharge: bigint };

export function toDomainAmountRule(rule: GenAmountRule): AmountRule {
  return rule.tag === "Fixed" ? { kind: "fixed", amount: rule.values[0] } : { kind: "variable", maxPerCharge: rule.values[0] };
}

export function fromDomainAmountRule(rule: AmountRule): GenAmountRule {
  return rule.kind === "fixed"
    ? { tag: "Fixed", values: [rule.amount] as const }
    : { tag: "Variable", values: [rule.maxPerCharge] as const };
}

/** Mirrors `contracts/mandate-registry/src/types.rs::Mandate` field-for-field. */
export interface Mandate {
  id: string;
  payer: string;
  merchant: string;
  asset: string;
  status: MandateStatus;
  amountRule: AmountRule;
  maxPerPeriod: bigint;
  periodSeconds: bigint;
  minIntervalSeconds: bigint;
  startAt: bigint;
  expiresAt: bigint;
  maxSuccessfulCharges: number;
  successfulCharges: number;
  totalCollected: bigint;
  currentPeriodStart: bigint;
  currentPeriodCollected: bigint;
  lastChargedAt: bigint | undefined;
  createdAt: bigint;
  metadataHash: string;
}

export function toDomainMandate(mandate: GenMandate): Mandate {
  return {
    id: idToHex(mandate.id),
    payer: mandate.payer,
    merchant: mandate.merchant,
    asset: mandate.asset,
    status: toDomainMandateStatus(mandate.status),
    amountRule: toDomainAmountRule(mandate.amount_rule),
    maxPerPeriod: mandate.max_per_period,
    periodSeconds: mandate.period_seconds,
    minIntervalSeconds: mandate.min_interval_seconds,
    startAt: mandate.start_at,
    expiresAt: mandate.expires_at,
    maxSuccessfulCharges: mandate.max_successful_charges,
    successfulCharges: mandate.successful_charges,
    totalCollected: mandate.total_collected,
    currentPeriodStart: mandate.current_period_start,
    currentPeriodCollected: mandate.current_period_collected,
    lastChargedAt: mandate.last_charged_at,
    createdAt: mandate.created_at,
    metadataHash: idToHex(mandate.metadata_hash),
  };
}

/** Mirrors `contracts/mandate-registry/src/types.rs::MandateInput` — the `create_mandate` argument struct. */
export interface MandateInput {
  payer: string;
  merchant: string;
  asset: string;
  amountRule: AmountRule;
  maxPerPeriod: bigint;
  periodSeconds: bigint;
  minIntervalSeconds: bigint;
  startAt: bigint;
  expiresAt: bigint;
  maxSuccessfulCharges: number;
  metadataHash: string;
  clientNonce: string;
}

export function fromDomainMandateInput(input: MandateInput): GenMandateInput {
  return {
    payer: input.payer,
    merchant: input.merchant,
    asset: input.asset,
    amount_rule: fromDomainAmountRule(input.amountRule),
    max_per_period: input.maxPerPeriod,
    period_seconds: input.periodSeconds,
    min_interval_seconds: input.minIntervalSeconds,
    start_at: input.startAt,
    expires_at: input.expiresAt,
    max_successful_charges: input.maxSuccessfulCharges,
    metadata_hash: hexToId(input.metadataHash),
    client_nonce: hexToId(input.clientNonce),
  };
}

/** Mirrors `contracts/mandate-registry/src/types.rs::PaymentReceipt`. */
export interface PaymentReceipt {
  paymentId: string;
  mandateId: string;
  chargeId: string;
  payer: string;
  merchant: string;
  asset: string;
  amount: bigint;
  invoiceHash: string;
  timestamp: bigint;
}

export function toDomainPaymentReceipt(receipt: GenPaymentReceipt): PaymentReceipt {
  return {
    paymentId: idToHex(receipt.payment_id),
    mandateId: idToHex(receipt.mandate_id),
    chargeId: idToHex(receipt.charge_id),
    payer: receipt.payer,
    merchant: receipt.merchant,
    asset: receipt.asset,
    amount: receipt.amount,
    invoiceHash: idToHex(receipt.invoice_hash),
    timestamp: receipt.timestamp,
  };
}

/** Mirrors `contracts/mandate-registry/src/types.rs::RefundReceipt`. */
export interface RefundReceipt {
  refundId: string;
  paymentId: string;
  amount: bigint;
  timestamp: bigint;
}

export function toDomainRefundReceipt(receipt: GenRefundReceipt): RefundReceipt {
  return {
    refundId: idToHex(receipt.refund_id),
    paymentId: idToHex(receipt.payment_id),
    amount: receipt.amount,
    timestamp: receipt.timestamp,
  };
}
