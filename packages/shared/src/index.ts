/**
 * Cross-workspace shared types, Zod schemas, and money/time constants.
 * Populated in Phase 1 (contract types, re-exported from `@paymap/contract-client`
 * here) and Phase 7 (decimal <-> base-unit conversion, Zod mirrors).
 */
export const SHARED_PACKAGE_NAME = "@paymap/shared" as const;

export * from "./money.js";
export * from "./types.js";
export * from "./webhook-signature.js";
export * from "./webhook-secret-crypto.js";
export * from "./charge-authorization-crypto.js";
export * from "./webhook-url-guard.js";
