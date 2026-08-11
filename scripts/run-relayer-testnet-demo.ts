#!/usr/bin/env tsx
/**
 * Phase 9's required real-testnet proof plus Phase 15's scripted protection
 * scenes: one successful collection, one over-limit rejection, payer
 * revocation, then one otherwise-valid post-revocation rejection.
 *
 * The first scheduled `ChargeRequest` is
 * executed end-to-end through the ACTUAL relayer pipeline
 * (`@paymap/relayer`'s `processChargeRequest`, `createSorobanChainGateway`)
 * — not a hand-rolled one-off submission. This is the same trust model
 * Phase 7's `create-demo-mandate.ts` proved directly against the SDK; this
 * script proves the *pipeline built on top of it* behaves identically
 * against the real network: claim -> fresh on-chain read -> build+simulate
 * -> verify -> submit -> poll to final -> write `Payment` -> `succeeded`.
 *
 * Uses the same three named CLI identities as Phase 7
 * (`paymap-merchant`/`paymap-payer`/`paymap-relayer`) and a real Postgres
 * (the `public` schema — a real row set, not a test fixture) to host the
 * `Merchant`/`Product`/`CheckoutSession`/`ChargeRequest` rows the pipeline
 * reads.
 *
 * Known, documented limitation this script deliberately works around (see
 * `apps/relayer/src/chain-gateway.ts`'s module doc): there is no production
 * mechanism yet for a merchant's charge-authorization signature to reach the
 * relayer without it custodying a key. This script supplies the demo
 * merchant's own keypair directly to `resolveMerchantSigner`, exactly
 * mirroring Phase 7's proven pattern — acceptable for this demo/proof run,
 * not a production design.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadDeployment } from "@paymap/contract-client";
import { decimalToBaseUnits } from "@paymap/shared";
import { keypairSigner } from "@paymap/stellar";
import { createPrismaClient } from "@paymap/relayer/dist/db.js";
import { createSorobanChainGateway } from "@paymap/relayer/dist/chain-gateway.js";
import { processChargeRequest } from "@paymap/relayer/dist/pipeline.js";
import {
  buildCreateMandate,
  buildRevokeMandate,
  createMandateRegistryClient,
  getMandate,
  idToHex,
  type MandateInput,
} from "@paymap/contract-client";
import { submitAsInvoker } from "@paymap/stellar";
import {
  ensureAssetBalance,
  ensureFundedIdentity,
  ensureTrustline,
  log,
  stellar,
} from "./lib/testnet-setup.js";

const SCOPE = "run-relayer-testnet-demo";
const NETWORK = "testnet";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const ASSET_ISSUER = "paymap-asset-issuer";
const MERCHANT = "paymap-merchant";
const PAYER = "paymap-payer";
const RELAYER = "paymap-relayer";

const ASSET_DECIMALS = 7;
const SUCCESS_AMOUNT_DECIMAL = "14.50";
const MAX_PER_CHARGE_DECIMAL = "20.00";
const OVER_LIMIT_AMOUNT_DECIMAL = "25.00";
const MAX_SUCCESSFUL_CHARGES = 2;
const ALLOWANCE_BUFFER_DECIMAL = "1.00";
const PERIOD_SECONDS = 3600n;
const MANDATE_LIFETIME_SECONDS = 30n * 24n * 60n * 60n;

function hex32(): string {
  return randomBytes(32).toString("hex");
}

function stellarInvoke(args: string[]): void {
  stellar(args);
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
    throw new Error(`could not read latest ledger sequence: ${JSON.stringify(body)}`);
  }
  return sequence;
}

async function main(): Promise<void> {
  const deployment = loadDeployment(NETWORK);
  log(SCOPE, `mandate-registry: ${deployment.contractId}`);

  const merchantKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, MERCHANT);
  const payerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, PAYER);
  const relayerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, RELAYER);
  log(
    SCOPE,
    `payer=${payerKey} merchant=${merchantKey} relayer=${relayerKey} (relayer holds no spending authority)`,
  );

  await ensureTrustline(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    MERCHANT,
    merchantKey,
    deployment.asset.code,
    deployment.asset.issuer,
  );
  await ensureTrustline(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    PAYER,
    payerKey,
    deployment.asset.code,
    deployment.asset.issuer,
  );

  const successAmountBaseUnits = decimalToBaseUnits(SUCCESS_AMOUNT_DECIMAL, ASSET_DECIMALS);
  const maxPerChargeBaseUnits = decimalToBaseUnits(MAX_PER_CHARGE_DECIMAL, ASSET_DECIMALS);
  const overLimitAmountBaseUnits = decimalToBaseUnits(OVER_LIMIT_AMOUNT_DECIMAL, ASSET_DECIMALS);
  const theoreticalMaxBaseUnits = maxPerChargeBaseUnits * BigInt(MAX_SUCCESSFUL_CHARGES);
  const allowanceBaseUnits =
    theoreticalMaxBaseUnits + decimalToBaseUnits(ALLOWANCE_BUFFER_DECIMAL, ASSET_DECIMALS);

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

  const payerSecret = execFileSync("stellar", ["keys", "secret", PAYER], {
    encoding: "utf-8",
  }).trim();
  const merchantSecret = execFileSync("stellar", ["keys", "secret", MERCHANT], {
    encoding: "utf-8",
  }).trim();
  const relayerSecret = execFileSync("stellar", ["keys", "secret", RELAYER], {
    encoding: "utf-8",
  }).trim();
  const payerSigner = keypairSigner(payerSecret);
  const merchantSigner = keypairSigner(merchantSecret);
  const relayerSigner = keypairSigner(relayerSecret);

  const expirationLedger = (await fetchLatestLedgerSeq(deployment.rpcUrl)) + 200_000;
  log(
    SCOPE,
    `payer approving ${allowanceBaseUnits.toString()} base units (bounded, never unlimited) to mandate contract`,
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
    amountRule: { kind: "variable", maxPerCharge: maxPerChargeBaseUnits },
    maxPerPeriod: theoreticalMaxBaseUnits,
    periodSeconds: PERIOD_SECONDS,
    minIntervalSeconds: 0n,
    startAt: nowSeconds,
    expiresAt: nowSeconds + MANDATE_LIFETIME_SECONDS,
    maxSuccessfulCharges: MAX_SUCCESSFUL_CHARGES,
    metadataHash: hex32(),
    clientNonce: hex32(),
  };

  log(
    SCOPE,
    "creating mandate (payer signs and submits directly — unrelated to the relayer pipeline under test)",
  );
  const payerClient = createMandateRegistryClient(deployment, {
    publicKey: payerSigner.publicKey,
    signTransaction: payerSigner.signTransaction,
  });
  const createTx = await buildCreateMandate(payerClient, mandateInput);
  const createSent = await submitAsInvoker(createTx);
  const mandateId = idToHex(createSent.result.unwrap());
  log(
    SCOPE,
    `mandate id: ${mandateId} (create_mandate tx: ${String(createSent.sendTransactionResponse?.hash)})`,
  );

  const mandateAfterCreate = await getMandate(payerClient, mandateId);
  log(SCOPE, `mandate status after create: ${mandateAfterCreate.status}`);

  // --- From here on, everything goes through the real Phase 9 pipeline. ---
  const prisma = createPrismaClient();
  try {
    const merchant = await prisma.merchant.create({
      data: { name: "Testnet Demo Merchant (Phase 9)", walletAddress: merchantKey },
    });
    const product = await prisma.product.create({
      data: {
        merchantId: merchant.id,
        name: "Phase 9 relayer demo product",
        assetAddress: deployment.asset.contractId,
        assetDecimals: ASSET_DECIMALS,
        amountType: "variable",
        maxPerCharge: maxPerChargeBaseUnits.toString(),
        maxPerPeriod: theoreticalMaxBaseUnits.toString(),
        periodSeconds: Number(PERIOD_SECONDS),
        minIntervalSeconds: 0,
        maxSuccessfulCharges: MAX_SUCCESSFUL_CHARGES,
        defaultDurationSeconds: Number(MANDATE_LIFETIME_SECONDS),
      },
    });
    await prisma.checkoutSession.create({
      data: {
        merchantId: merchant.id,
        productId: product.id,
        mandateId,
        expiresAt: new Date(Date.now() + 3_600_000),
        status: "completed",
      },
    });
    const chargeRequest = await prisma.chargeRequest.create({
      data: {
        merchantId: merchant.id,
        mandateId,
        chargeId: hex32(),
        amount: successAmountBaseUnits.toString(),
        invoiceHash: hex32(),
        scheduledFor: new Date(),
      },
    });
    log(SCOPE, `ChargeRequest ${chargeRequest.id} scheduled (chargeId=${chargeRequest.chargeId})`);

    const gateway = createSorobanChainGateway({
      deployment,
      relayerSigner,
      resolveMerchantSigner: () => merchantSigner, // demo-only — see module doc.
    });

    log(
      SCOPE,
      "running the real relayer pipeline (processChargeRequest): claim -> fresh read -> build+simulate -> verify -> submit -> poll to final -> reconcile",
    );
    const outcome = await processChargeRequest(
      {
        prisma,
        gateway,
        now: () => new Date(),
        logger: (level, event, fields) =>
          log(SCOPE, `[${level}] ${event} ${JSON.stringify(fields)}`),
      },
      chargeRequest.id,
    );

    console.log("\n=== Phase 9 relayer testnet proof — result ===");
    console.log(JSON.stringify(outcome, null, 2));

    if (outcome.kind !== "succeeded") {
      throw new Error(`expected the pipeline to succeed, got: ${JSON.stringify(outcome)}`);
    }

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { paymentId: outcome.paymentId },
    });
    console.log(`payment.transactionHash: ${payment.transactionHash}`);
    console.log(`payment.ledger: ${payment.ledger.toString()}`);
    console.log(`mandate id: ${mandateId}`);

    log(SCOPE, "scene 2/4: requesting an over-limit charge — contract must block it");
    const overLimitRequest = await prisma.chargeRequest.create({
      data: {
        merchantId: merchant.id,
        mandateId,
        chargeId: hex32(),
        amount: overLimitAmountBaseUnits.toString(),
        invoiceHash: hex32(),
        scheduledFor: new Date(),
      },
    });
    const overLimitOutcome = await processChargeRequest(
      {
        prisma,
        gateway,
        now: () => new Date(),
        logger: (level, event, fields) =>
          log(SCOPE, `[${level}] ${event} ${JSON.stringify(fields)}`),
      },
      overLimitRequest.id,
    );
    if (
      overLimitOutcome.kind !== "permanently_failed" ||
      overLimitOutcome.reason !== "AmountExceedsChargeLimit"
    ) {
      throw new Error(
        `expected AmountExceedsChargeLimit, got: ${JSON.stringify(overLimitOutcome)}`,
      );
    }

    log(SCOPE, "scene 3/4: revoking the mandate — payer signs, merchant approval not required");
    const revokeTx = await buildRevokeMandate(payerClient, mandateId);
    const revokeSent = await submitAsInvoker(revokeTx);
    const revoked = await getMandate(payerClient, mandateId);
    if (revoked.status !== "Revoked") {
      throw new Error(`expected Revoked mandate status, got ${revoked.status}`);
    }

    log(SCOPE, "scene 4/4: retrying a valid amount after revocation — contract must block it");
    const postRevokeRequest = await prisma.chargeRequest.create({
      data: {
        merchantId: merchant.id,
        mandateId,
        chargeId: hex32(),
        amount: successAmountBaseUnits.toString(),
        invoiceHash: hex32(),
        scheduledFor: new Date(),
      },
    });
    const postRevokeOutcome = await processChargeRequest(
      {
        prisma,
        gateway,
        now: () => new Date(),
        logger: (level, event, fields) =>
          log(SCOPE, `[${level}] ${event} ${JSON.stringify(fields)}`),
      },
      postRevokeRequest.id,
    );
    if (
      postRevokeOutcome.kind !== "permanently_failed" ||
      postRevokeOutcome.reason !== "MandateRevoked"
    ) {
      throw new Error(`expected MandateRevoked, got: ${JSON.stringify(postRevokeOutcome)}`);
    }

    console.log("\n=== Phase 15 protection scenes — PASS ===");
    console.log(`success: ${outcome.txHash}`);
    console.log(`over-limit: ${overLimitOutcome.reason}`);
    console.log(`revoke: ${String(revokeSent.sendTransactionResponse?.hash)}`);
    console.log(`post-revoke: ${postRevokeOutcome.reason}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[${SCOPE}] failed:`, error);
  process.exitCode = 1;
});
