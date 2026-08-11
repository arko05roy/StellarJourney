/**
 * Generated Soroban client bindings for mandate-registry, plus a typed
 * facade (i128 <-> bigint, never `number`; see CLAUDE.md §5). Populated in
 * Phase 7.
 */
export const CONTRACT_CLIENT_PACKAGE_NAME = "@paymap/contract-client" as const;

export * from "./domain.js";
export * from "./deployment-registry.js";
export * from "./client.js";

export type {
  Mandate as GeneratedMandate,
  MandateInput as GeneratedMandateInput,
  MandateStatus as GeneratedMandateStatus,
  PaymentReceipt as GeneratedPaymentReceipt,
  RefundReceipt as GeneratedRefundReceipt,
} from "./generated/mandate-registry.js";
export { Errors as GENERATED_ERRORS } from "./generated/mandate-registry.js";
