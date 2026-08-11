#!/usr/bin/env tsx
/**
 * Phase 12c's required real-testnet proof: cause a real on-chain
 * `mandate_created` + `mandate_paused` lifecycle event pair, run the ACTUAL
 * indexer tick (`@paymap/relayer`'s `runIndexerTick`,
 * `createSorobanChainEventsGateway`) against real Soroban RPC, and confirm
 * both are indexed into `MandateIndex` and enqueue their corresponding
 * `WebhookDelivery` rows (`mandate.active`, `mandate.paused`).
 *
 * Mirrors `run-relayer-testnet-demo.ts`'s established pattern: reuse the
 * named CLI identities from Phase 7, a real Postgres (`public` schema, same
 * convention as that script — not a throwaway test fixture), and deep-import
 * `@paymap/relayer`'s built output for the actual production code under
 * test (never a hand-rolled reimplementation).
 *
 * No token allowance/trustline setup needed here (unlike
 * `create-demo-mandate.ts`) — `create_mandate`/`pause_mandate` never move
 * tokens, so this script only needs the payer/merchant identities funded
 * with XLM for fees.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  buildCreateMandate,
  buildPauseMandate,
  createMandateRegistryClient,
  getMandate,
  idToHex,
  loadDeployment,
  type MandateInput,
} from "@paymap/contract-client";
import { keypairSigner, submitAsInvoker } from "@paymap/stellar";
import { createPrismaClient } from "@paymap/relayer/dist/db.js";
import { createSorobanChainGateway } from "@paymap/relayer/dist/chain-gateway.js";
import { createSorobanChainEventsGateway } from "@paymap/relayer/dist/indexer/chain-events-gateway.js";
import { runIndexerTick } from "@paymap/relayer/dist/indexer/indexer.js";
import { ensureFundedIdentity, log } from "./lib/testnet-setup.js";

const SCOPE = "verify-indexer-testnet";
const NETWORK = "testnet";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

const MERCHANT = "paymap-merchant";
const PAYER = "paymap-payer";
const RELAYER = "paymap-relayer"; // unused for signing here — only its keypair shape is needed to satisfy createSorobanChainGateway's constructor, never invoked

function hex32(): string {
  return randomBytes(32).toString("hex");
}

async function main(): Promise<void> {
  const deployment = loadDeployment(NETWORK);
  log(SCOPE, `mandate-registry: ${deployment.contractId}`);

  const merchantKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, MERCHANT);
  const payerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, PAYER);
  const relayerKey = await ensureFundedIdentity(SCOPE, NETWORK, HORIZON_URL, RELAYER);
  log(SCOPE, `payer=${payerKey} merchant=${merchantKey} relayer=${relayerKey} (relayer identity unused for signing here — no charge is submitted)`);

  const payerSecret = execFileSync("stellar", ["keys", "secret", PAYER], { encoding: "utf-8" }).trim();
  const relayerSecret = execFileSync("stellar", ["keys", "secret", RELAYER], { encoding: "utf-8" }).trim();
  const payerSigner = keypairSigner(payerSecret);
  const relayerSigner = keypairSigner(relayerSecret);

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const mandateInput: MandateInput = {
    payer: payerKey,
    merchant: merchantKey,
    asset: deployment.asset.contractId,
    amountRule: { kind: "fixed", amount: 1n },
    maxPerPeriod: 1n,
    periodSeconds: 3600n,
    minIntervalSeconds: 0n,
    startAt: nowSeconds,
    expiresAt: nowSeconds + 30n * 24n * 60n * 60n,
    maxSuccessfulCharges: 1,
    metadataHash: hex32(),
    clientNonce: hex32(),
  };

  log(SCOPE, "creating a fresh mandate on-chain (payer signs and submits) — this is what emits mandate_created");
  const payerClient = createMandateRegistryClient(deployment, { publicKey: payerSigner.publicKey, signTransaction: payerSigner.signTransaction });
  const createTx = await buildCreateMandate(payerClient, mandateInput);
  const createSent = await submitAsInvoker(createTx);
  const mandateId = idToHex(createSent.result.unwrap());
  log(SCOPE, `mandate id: ${mandateId} (create_mandate tx: ${String(createSent.sendTransactionResponse?.hash)})`);

  log(SCOPE, "pausing the same mandate (payer signs and submits) — this is what emits mandate_paused");
  const pauseTx = await buildPauseMandate(payerClient, mandateId);
  const pauseSent = await submitAsInvoker(pauseTx);
  log(SCOPE, `pause_mandate tx: ${String(pauseSent.sendTransactionResponse?.hash)}`);

  const mandateOnChain = await getMandate(payerClient, mandateId);
  log(SCOPE, `on-chain status after pause: ${mandateOnChain.status}`);
  if (mandateOnChain.status !== "Paused") {
    throw new Error(`expected on-chain status "Paused", got "${mandateOnChain.status}" — cannot proceed with a meaningful indexer proof`);
  }

  const prisma = createPrismaClient();
  try {
    const merchant = await prisma.merchant.create({ data: { name: "Testnet Demo Merchant (Phase 12c indexer proof)", walletAddress: merchantKey } });
    log(SCOPE, `created Merchant row ${merchant.id} (walletAddress=${merchantKey}) — the indexer must resolve events to exactly this merchant`);

    const eventsGateway = createSorobanChainEventsGateway({ rpcUrl: deployment.rpcUrl, contractId: deployment.contractId });
    const mandateReader = createSorobanChainGateway({
      deployment,
      relayerSigner,
      resolveMerchantSigner: () => {
        throw new Error("not used by this script — no charge is submitted");
      },
    });

    log(SCOPE, "running the REAL indexer tick (runIndexerTick) against real Soroban RPC — first run, small lookback since these events are seconds old");
    const result = await runIndexerTick({ prisma, events: eventsGateway, mandateReader, initialLookbackLedgers: 200, pageLimit: 100, logger: (level, event, fields) => log(SCOPE, `[${level}] ${event} ${JSON.stringify(fields)}`) });
    console.log("\n=== Indexer tick result ===");
    console.log(JSON.stringify(result, null, 2));

    const indexRow = await prisma.mandateIndex.findUnique({ where: { mandateId } });
    console.log("\n=== MandateIndex row observed by the indexer ===");
    console.log(JSON.stringify(indexRow, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));

    const deliveries = await prisma.webhookDelivery.findMany({ where: { merchantId: merchant.id }, orderBy: { createdAt: "asc" } });
    console.log("\n=== WebhookDelivery rows enqueued for this merchant ===");
    console.log(JSON.stringify(deliveries, null, 2));

    const eventTypes = deliveries.map((d) => d.eventType).sort();
    const ok = indexRow?.status === "Paused" && eventTypes.includes("mandate.active") && eventTypes.includes("mandate.paused");
    if (!ok) {
      throw new Error(`indexer did not produce the expected result — MandateIndex.status=${String(indexRow?.status)}, eventTypes=${JSON.stringify(eventTypes)}`);
    }
    console.log("\n=== PASS: indexer observed both real on-chain events and enqueued the correct webhooks ===");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[${SCOPE}] failed:`, error);
  process.exitCode = 1;
});
