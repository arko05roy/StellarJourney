/**
 * Generated Soroban client bindings for mandate-registry, plus a typed
 * facade (i128 <-> bigint, never `number`; see CLAUDE.md §5). Populated in
 * Phase 7.
 *
 * This barrel re-exports `./deployment-registry.js`, which reads
 * `deployments/<network>.json` via `node:fs`/`node:path`/`node:url` at
 * import time — fine for every Node consumer (apps/api, apps/relayer,
 * scripts), but importing anything from *this* path in a browser-bundled
 * file (e.g. a Next.js Client Component) drags that Node-only module into
 * the bundle too, since a bundler can't tell which named export a caller
 * actually uses when the import statement mixes value and type bindings.
 * Browser-side code (Phase 10's `apps/web`) that only needs the client
 * facade/domain types — never `loadDeployment` itself, which only ever
 * runs server-side — should import from the `./client` / `./domain`
 * subpaths instead (see `package.json`'s `exports` map), which have no
 * transitive `node:fs` dependency.
 */
export const CONTRACT_CLIENT_PACKAGE_NAME = "@paymap/contract-client" as const;

export * from "./domain.js";
export * from "./deployment-registry.js";
export * from "./client.js";
export * from "./events.js";

export type {
  Mandate as GeneratedMandate,
  MandateInput as GeneratedMandateInput,
  MandateStatus as GeneratedMandateStatus,
  PaymentReceipt as GeneratedPaymentReceipt,
  RefundReceipt as GeneratedRefundReceipt,
} from "./generated/mandate-registry.js";
export { Errors as GENERATED_ERRORS } from "./generated/mandate-registry.js";
