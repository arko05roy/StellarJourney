#!/usr/bin/env tsx
/**
 * Controlled Paymap testnet stress run.
 *
 * Creates fresh CLI identities, exercises the real merchant-auth/API/relayer
 * path, verifies every transaction through Horizon, and writes public
 * evidence. Secret keys and session credentials remain only in a temporary
 * directory and process memory.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCreateMandate,
  createMandateRegistryClient,
  getMandate,
  idToHex,
  loadDeployment,
  type MandateInput,
} from "@paymap/contract-client";
import { decimalToBaseUnits } from "@paymap/shared";
import { keypairSigner, signChargeAuthorization, submitAsInvoker } from "@paymap/stellar";
import { hash, Keypair } from "@stellar/stellar-sdk";

const SCOPE = "stress-testnet";
const NETWORK = "testnet";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const DEFAULT_API_URL = "https://paymap-demo-api.onrender.com/v1";
const ISSUER_IDENTITY = "paymap-asset-issuer";
const PAYER_COUNT = 7;
const MERCHANT_COUNT = 5;
const EXPECTED_TRANSACTION_COUNT = 52;
const CHARGE_AMOUNT = "0.1";
const PAYER_ASSET_FUNDING_BASE_UNITS = 2_000_000n;
const SIGNED_MESSAGE_PREFIX = "Stellar Signed Message:\n";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const TERMINAL_CHARGE_STATUSES = new Set(["succeeded", "permanently_failed"]);

interface PublicAccount {
  role: "payer" | "merchant";
  index: number;
  address: string;
  fundingTransactionHash: string;
  trustlineTransactionHash: string;
}

interface PrivateAccount extends PublicAccount {
  identity: string;
  keypair: Keypair;
}

interface MerchantContext {
  account: PrivateAccount;
  sessionToken: string;
  merchantId: string;
  productId: string;
}

interface TransactionEvidence {
  hash: string;
  phase: string;
  sourceAddress: string;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

function log(message: string): void {
  console.log(`[${SCOPE}] ${message}`);
}

function hex32(): string {
  return randomBytes(32).toString("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`invalid transaction hash returned: ${value}`);
  }
  return normalized;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function transactionEvidenceCsv(
  runId: string,
  startedAt: string,
  transactions: readonly TransactionEvidence[],
): string {
  const header = [
    "run_id",
    "run_started_at",
    "network",
    "phase",
    "transaction_hash",
    "source_address",
    "verification_status",
    "stellar_expert_url",
  ];
  const rows = transactions.map((transaction) => [
    runId,
    startedAt,
    NETWORK,
    transaction.phase,
    transaction.hash,
    transaction.sourceAddress,
    "successful",
    `https://stellar.expert/explorer/${NETWORK}/tx/${transaction.hash}`,
  ]);
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function safeApiUrl(): string {
  const value = (process.env["STRESS_API_URL"] ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const parsed = new URL(value);
  const allowed =
    parsed.protocol === "https:" &&
    (parsed.hostname === "paymap-demo-api.onrender.com" ||
      process.env["STRESS_ALLOW_ANY_API"] === "1");
  if (!allowed) {
    throw new Error(
      "STRESS_API_URL must be the Paymap HTTPS deployment; set STRESS_ALLOW_ANY_API=1 for an intentional override.",
    );
  }
  return value;
}

function stellarEnv(): NodeJS.ProcessEnv {
  const {
    SOROBAN_RPC_URL: _sorobanRpcUrl,
    STELLAR_RPC_URL: _stellarRpcUrl,
    STELLAR_NETWORK_PASSPHRASE: _networkPassphrase,
    ...env
  } = process.env;
  return { ...env, STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE };
}

function stellar(args: string[]): string {
  return execFileSync("stellar", args, {
    encoding: "utf8",
    env: stellarEnv(),
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function accountAddress(identity: string, configDir: string): string {
  return stellar(["keys", "address", identity, "--config-dir", configDir]);
}

function accountSecret(identity: string, configDir: string): string {
  return stellar(["keys", "secret", identity, "--config-dir", configDir]);
}

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  options: { retries?: number; retryStatuses?: readonly number[] } = {},
): Promise<T> {
  const retries = options.retries ?? 0;
  const retryStatuses = options.retryStatuses ?? [429, 502, 503, 504];
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok) {
        return (await response.json()) as T;
      }
      const text = await response.text();
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as ApiErrorBody;
        detail = parsed.error?.message ?? parsed.error?.code ?? detail;
      } catch {
        // Preserve the bounded response text.
      }
      lastError = new Error(`HTTP ${String(response.status)} from ${url}: ${detail}`);
      if (!retryStatuses.includes(response.status) || attempt === retries) {
        throw lastError;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === retries) throw lastError;
    }
    await sleep(Math.min(10_000, 1_000 * 2 ** attempt));
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

async function fetchOk(url: string, retries = 0): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url);
    lastStatus = response.status;
    if (response.ok) return;
    if (![429, 502, 503, 504].includes(response.status) || attempt === retries) break;
    await sleep(Math.min(10_000, 1_000 * 2 ** attempt));
  }
  throw new Error(`HTTP ${String(lastStatus)} from ${url}`);
}

async function apiRequest<T>(
  apiUrl: string,
  path: string,
  init: RequestInit = {},
  retries = 2,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return fetchJson<T>(`${apiUrl}${path}`, { ...init, headers }, { retries });
}

async function latestAccountTransactionHash(address: string): Promise<string | undefined> {
  const body = await fetchJson<{
    _embedded?: { records?: Array<{ hash?: string }> };
  }>(`${HORIZON_URL}/accounts/${address}/transactions?order=desc&limit=1`, {}, { retries: 3 });
  const value = body._embedded?.records?.[0]?.hash;
  return value ? normalizeHash(value) : undefined;
}

async function waitForNextAccountTransaction(
  address: string,
  previousHash: string | undefined,
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await latestAccountTransactionHash(address);
    if (current && current !== previousHash) return current;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for a new transaction from ${address}`);
}

async function runCliTransaction(
  sourceAddress: string,
  args: string[],
): Promise<string> {
  const previousHash = await latestAccountTransactionHash(sourceAddress);
  stellar(args);
  return waitForNextAccountTransaction(sourceAddress, previousHash);
}

async function fundAccount(address: string): Promise<string> {
  const result = await fetchJson<{ hash?: string }>(
    `${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`,
    {},
    { retries: 6, retryStatuses: [429, 500, 502, 503, 504] },
  );
  if (result.hash) return normalizeHash(result.hash);
  const hashValue = await latestAccountTransactionHash(address);
  if (!hashValue) throw new Error(`Friendbot funded ${address} without a visible transaction`);
  return hashValue;
}

async function createFreshAccount(
  role: PublicAccount["role"],
  index: number,
  configDir: string,
  runId: string,
  deployment: ReturnType<typeof loadDeployment>,
): Promise<PrivateAccount> {
  const identity = `${runId}-${role}-${String(index + 1)}`;
  stellar(["keys", "generate", identity, "--config-dir", configDir, "--quiet"]);
  const address = accountAddress(identity, configDir);
  const keypair = Keypair.fromSecret(accountSecret(identity, configDir));
  const fundingTransactionHash = await fundAccount(address);
  const trustlineTransactionHash = await runCliTransaction(address, [
    "tx",
    "new",
    "change-trust",
    "--source-account",
    identity,
    "--line",
    `${deployment.asset.code}:${deployment.asset.issuer}`,
    "--network",
    NETWORK,
    "--config-dir",
    configDir,
  ]);
  log(`${role} ${String(index + 1)} ready: ${address}`);
  return {
    role,
    index,
    identity,
    address,
    keypair,
    fundingTransactionHash,
    trustlineTransactionHash,
  };
}

async function latestLedger(rpcUrl: string): Promise<number> {
  const body = await fetchJson<{
    result?: { sequence?: number };
    error?: { message?: string };
  }>(
    rpcUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} }),
    },
    { retries: 3 },
  );
  const sequence = body.result?.sequence;
  if (sequence === undefined) {
    throw new Error(`RPC getLatestLedger failed: ${body.error?.message ?? "missing sequence"}`);
  }
  return sequence;
}

async function authenticateMerchant(
  apiUrl: string,
  account: PrivateAccount,
  runId: string,
): Promise<{ sessionToken: string; merchantId: string }> {
  const challenge = await apiRequest<{
    challengeId: string;
    message: string;
  }>(apiUrl, "/merchant-auth/challenges", {
    method: "POST",
    body: JSON.stringify({ walletAddress: account.address }),
  });
  const digest = createHash("sha256")
    .update(SIGNED_MESSAGE_PREFIX, "utf8")
    .update(challenge.message, "utf8")
    .digest();
  const completed = await apiRequest<{
    sessionToken: string;
    profileRequired: boolean;
    merchant?: { id: string };
  }>(apiUrl, "/merchant-auth/complete", {
    method: "POST",
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      message: challenge.message,
      signature: account.keypair.sign(digest).toString("base64"),
      signerAddress: account.address,
    }),
  });
  if (!completed.profileRequired || completed.merchant) {
    throw new Error(`fresh merchant wallet ${account.address} unexpectedly has a profile`);
  }
  const registered = await apiRequest<{ merchantId: string }>(
    apiUrl,
    "/merchant-auth/register",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${completed.sessionToken}` },
      body: JSON.stringify({ name: `Paymap Stress ${runId} M${String(account.index + 1)}` }),
    },
    0,
  );
  return { sessionToken: completed.sessionToken, merchantId: registered.merchantId };
}

async function prepareMerchant(
  apiUrl: string,
  account: PrivateAccount,
  runId: string,
  deployment: ReturnType<typeof loadDeployment>,
): Promise<MerchantContext> {
  const auth = await authenticateMerchant(apiUrl, account, runId);
  const product = await apiRequest<{ id: string }>(
    apiUrl,
    "/products",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.sessionToken}` },
      body: JSON.stringify({
        name: `Stress plan ${runId} M${String(account.index + 1)}`,
        description: "Controlled Stellar testnet stress transaction",
        assetAddress: deployment.asset.contractId,
        assetDecimals: deployment.asset.decimals,
        amountType: "fixed",
        fixedAmount: CHARGE_AMOUNT,
        maxPerPeriod: CHARGE_AMOUNT,
        periodSeconds: 86_400,
        minIntervalSeconds: 0,
        maxSuccessfulCharges: 1,
        defaultDurationSeconds: 86_400,
      }),
    },
  );
  return { account, ...auth, productId: product.id };
}

async function createCheckoutSession(
  apiUrl: string,
  merchant: MerchantContext,
  payerAddress: string,
  runId: string,
  index: number,
): Promise<string> {
  const session = await apiRequest<{ id: string }>(apiUrl, "/checkout-sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${merchant.sessionToken}`,
      "Idempotency-Key": `${runId}-checkout-${String(index + 1)}`,
    },
    body: JSON.stringify({
      productId: merchant.productId,
      clientReference: `${runId}-flow-${String(index + 1)}`,
      payerAddress,
    }),
  });
  return session.id;
}

async function createMandate(
  payer: PrivateAccount,
  merchant: PrivateAccount,
  deployment: ReturnType<typeof loadDeployment>,
): Promise<{ mandateId: string; transactionHash: string }> {
  const payerSigner = keypairSigner(payer.keypair.secret());
  const client = createMandateRegistryClient(deployment, {
    publicKey: payerSigner.publicKey,
    signTransaction: payerSigner.signTransaction,
  });
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const amount = decimalToBaseUnits(CHARGE_AMOUNT, deployment.asset.decimals);
  const input: MandateInput = {
    payer: payer.address,
    merchant: merchant.address,
    asset: deployment.asset.contractId,
    amountRule: { kind: "fixed", amount },
    maxPerPeriod: amount,
    periodSeconds: 86_400n,
    minIntervalSeconds: 0n,
    startAt: now,
    expiresAt: now + 86_400n,
    maxSuccessfulCharges: 1,
    metadataHash: hex32(),
    clientNonce: hex32(),
  };
  const assembled = await buildCreateMandate(client, input);
  const sent = await submitAsInvoker(assembled);
  const transactionHash = sent.sendTransactionResponse?.hash;
  if (!transactionHash) throw new Error(`create_mandate for ${payer.address} returned no hash`);
  return {
    mandateId: idToHex(sent.result.unwrap()),
    transactionHash: normalizeHash(transactionHash),
  };
}

async function linkMandate(
  apiUrl: string,
  checkoutSessionId: string,
  mandateId: string,
  payerAddress: string,
): Promise<void> {
  await apiRequest(apiUrl, `/checkout-sessions/${checkoutSessionId}/mandate`, {
    method: "POST",
    body: JSON.stringify({ mandateId, payerAddress }),
  });
}

async function scheduleAuthorizedCharge(
  apiUrl: string,
  merchant: MerchantContext,
  mandateId: string,
  runId: string,
  index: number,
): Promise<string> {
  const challenge = await apiRequest<{
    id: string;
    unsignedAuthorizationEntryXdr: string;
    merchantAddress: string;
    contractId: string;
    networkPassphrase: string;
  }>(
    apiUrl,
    `/mandates/${mandateId}/charge-authorizations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${merchant.sessionToken}`,
        "Idempotency-Key": `${runId}-charge-${String(index + 1)}`,
      },
      body: JSON.stringify({ amount: CHARGE_AMOUNT, invoiceHash: hex32() }),
    },
  );
  const signedAuthorizationEntryXdr = await signChargeAuthorization(
    challenge.unsignedAuthorizationEntryXdr,
    {
      merchantAddress: challenge.merchantAddress,
      contractId: challenge.contractId,
      networkPassphrase: challenge.networkPassphrase,
    },
    async (preimage) => ({
      signedAuthEntry: merchant.account.keypair
        .sign(hash(Buffer.from(preimage, "base64")))
        .toString("base64"),
    }),
  );
  const charge = await apiRequest<{ id: string }>(
    apiUrl,
    `/charge-authorizations/${challenge.id}/complete`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${merchant.sessionToken}` },
      body: JSON.stringify({ signedAuthorizationEntryXdr }),
    },
  );
  return charge.id;
}

async function waitForCharge(
  apiUrl: string,
  merchant: MerchantContext,
  chargeRequestId: string,
  timeoutMs = 300_000,
): Promise<{ status: string; transactionHash: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    const charge = await apiRequest<{
      status: string;
      transactionHash?: string;
      failureCode?: string;
    }>(
      apiUrl,
      `/charges/${chargeRequestId}`,
      { headers: { Authorization: `Bearer ${merchant.sessionToken}` } },
      3,
    );
    lastStatus = charge.status;
    if (charge.status === "succeeded" && charge.transactionHash) {
      return {
        status: charge.status,
        transactionHash: normalizeHash(charge.transactionHash),
      };
    }
    if (TERMINAL_CHARGE_STATUSES.has(charge.status)) {
      throw new Error(
        `charge ${chargeRequestId} ended ${charge.status}: ${charge.failureCode ?? "unknown"}`,
      );
    }
    await sleep(2_000);
  }
  throw new Error(`charge ${chargeRequestId} timed out in status ${lastStatus}`);
}

async function verifyHorizonTransaction(transactionHash: string): Promise<void> {
  const transaction = await fetchJson<{ successful?: boolean }>(
    `${HORIZON_URL}/transactions/${transactionHash}`,
    {},
    { retries: 5, retryStatuses: [404, 429, 500, 502, 503, 504] },
  );
  if (transaction.successful !== true) {
    throw new Error(`transaction ${transactionHash} is not successful in Horizon`);
  }
}

function recordTransaction(
  transactions: TransactionEvidence[],
  hashValue: string,
  phase: string,
  sourceAddress: string,
): void {
  transactions.push({ hash: normalizeHash(hashValue), phase, sourceAddress });
}

async function main(): Promise<void> {
  if (process.env["STRESS_TESTNET"] !== "1") {
    throw new Error("Refusing to submit transactions without STRESS_TESTNET=1.");
  }
  const apiUrl = safeApiUrl();
  const deployment = loadDeployment(NETWORK);
  const startedAt = new Date();
  const runId = `stress-${startedAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const configDir = mkdtempSync(join(tmpdir(), "paymap-stress-"));
  const transactions: TransactionEvidence[] = [];

  try {
    log(`run ${runId}; expected transactions=${String(EXPECTED_TRANSACTION_COUNT)}`);
    await fetchOk(`${apiUrl.replace(/\/v1$/, "")}/readyz`, 6);
    await latestLedger(deployment.rpcUrl);
    await fetchJson(`${HORIZON_URL}/`, {}, { retries: 3 });
    log("live API, RPC, and Horizon ready");

    const payers: PrivateAccount[] = [];
    const merchantAccounts: PrivateAccount[] = [];
    for (let index = 0; index < PAYER_COUNT; index += 1) {
      const account = await createFreshAccount("payer", index, configDir, runId, deployment);
      payers.push(account);
      recordTransaction(transactions, account.fundingTransactionHash, "friendbot_funding", account.address);
      recordTransaction(transactions, account.trustlineTransactionHash, "asset_trustline", account.address);
    }
    for (let index = 0; index < MERCHANT_COUNT; index += 1) {
      const account = await createFreshAccount("merchant", index, configDir, runId, deployment);
      merchantAccounts.push(account);
      recordTransaction(transactions, account.fundingTransactionHash, "friendbot_funding", account.address);
      recordTransaction(transactions, account.trustlineTransactionHash, "asset_trustline", account.address);
    }

    const merchants: MerchantContext[] = [];
    for (const account of merchantAccounts) {
      merchants.push(await prepareMerchant(apiUrl, account, runId, deployment));
    }
    log("5 wallet-authenticated merchant profiles and products ready");

    const expirationLedger = (await latestLedger(deployment.rpcUrl)) + 200_000;
    const issuerAddress = deployment.asset.issuer;
    const pendingCharges: Array<{
      index: number;
      payer: PrivateAccount;
      merchant: MerchantContext;
      mandateId: string;
      chargeRequestId: string;
    }> = [];

    for (let index = 0; index < payers.length; index += 1) {
      const payer = payers[index];
      const merchant = merchants[index % merchants.length];
      if (!payer || !merchant) throw new Error(`missing flow account at index ${String(index)}`);

      const assetFundingTransactionHash = await runCliTransaction(issuerAddress, [
        "tx",
        "new",
        "payment",
        "--source-account",
        ISSUER_IDENTITY,
        "--destination",
        payer.address,
        "--asset",
        `${deployment.asset.code}:${deployment.asset.issuer}`,
        "--amount",
        PAYER_ASSET_FUNDING_BASE_UNITS.toString(),
        "--network",
        NETWORK,
      ]);
      recordTransaction(transactions, assetFundingTransactionHash, "asset_funding", issuerAddress);

      const allowanceTransactionHash = await runCliTransaction(payer.address, [
        "contract",
        "invoke",
        "--id",
        deployment.asset.contractId,
        "--source-account",
        payer.identity,
        "--network",
        NETWORK,
        "--config-dir",
        configDir,
        "--",
        "approve",
        "--from",
        payer.address,
        "--spender",
        deployment.contractId,
        "--amount",
        decimalToBaseUnits(CHARGE_AMOUNT, deployment.asset.decimals).toString(),
        "--expiration_ledger",
        String(expirationLedger),
      ]);
      recordTransaction(transactions, allowanceTransactionHash, "asset_allowance", payer.address);

      const checkoutSessionId = await createCheckoutSession(
        apiUrl,
        merchant,
        payer.address,
        runId,
        index,
      );
      const mandate = await createMandate(payer, merchant.account, deployment);
      recordTransaction(transactions, mandate.transactionHash, "create_mandate", payer.address);
      await linkMandate(apiUrl, checkoutSessionId, mandate.mandateId, payer.address);
      const chargeRequestId = await scheduleAuthorizedCharge(
        apiUrl,
        merchant,
        mandate.mandateId,
        runId,
        index,
      );
      pendingCharges.push({
        index,
        payer,
        merchant,
        mandateId: mandate.mandateId,
        chargeRequestId,
      });
      log(`flow ${String(index + 1)}/${String(PAYER_COUNT)} queued: mandate ${mandate.mandateId}`);
    }

    log("all merchant-authorized charges queued; waiting for production relayer");
    for (const pending of pendingCharges) {
      const charge = await waitForCharge(
        apiUrl,
        pending.merchant,
        pending.chargeRequestId,
      );
      recordTransaction(
        transactions,
        charge.transactionHash,
        "relayed_charge",
        pending.merchant.account.address,
      );
      const payerSigner = keypairSigner(pending.payer.keypair.secret());
      const client = createMandateRegistryClient(deployment, {
        publicKey: payerSigner.publicKey,
        signTransaction: payerSigner.signTransaction,
      });
      const mandate = await getMandate(client, pending.mandateId);
      if (mandate.successfulCharges !== 1 || mandate.totalCollected !== 1_000_000n) {
        throw new Error(`mandate ${pending.mandateId} has unexpected post-charge accounting`);
      }
      log(`flow ${String(pending.index + 1)} succeeded: ${charge.transactionHash}`);
    }

    const uniqueHashes = new Set(transactions.map((transaction) => transaction.hash));
    if (
      transactions.length !== EXPECTED_TRANSACTION_COUNT ||
      uniqueHashes.size !== EXPECTED_TRANSACTION_COUNT
    ) {
      throw new Error(
        `expected ${String(EXPECTED_TRANSACTION_COUNT)} unique transactions, got ${String(transactions.length)} records / ${String(uniqueHashes.size)} unique`,
      );
    }
    log(`verifying ${String(uniqueHashes.size)} transaction hashes through Horizon`);
    for (const transactionHash of uniqueHashes) {
      await verifyHorizonTransaction(transactionHash);
    }

    const evidenceDir = join(
      process.env["INIT_CWD"] ?? process.cwd(),
      "docs",
      "level-5",
      "evidence",
    );
    mkdirSync(evidenceDir, { recursive: true });
    const reportPath = join(evidenceDir, `testnet-${runId}.csv`);
    writeFileSync(reportPath, transactionEvidenceCsv(runId, startedAt.toISOString(), transactions), {
      encoding: "utf8",
      mode: 0o644,
    });
    log(
      `complete: ${String(transactions.length)} transactions, ${String(payers.length + merchantAccounts.length)} addresses`,
    );
    log(`evidence: ${reportPath}`);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`[${SCOPE}] failed:`, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
