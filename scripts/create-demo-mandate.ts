#!/usr/bin/env tsx
/**
 * End-to-end proof, on real Stellar testnet, of the product's core trust
 * model (PLAN.md §9, CLAUDE.md §24): a merchant may request a recurring
 * payment, but only the user-defined Soroban mandate — not the relayer that
 * submits the transaction — authorizes amount, timing, asset, and
 * destination.
 *
 * Flow:
 *   1. Ensure payer/merchant/relayer identities are funded (XLM) and the
 *      payer holds the PUSD test asset (`deploy-testnet.ts` normally does
 *      this; repeated here so this script is runnable on its own).
 *   2. Payer approves a BOUNDED allowance (never unlimited — CLAUDE.md §2)
 *      to the mandate contract: exactly the mandate's theoretical maximum
 *      (`fixedAmount * maxSuccessfulCharges`) plus a small explicit buffer
 *      (PLAN.md §10.10), nothing more.
 *   3. Payer creates the mandate — signs and submits directly
 *      (`submitAsInvoker`).
 *   4. Merchant authorizes a charge that a *separate* relayer identity
 *      submits and pays the fee for (`submitAsRelayer`) — the relayer never
 *      holds the merchant's key and never appears in the mandate's spending
 *      authority.
 *   5. Reads the mandate back to show post-charge accounting.
 *
 * Every tx hash printed here is real and is recorded in
 * `tasks/todo.md`'s Phase 7 `## Review` entry as the gate's evidence.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  buildCharge,
  buildCreateMandate,
  createMandateRegistryClient,
  getMandate,
  getPayment,
  idToHex,
  loadDeployment,
  type MandateInput,
} from "@paymap/contract-client";
import { decimalToBaseUnits } from "@paymap/shared";
import { keypairSigner, submitAsInvoker, submitAsRelayer } from "@paymap/stellar";
import { ensureAssetBalance, ensureFundedIdentity, ensureTrustline, log } from "./lib/testnet-setup.js";

const SCOPE = "create-demo-mandate";
const NETWORK = "testnet";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const ASSET_ISSUER = "paymap-asset-issuer";
const MERCHANT = "paymap-merchant";
const PAYER = "paymap-payer";
const RELAYER = "paymap-relayer";

const ASSET_DECIMALS = 7;
const FIXED_CHARGE_AMOUNT_DECIMAL = "5.00"; // 5 PUSD per charge
const MAX_SUCCESSFUL_CHARGES = 3;
const ALLOWANCE_BUFFER_DECIMAL = "1.00"; // small explicit buffer, PLAN.md §10.10 — never unlimited
const PERIOD_SECONDS = 3600n; // 1 hour billing period, generous for a single demo charge
const MANDATE_LIFETIME_SECONDS = 30n * 24n * 60n * 60n; // 30 days

function hex32(): string {
  return randomBytes(32).toString("hex");
}

function stellarInvoke(args: string[]): void {
  execFileSync("stellar", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] });
}

async function fetchLatestLedgerSeq(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger", params: {} }),
  });
  const body = (await response.json()) as { result?: { sequence?: number } };
  const sequence = body.result?.sequence;
  if (sequence === undefined) {
    throw new Error(`could not read latest ledger sequence from RPC response: ${JSON.stringify(body)}`);
  }
  return sequence;
}

async function main(): Promise<void> {
  const deployment = loadDeployment(NETWORK);
  log(SCOPE, `mandate-registry: ${deployment.contractId}`);
  log(SCOPE, `asset (${deployment.asset.code}): ${deployment.asset.contractId}`);

  const merchantKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, MERCHANT);
  const payerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, PAYER);
  const relayerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, RELAYER);
  log(SCOPE, `payer=${payerKey} merchant=${merchantKey} relayer=${relayerKey} (relayer holds no spending authority)`);

  await ensureTrustline(SCOPE, NETWORK, HORIZON_URL, MERCHANT, merchantKey, deployment.asset.code, deployment.asset.issuer);
  await ensureTrustline(SCOPE, NETWORK, HORIZON_URL, PAYER, payerKey, deployment.asset.code, deployment.asset.issuer);

  const fixedAmountBaseUnits = decimalToBaseUnits(FIXED_CHARGE_AMOUNT_DECIMAL, ASSET_DECIMALS);
  const theoreticalMaxBaseUnits = fixedAmountBaseUnits * BigInt(MAX_SUCCESSFUL_CHARGES);
  const bufferBaseUnits = decimalToBaseUnits(ALLOWANCE_BUFFER_DECIMAL, ASSET_DECIMALS);
  const allowanceBaseUnits = theoreticalMaxBaseUnits + bufferBaseUnits;

  await ensureAssetBalance(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    ASSET_ISSUER,
    deployment.asset.issuer,
    PAYER,
    payerKey,
    deployment.asset.code,
    allowanceBaseUnits,
  );

  const payerSecret = execFileSync("stellar", ["keys", "secret", PAYER], { encoding: "utf-8" }).trim();
  const merchantSecret = execFileSync("stellar", ["keys", "secret", MERCHANT], { encoding: "utf-8" }).trim();
  const relayerSecret = execFileSync("stellar", ["keys", "secret", RELAYER], { encoding: "utf-8" }).trim();
  const payerSigner = keypairSigner(payerSecret);
  const merchantSigner = keypairSigner(merchantSecret);
  const relayerSigner = keypairSigner(relayerSecret);

  // Bounded allowance: exactly the mandate's theoretical maximum plus a
  // small explicit buffer — never unlimited (CLAUDE.md §2, PLAN.md §10.10).
  const expirationLedger = (await fetchLatestLedgerSeq(deployment.rpcUrl)) + 200_000; // ~11 days at 5s ledgers
  log(
    SCOPE,
    `payer approving ${allowanceBaseUnits.toString()} base units (${FIXED_CHARGE_AMOUNT_DECIMAL} x ${String(MAX_SUCCESSFUL_CHARGES)} + ${ALLOWANCE_BUFFER_DECIMAL} buffer) to mandate contract, until ledger ${String(expirationLedger)}`,
  );
  stellarInvoke([
    "contract",
    "invoke",
    "--id",
    deployment.asset.contractId,
    "--source",
    PAYER,
    "--network",
    NETWORK,
    "--",
    "approve",
    "--from",
    payerKey,
    "--spender",
    deployment.contractId,
    "--amount",
    allowanceBaseUnits.toString(),
    "--expiration_ledger",
    expirationLedger.toString(),
  ]);

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const mandateInput: MandateInput = {
    payer: payerKey,
    merchant: merchantKey,
    asset: deployment.asset.contractId,
    amountRule: { kind: "fixed", amount: fixedAmountBaseUnits },
    maxPerPeriod: theoreticalMaxBaseUnits,
    periodSeconds: PERIOD_SECONDS,
    minIntervalSeconds: 0n,
    startAt: nowSeconds,
    expiresAt: nowSeconds + MANDATE_LIFETIME_SECONDS,
    maxSuccessfulCharges: MAX_SUCCESSFUL_CHARGES,
    metadataHash: hex32(),
    clientNonce: hex32(),
  };

  log(SCOPE, "creating mandate (payer signs and submits)");
  const payerClient = createMandateRegistryClient(deployment, {
    publicKey: payerSigner.publicKey,
    signTransaction: payerSigner.signTransaction,
  });
  const createTx = await buildCreateMandate(payerClient, mandateInput);
  const createSent = await submitAsInvoker(createTx);
  const createTxHash = createSent.sendTransactionResponse?.hash;
  const mandateId = idToHex(createSent.result.unwrap());
  log(SCOPE, `create_mandate tx hash: ${String(createTxHash)}`);
  log(SCOPE, `mandate id: ${mandateId}`);

  const mandateAfterCreate = await getMandate(payerClient, mandateId);
  log(SCOPE, `mandate status after create: ${mandateAfterCreate.status}`);

  log(SCOPE, "charging mandate (merchant authorizes, relayer submits)");
  const relayerClient = createMandateRegistryClient(deployment, {
    publicKey: relayerSigner.publicKey,
    signTransaction: relayerSigner.signTransaction,
  });
  const chargeId = hex32();
  const invoiceHash = hex32();
  const chargeTx = await buildCharge(relayerClient, {
    mandateId,
    chargeId,
    amount: fixedAmountBaseUnits,
    invoiceHash,
  });
  const chargeSent = await submitAsRelayer(chargeTx, merchantSigner);
  const chargeTxHash = chargeSent.sendTransactionResponse?.hash;
  const receiptGenerated = chargeSent.result.unwrap();
  const paymentId = idToHex(receiptGenerated.payment_id);
  log(SCOPE, `charge tx hash: ${String(chargeTxHash)}`);
  log(SCOPE, `payment id: ${paymentId}`);

  const receipt = await getPayment(payerClient, paymentId);
  log(SCOPE, `receipt: amount=${receipt.amount.toString()} base units, payer=${receipt.payer}, merchant=${receipt.merchant}`);

  const mandateAfterCharge = await getMandate(payerClient, mandateId);
  log(
    SCOPE,
    `mandate after charge: status=${mandateAfterCharge.status} successfulCharges=${String(mandateAfterCharge.successfulCharges)} totalCollected=${mandateAfterCharge.totalCollected.toString()} currentPeriodCollected=${mandateAfterCharge.currentPeriodCollected.toString()}`,
  );

  console.log("\n=== Demo summary (real testnet) ===");
  console.log(`mandate-registry contract: ${deployment.contractId}`);
  console.log(`asset contract (${deployment.asset.code}): ${deployment.asset.contractId}`);
  console.log(`mandate id: ${mandateId}`);
  console.log(`payment id: ${paymentId}`);
  console.log(`create_mandate tx hash: ${String(createTxHash)}`);
  console.log(`charge tx hash: ${String(chargeTxHash)}`);
  console.log(`mandate status: ${mandateAfterCharge.status}`);
  console.log(`successful charges: ${String(mandateAfterCharge.successfulCharges)}/${String(MAX_SUCCESSFUL_CHARGES)}`);
  console.log(`total collected: ${mandateAfterCharge.totalCollected.toString()} base units`);
}

main().catch((error: unknown) => {
  console.error(`[${SCOPE}] failed:`, error);
  process.exitCode = 1;
});
