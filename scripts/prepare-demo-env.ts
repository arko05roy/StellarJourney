#!/usr/bin/env tsx
/**
 * Creates a local, gitignored `.env` for the documented demo bootstrap.
 * Refuses to overwrite an existing file. Secrets are generated in memory,
 * written mode 0600, never printed.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDeployment } from "@paymap/contract-client";
import { ensureFundedIdentity, log } from "./lib/testnet-setup.js";

const SCOPE = "prepare-demo-env";
const NETWORK = "testnet";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
const RELAYER_IDENTITY = "paymap-relayer";

async function main(): Promise<void> {
  if (existsSync(ENV_PATH)) {
    throw new Error(
      `Refusing to overwrite existing ${ENV_PATH}. Remove it explicitly to regenerate demo credentials.`,
    );
  }

  const deployment = loadDeployment(NETWORK);
  await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, RELAYER_IDENTITY);
  const relayerSecret = execFileSync("stellar", ["keys", "secret", RELAYER_IDENTITY], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

  const lines = [
    'DATABASE_URL="postgresql://postgres:postgres@localhost:5432/paymap?schema=public"',
    'REDIS_URL="redis://localhost:6379"',
    `STELLAR_NETWORK="${NETWORK}"`,
    `SOROBAN_RPC_URL="${deployment.rpcUrl}"`,
    `HORIZON_URL="${HORIZON_URL}"`,
    `MANDATE_CONTRACT_ID="${deployment.contractId}"`,
    `RELAYER_SECRET_KEY="${relayerSecret}"`,
    `WEBHOOK_ENCRYPTION_KEY="${randomBytes(32).toString("hex")}"`,
    `API_KEY_HASH_SECRET="${randomBytes(32).toString("hex")}"`,
    'NEXT_PUBLIC_API_URL="http://localhost:3001"',
    "",
  ];
  writeFileSync(ENV_PATH, lines.join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(ENV_PATH, 0o600);
  log(SCOPE, `.env created at ${ENV_PATH} (mode 0600; secret values hidden)`);
}

main().catch((error: unknown) => {
  console.error(`[${SCOPE}] failed:`, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
