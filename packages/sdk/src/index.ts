/**
 * Merchant-facing TypeScript SDK (checkout sessions, charges, refunds,
 * webhook verification). See `client.ts` for `StellarMandates` and
 * `verify-webhook.ts` for `verifyWebhook` — PLAN.md §17's SDK design.
 */
export const SDK_PACKAGE_NAME = "@paymap/sdk" as const;

export * from "./client.js";
export * from "./verify-webhook.js";
