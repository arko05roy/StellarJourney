/**
 * Loads the deployment registry (`deployments/<network>.json`, Phase 7),
 * written by `scripts/deploy-testnet.ts` and committed to the repo — it only
 * contains public information (contract ids, wasm hash, network endpoints),
 * never a secret.
 *
 * This is a monorepo-internal convenience, not a published-package
 * guarantee: `@paymap/contract-client` is never published standalone, so
 * reaching outside this package's own directory (via a relative filesystem
 * path from wherever this module happens to be loaded from — `src/` under
 * `tsx`/vitest, or `dist/` after `tsc`) to the repo-root `deployments/`
 * directory is safe here in a way it would not be for an npm-published
 * package.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type NetworkName = "testnet" | "futurenet" | "local" | "mainnet";

export interface AssetDeploymentInfo {
  /** SEP-41 asset code, e.g. `"PUSD"`. */
  code: string;
  /** Classic Stellar issuer account (`G...`) that issued the asset. */
  issuer: string;
  /** Deployed Stellar Asset Contract id (`C...`) wrapping the classic asset. */
  contractId: string;
  /** Declared decimals, needed for `packages/shared`'s decimal<->base-unit conversion. */
  decimals: number;
}

export interface DeploymentRecord {
  network: NetworkName;
  networkPassphrase: string;
  /** Deployed `mandate-registry` contract id (`C...`). */
  contractId: string;
  /** Hex-encoded Wasm hash installed on-chain for `contractId`. */
  wasmHash: string;
  /** ISO 8601 timestamp of the deployment that produced this record. */
  deployedAt: string;
  rpcUrl: string;
  asset: AssetDeploymentInfo;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Minimal structural validation — this is trusted, repo-committed data, not an untrusted boundary, so a full Zod schema would be overkill; this just fails loudly on an obviously truncated/corrupted file instead of handing back `undefined` fields silently. */
function assertValidDeploymentRecord(value: unknown, network: NetworkName, path: string): asserts value is DeploymentRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${path} did not contain a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const requiredStringFields = ["network", "networkPassphrase", "contractId", "wasmHash", "deployedAt", "rpcUrl"] as const;
  for (const field of requiredStringFields) {
    if (!isNonEmptyString(record[field])) {
      throw new Error(`${path} is missing required string field "${field}"`);
    }
  }
  if (record["network"] !== network) {
    throw new Error(`${path} has network "${String(record["network"])}", expected "${network}"`);
  }
  const asset = record["asset"];
  if (typeof asset !== "object" || asset === null) {
    throw new Error(`${path} is missing the "asset" object`);
  }
  const assetRecord = asset as Record<string, unknown>;
  for (const field of ["code", "issuer", "contractId"] as const) {
    if (!isNonEmptyString(assetRecord[field])) {
      throw new Error(`${path}'s "asset" is missing required string field "${field}"`);
    }
  }
  if (typeof assetRecord["decimals"] !== "number") {
    throw new Error(`${path}'s "asset" is missing required number field "decimals"`);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
// packages/contract-client/{src,dist}/<this file> -> repo root is 3 levels up either way.
const REPO_ROOT = join(here, "..", "..", "..");

/** Reads and validates `deployments/<network>.json`. Throws with an actionable message if the network hasn't been deployed yet. */
export function loadDeployment(network: NetworkName): DeploymentRecord {
  const path = join(REPO_ROOT, "deployments", `${network}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    throw new Error(
      `No deployment registry found for network "${network}" at ${path}. Run scripts/deploy-testnet.ts first.`,
      { cause: error },
    );
  }
  const parsed: unknown = JSON.parse(raw);
  assertValidDeploymentRecord(parsed, network, path);
  return parsed;
}
