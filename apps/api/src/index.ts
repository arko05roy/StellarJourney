/**
 * Merchant REST API entrypoint (products, checkout sessions, charge
 * requests, refunds, webhooks — Phase 8). Wires the real Prisma client and
 * a real on-chain `MandateReader` (backed by `@paymap/contract-client` and
 * the committed testnet deployment registry) into `buildApp`.
 */
import { getApiEnv } from "@paymap/config";
import { loadDeployment } from "@paymap/contract-client";
import { buildApp } from "./app.js";
import { createPrismaClient } from "./db.js";
import { createChainMandateReader } from "./chain/mandate-reader.js";

async function main(): Promise<void> {
  const env = getApiEnv();
  const prisma = createPrismaClient();
  const deployment = loadDeployment(env.STELLAR_NETWORK);
  const mandateReader = createChainMandateReader(deployment);

  const app = buildApp({
    prisma,
    mandateReader,
    hashSecret: env.API_KEY_HASH_SECRET,
    merchantAuthDomain: env.MERCHANT_AUTH_DOMAIN,
    webhookEncryptionKey: env.WEBHOOK_ENCRYPTION_KEY,
    authorizationEncryptionKey: env.AUTHORIZATION_ENCRYPTION_KEY,
    chargeAuthorization: {
      contractId: deployment.contractId,
      networkPassphrase: deployment.networkPassphrase,
    },
    // `allowInsecureWebhookHttp` intentionally omitted (defaults to false) —
    // production never accepts http:// webhook URLs (CLAUDE.md §12 decision #8).
    logger: true,
  });

  const port = Number(process.env["PORT"] ?? 3001);
  await app.listen({ port, host: "0.0.0.0" });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        await app.close();
        await prisma.$disconnect();
        process.exit(0);
      })();
    });
  }
}

void main();
