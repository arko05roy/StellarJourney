#!/usr/bin/env tsx
/**
 * Builds, optimizes, and deploys `mandate-registry` to Stellar testnet, and
 * ensures a real SEP-41 test asset (a classic Stellar asset wrapped by its
 * Stellar Asset Contract, "SAC") exists for `scripts/create-demo-mandate.ts`
 * to exercise the contract against — this is deliberately a *real* SAC, not
 * `mock-token`, since Phase 6 only proved the contract's SEP-41 calls
 * (`approve`/`allowance`/`transfer_from`/`transfer`/`balance`) against the
 * hand-rolled test double.
 *
 * Design choice — classic asset + SAC, not an existing testnet USDC SAC:
 * this repo needs a mintable, fully-controlled asset (issuer under our own
 * key) so the demo script can freely fund a payer account with an arbitrary
 * balance; a shared testnet USDC deployment would require begging a faucet
 * for exactly the right amount and offers no advantage in security-relevant
 * behavior — a SAC's `approve`/`transfer_from` semantics are identical
 * regardless of which classic asset it wraps.
 *
 * Idempotent-ish (CLAUDE.md's phrasing, PLAN.md milestone 4): re-running is
 * safe —
 *   - identities are generated+funded only if missing
 *   - the wasm upload is a no-op if the same hash is already installed
 *     (the Stellar CLI itself detects and skips this)
 *   - the SAC is only deployed if it does not already exist on-chain
 *   - trustlines/PUSD funding are only performed if not already sufficient
 *   - a fresh `mandate-registry` *instance* is created every run (that is
 *     the point of "deploy") and overwrites `deployments/testnet.json`
 *
 * Writes `deployments/<network>.json` (CLAUDE.md §7 wants this loaded by
 * `packages/contract-client`; see `deployment-registry.ts` there) — this
 * file only ever contains public information (contract ids, wasm hash,
 * endpoints), so it is committed, never gitignored.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureAssetBalance, ensureFundedIdentity, ensureTrustline, log, stellar, stellarOk } from "./lib/testnet-setup.js";

const SCOPE = "deploy-testnet";
const NETWORK = "testnet";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const DEPLOYER = "paymap-deployer";
const ASSET_ISSUER = "paymap-asset-issuer";
const MERCHANT = "paymap-merchant";
const PAYER = "paymap-payer";

const ASSET_CODE = "PUSD";
/** Every classic Stellar asset wrapped by a Stellar Asset Contract has exactly 7 decimals — a fixed rule of the SAC bridge, not a per-asset choice. */
const ASSET_DECIMALS = 7;
/** 10,000 PUSD, in the asset's 7-decimal base units — enough headroom for `create-demo-mandate.ts`'s bounded-allowance flow across repeated demo runs. */
const PAYER_TARGET_BALANCE_BASE_UNITS = 10_000n * 10_000_000n;

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..");
// `stellar contract build --optimize` optimizes in place (overwrites the
// plain build output), unlike the deprecated separate `contract optimize`
// command which wrote a distinct `*.optimized.wasm` file — verified by
// inspecting `target/wasm32v1-none/release/` after a real build.
const WASM_PATH = join(REPO_ROOT, "target", "wasm32v1-none", "release", "mandate_registry.wasm");
const DEPLOYMENTS_DIR = join(REPO_ROOT, "deployments");

function buildAndOptimizeWasm(): void {
  log(SCOPE, "building + optimizing mandate-registry wasm (stellar contract build --optimize)");
  execFileSync("stellar", ["contract", "build", "--package", "mandate-registry", "--profile", "release", "--optimize"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

function uploadWasm(): string {
  log(SCOPE, `uploading wasm from ${WASM_PATH} (source: ${DEPLOYER})`);
  const wasmHash = stellar(["contract", "upload", "--wasm", WASM_PATH, "--source", DEPLOYER, "--network", NETWORK]);
  log(SCOPE, `wasm hash: ${wasmHash}`);
  return wasmHash;
}

function deployMandateRegistry(wasmHash: string): string {
  log(SCOPE, "deploying a fresh mandate-registry instance");
  const contractId = stellar(["contract", "deploy", "--wasm-hash", wasmHash, "--source", DEPLOYER, "--network", NETWORK]);
  log(SCOPE, `mandate-registry contract id: ${contractId}`);
  return contractId;
}

/** Deterministic — no network call — so this can check whether the SAC already exists before attempting to (re-)deploy it. */
function computeAssetContractId(assetCode: string, issuerPublicKey: string): string {
  return stellar(["contract", "id", "asset", "--asset", `${assetCode}:${issuerPublicKey}`, "--network", NETWORK]);
}

function assetContractExists(contractId: string): boolean {
  return stellarOk(["contract", "info", "interface", "--id", contractId, "--network", NETWORK]);
}

function deployAssetSac(assetCode: string, issuerPublicKey: string): string {
  log(SCOPE, `deploying Stellar Asset Contract for ${assetCode}:${issuerPublicKey}`);
  const contractId = stellar(["contract", "asset", "deploy", "--asset", `${assetCode}:${issuerPublicKey}`, "--source", DEPLOYER, "--network", NETWORK]);
  log(SCOPE, `asset contract id: ${contractId}`);
  return contractId;
}

async function main(): Promise<void> {
  log(SCOPE, `network: ${NETWORK} (${NETWORK_PASSPHRASE})`);
  log(SCOPE, `rpc: ${RPC_URL}`);

  const deployerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, DEPLOYER);
  const issuerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, ASSET_ISSUER);
  const merchantKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, MERCHANT);
  const payerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, PAYER);
  log(SCOPE, `deployer=${deployerKey} issuer=${issuerKey} merchant=${merchantKey} payer=${payerKey}`);

  buildAndOptimizeWasm();
  const wasmHash = uploadWasm();
  const contractId = deployMandateRegistry(wasmHash);

  const assetContractId = computeAssetContractId(ASSET_CODE, issuerKey);
  if (assetContractExists(assetContractId)) {
    log(SCOPE, `${ASSET_CODE} SAC already deployed at ${assetContractId} — reusing`);
  } else {
    const deployed = deployAssetSac(ASSET_CODE, issuerKey);
    if (deployed !== assetContractId) {
      throw new Error(`deployed asset contract id "${deployed}" did not match the deterministically computed id "${assetContractId}"`);
    }
  }

  await ensureTrustline(SCOPE, NETWORK, HORIZON_URL, MERCHANT, merchantKey, ASSET_CODE, issuerKey);
  await ensureTrustline(SCOPE, NETWORK, HORIZON_URL, PAYER, payerKey, ASSET_CODE, issuerKey);
  await ensureAssetBalance(SCOPE, NETWORK, HORIZON_URL, ASSET_ISSUER, issuerKey, PAYER, payerKey, ASSET_CODE, PAYER_TARGET_BALANCE_BASE_UNITS);

  mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  const record = {
    network: NETWORK,
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId,
    wasmHash,
    deployedAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    asset: {
      code: ASSET_CODE,
      issuer: issuerKey,
      contractId: assetContractId,
      decimals: ASSET_DECIMALS,
    },
  };
  const outPath = join(DEPLOYMENTS_DIR, `${NETWORK}.json`);
  writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
  log(SCOPE, `wrote ${outPath}`);
  log(SCOPE, "done.");
}

main().catch((error: unknown) => {
  console.error(`[${SCOPE}] failed:`, error);
  process.exitCode = 1;
});
