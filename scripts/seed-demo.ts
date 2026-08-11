#!/usr/bin/env tsx
/**
 * Idempotent Phase 15 demo seed.
 *
 * Creates/funds named testnet merchant + consumer identities, ensures both
 * trust the deployed PUSD asset, then upserts one merchant, one consumer,
 * fixed/variable plans, and fresh checkout sessions in Postgres.
 *
 * Only public addresses and record ids are printed. Stellar secrets remain
 * in the CLI identity store; no API key or private key enters source/logs.
 */
import { loadDeployment } from "@paymap/contract-client";
import { createPrismaClient } from "@paymap/relayer/dist/db.js";
import { decimalToBaseUnits } from "@paymap/shared";
import { ensureAssetBalance, ensureFundedIdentity, ensureTrustline } from "./lib/testnet-setup.js";

const SCOPE = "seed-demo";
const NETWORK = "testnet";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const ASSET_DECIMALS = 7;
const ASSET_ISSUER_IDENTITY = "paymap-asset-issuer";
const MERCHANT_IDENTITY = "paymap-demo-merchant";
const CONSUMER_IDENTITY = "paymap-demo-consumer";

const MERCHANT_ID = "demo-cloudbox-merchant";
const FIXED_PRODUCT_ID = "demo-cloudbox-fixed";
const VARIABLE_PRODUCT_ID = "demo-cloudbox-variable";
const FIXED_SESSION_ID = "demo-fixed-checkout";
const VARIABLE_SESSION_ID = "demo-variable-checkout";

async function main(): Promise<void> {
  const deployment = loadDeployment(NETWORK);
  const merchantAddress = await ensureFundedIdentity(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    MERCHANT_IDENTITY,
  );
  const consumerAddress = await ensureFundedIdentity(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    CONSUMER_IDENTITY,
  );

  await ensureTrustline(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    MERCHANT_IDENTITY,
    merchantAddress,
    deployment.asset.code,
    deployment.asset.issuer,
  );
  await ensureTrustline(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    CONSUMER_IDENTITY,
    consumerAddress,
    deployment.asset.code,
    deployment.asset.issuer,
  );
  await ensureAssetBalance(
    SCOPE,
    NETWORK,
    HORIZON_URL,
    ASSET_ISSUER_IDENTITY,
    deployment.asset.issuer,
    CONSUMER_IDENTITY,
    consumerAddress,
    deployment.asset.code,
    decimalToBaseUnits("500", ASSET_DECIMALS),
  );

  const prisma = createPrismaClient();
  try {
    await prisma.user.upsert({
      where: { walletAddress: consumerAddress },
      create: { walletAddress: consumerAddress, email: "demo-consumer@paymap.local" },
      update: { email: "demo-consumer@paymap.local" },
    });

    await prisma.merchant.upsert({
      where: { id: MERCHANT_ID },
      create: { id: MERCHANT_ID, name: "CloudBox", walletAddress: merchantAddress },
      update: { name: "CloudBox", walletAddress: merchantAddress, status: "active" },
    });

    const fixedAmount = decimalToBaseUnits("20", ASSET_DECIMALS).toString();
    const variableCap = decimalToBaseUnits("50", ASSET_DECIMALS).toString();
    const periodSeconds = 30 * 24 * 60 * 60;
    const durationSeconds = 365 * 24 * 60 * 60;

    await prisma.product.upsert({
      where: { id: FIXED_PRODUCT_ID },
      create: {
        id: FIXED_PRODUCT_ID,
        merchantId: MERCHANT_ID,
        name: "CloudBox Pro",
        description: "20 PUSD every 30 days. Bounded on-chain; cancel anytime.",
        assetAddress: deployment.asset.contractId,
        assetDecimals: ASSET_DECIMALS,
        amountType: "fixed",
        fixedAmount,
        maxPerPeriod: fixedAmount,
        periodSeconds,
        minIntervalSeconds: 24 * 60 * 60,
        maxSuccessfulCharges: 12,
        defaultDurationSeconds: durationSeconds,
      },
      update: {
        name: "CloudBox Pro",
        description: "20 PUSD every 30 days. Bounded on-chain; cancel anytime.",
        assetAddress: deployment.asset.contractId,
        assetDecimals: ASSET_DECIMALS,
        amountType: "fixed",
        fixedAmount,
        maxPerCharge: null,
        maxPerPeriod: fixedAmount,
        periodSeconds,
        minIntervalSeconds: 24 * 60 * 60,
        maxSuccessfulCharges: 12,
        defaultDurationSeconds: durationSeconds,
        active: true,
      },
    });

    await prisma.product.upsert({
      where: { id: VARIABLE_PRODUCT_ID },
      create: {
        id: VARIABLE_PRODUCT_ID,
        merchantId: MERCHANT_ID,
        name: "CloudBox Usage",
        description: "Usage billing capped at 15 PUSD per charge and 50 PUSD per month.",
        assetAddress: deployment.asset.contractId,
        assetDecimals: ASSET_DECIMALS,
        amountType: "variable",
        maxPerCharge: decimalToBaseUnits("15", ASSET_DECIMALS).toString(),
        maxPerPeriod: variableCap,
        periodSeconds,
        minIntervalSeconds: 24 * 60 * 60,
        maxSuccessfulCharges: 0,
        defaultDurationSeconds: durationSeconds,
      },
      update: {
        name: "CloudBox Usage",
        description: "Usage billing capped at 15 PUSD per charge and 50 PUSD per month.",
        assetAddress: deployment.asset.contractId,
        assetDecimals: ASSET_DECIMALS,
        amountType: "variable",
        fixedAmount: null,
        maxPerCharge: decimalToBaseUnits("15", ASSET_DECIMALS).toString(),
        maxPerPeriod: variableCap,
        periodSeconds,
        minIntervalSeconds: 24 * 60 * 60,
        maxSuccessfulCharges: 0,
        defaultDurationSeconds: durationSeconds,
        active: true,
      },
    });

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    for (const session of [
      { id: FIXED_SESSION_ID, productId: FIXED_PRODUCT_ID },
      { id: VARIABLE_SESSION_ID, productId: VARIABLE_PRODUCT_ID },
    ]) {
      await prisma.checkoutSession.upsert({
        where: { id: session.id },
        create: {
          id: session.id,
          merchantId: MERCHANT_ID,
          productId: session.productId,
          clientReference: `phase15:${session.id}`,
          expiresAt,
        },
        update: {
          productId: session.productId,
          payerAddress: null,
          mandateId: null,
          status: "pending",
          expiresAt,
        },
      });
    }

    console.log("\nDemo seed ready");
    console.log(`merchant: ${merchantAddress}`);
    console.log(`consumer: ${consumerAddress}`);
    console.log(`asset: ${deployment.asset.code} (${deployment.asset.contractId})`);
    console.log(`fixed checkout: http://localhost:3000/checkout/${FIXED_SESSION_ID}`);
    console.log(`variable checkout: http://localhost:3000/checkout/${VARIABLE_SESSION_ID}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[${SCOPE}] failed:`, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
