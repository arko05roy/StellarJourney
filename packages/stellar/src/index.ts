/**
 * Soroban transaction builder, simulation helper, auth-entry assembly, and
 * contract error-code decoder. Populated in Phase 7.
 */
export const STELLAR_PACKAGE_NAME = "@paymap/stellar" as const;

export * from "./errors.js";
export * from "./signer.js";
export * from "./submit.js";
export * from "./token.js";
export * from "./events.js";
