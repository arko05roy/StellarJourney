/**
 * Shared testnet account/asset bootstrapping helpers used by both
 * `scripts/deploy-testnet.ts` and `scripts/create-demo-mandate.ts` — kept in
 * one place rather than duplicated across the two entry points, since both
 * need the identical "ensure this identity/trustline/balance exists"
 * idempotent-ish logic (CLAUDE.md §20 — avoid duplicated logic across
 * files).
 */
import { execFileSync } from "node:child_process";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function stellarCliEnv(args: readonly string[]): NodeJS.ProcessEnv {
  const {
    SOROBAN_RPC_URL: _sorobanRpcUrl,
    STELLAR_RPC_URL: _stellarRpcUrl,
    STELLAR_NETWORK_PASSPHRASE: _networkPassphrase,
    ...env
  } = process.env;
  return args.includes("testnet")
    ? { ...env, STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE }
    : env;
}

export function log(scope: string, message: string): void {
  console.log(`[${scope}] ${message}`);
}

export function stellar(args: string[]): string {
  return execFileSync("stellar", args, {
    encoding: "utf-8",
    env: stellarCliEnv(args),
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export function stellarOk(args: string[]): boolean {
  try {
    execFileSync("stellar", args, { encoding: "utf-8", env: stellarCliEnv(args), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

export async function fetchHorizonAccount(
  horizonUrl: string,
  publicKey: string,
): Promise<{ balances: HorizonBalance[] } | undefined> {
  const response = await fetch(`${horizonUrl}/accounts/${publicKey}`);
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Horizon account lookup for ${publicKey} failed: HTTP ${String(response.status)}`,
    );
  }
  return (await response.json()) as { balances: HorizonBalance[] };
}

/** Ensures a local CLI identity `name` exists and its account is funded on the given network (via friendbot, if the identity was just created or was created but never funded). Returns the account's public key. */
export async function ensureFundedIdentity(
  scope: string,
  _network: string,
  horizonUrl: string,
  name: string,
): Promise<string> {
  let publicKey: string | undefined;
  try {
    publicKey = stellar(["keys", "address", name]);
  } catch {
    publicKey = undefined;
  }

  if (publicKey === undefined) {
    log(scope, `identity "${name}" not found — generating and funding via friendbot`);
    stellar(["keys", "generate", name]);
    publicKey = stellar(["keys", "address", name]);
  }

  const account = await fetchHorizonAccount(horizonUrl, publicKey);
  if (account === undefined) {
    log(
      scope,
      `identity "${name}" (${publicKey}) has no funded account yet — funding via friendbot`,
    );
    const response = await fetch(`https://friendbot.stellar.org/?addr=${publicKey}`);
    if (!response.ok) {
      throw new Error(
        `friendbot funding for ${name} (${publicKey}) failed: HTTP ${String(response.status)}`,
      );
    }
  }
  log(scope, `identity "${name}" ready: ${publicKey}`);
  return publicKey;
}

export function hasTrustline(
  balances: HorizonBalance[],
  assetCode: string,
  issuerPublicKey: string,
): boolean {
  return balances.some(
    (b) =>
      b.asset_type !== "native" && b.asset_code === assetCode && b.asset_issuer === issuerPublicKey,
  );
}

export async function ensureTrustline(
  scope: string,
  network: string,
  horizonUrl: string,
  accountName: string,
  accountPublicKey: string,
  assetCode: string,
  issuerPublicKey: string,
): Promise<void> {
  const account = await fetchHorizonAccount(horizonUrl, accountPublicKey);
  if (account !== undefined && hasTrustline(account.balances, assetCode, issuerPublicKey)) {
    log(scope, `${accountName} already trusts ${assetCode}`);
    return;
  }
  log(scope, `${accountName} establishing trustline to ${assetCode}:${issuerPublicKey}`);
  stellar([
    "tx",
    "new",
    "change-trust",
    "--source-account",
    accountName,
    "--line",
    `${assetCode}:${issuerPublicKey}`,
    "--network",
    network,
  ]);
}

/** Tops `accountName` up to at least `targetBaseUnits` of `assetCode` (7-decimal classic asset base units), paid from `issuerAccountName`. No-op if already at or above target. */
export async function ensureAssetBalance(
  scope: string,
  network: string,
  horizonUrl: string,
  issuerAccountName: string,
  issuerPublicKey: string,
  accountName: string,
  accountPublicKey: string,
  assetCode: string,
  targetBaseUnits: bigint,
): Promise<void> {
  const account = await fetchHorizonAccount(horizonUrl, accountPublicKey);
  const existing = account?.balances.find(
    (b) =>
      b.asset_type !== "native" && b.asset_code === assetCode && b.asset_issuer === issuerPublicKey,
  );
  // Horizon reports classic-asset balances as decimal strings with 7 fractional digits.
  const existingBaseUnits =
    existing !== undefined ? BigInt(Math.round(Number(existing.balance) * 10_000_000)) : 0n;
  if (existingBaseUnits >= targetBaseUnits) {
    log(scope, `${accountName} already holds ${existing?.balance ?? "0"} ${assetCode} (>= target)`);
    return;
  }
  const topUpBaseUnits = targetBaseUnits - existingBaseUnits;
  const topUpDecimal = `${(topUpBaseUnits / 10_000_000n).toString()}.${(topUpBaseUnits % 10_000_000n).toString().padStart(7, "0")}`;
  log(scope, `funding ${accountName} with ${topUpDecimal} ${assetCode}`);
  stellar([
    "tx",
    "new",
    "payment",
    "--source-account",
    issuerAccountName,
    "--destination",
    accountPublicKey,
    "--asset",
    `${assetCode}:${issuerPublicKey}`,
    "--amount",
    topUpBaseUnits.toString(),
    "--network",
    network,
  ]);
}
