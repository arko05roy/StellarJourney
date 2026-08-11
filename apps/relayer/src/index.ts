/**
 * Untrusted relayer entrypoint (BullMQ worker + due-charge scheduler).
 *
 * NOTE — a known, documented gap this phase surfaces rather than silently
 * papering over (see `chain-gateway.ts`'s module doc, `docs/threat-model.md`'s
 * "merchant charge authorization" entry, and `tasks/todo.md`'s Phase 9
 * review): `contracts/mandate-registry/src/charge.rs` requires
 * `mandate.merchant.require_auth()` on every call, and no mechanism yet
 * exists for a merchant's signature to reach this untrusted process without
 * it custodying a merchant secret key. `resolveMerchantSigner` below throws
 * loudly rather than pretending this is solved — a future phase must supply
 * the real mechanism (most likely: the merchant's own backend pre-signs the
 * auth entry at charge-request time and the API persists the signed XDR).
 */
import { createPrismaClient } from "./db.js";
import { loadRelayerConfig } from "./config.js";
import { createSorobanChainGateway } from "./chain-gateway.js";
import { createChargeWorker } from "./worker.js";
import { createChargeQueue, createRedisConnection } from "./queue.js";
import { startScheduler } from "./scheduler.js";
import type { Logger } from "./pipeline.js";
import { createWebhookDeliveryWorker } from "./webhook-worker.js";
import { createWebhookDeliveryQueue } from "./webhook-queue.js";
import { startWebhookScheduler } from "./webhook-scheduler.js";
import { createSorobanChainEventsGateway } from "./indexer/chain-events-gateway.js";
import { startIndexerScheduler } from "./indexer/scheduler.js";

const consoleLogger: Logger = (level, event, fields) => {
  const line = `[relayer] ${event} ${JSON.stringify(fields)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

async function main(): Promise<void> {
  const config = loadRelayerConfig();
  const prisma = createPrismaClient();
  const connection = createRedisConnection(config.redisUrl);
  const queue = createChargeQueue(connection);

  const gateway = createSorobanChainGateway({
    deployment: config.deployment,
    relayerSigner: config.relayerSigner,
    resolveMerchantSigner: () => {
      throw new Error(
        "No merchant-signer resolution mechanism is configured for this relayer process (documented gap — see chain-gateway.ts's module doc). " +
          "A future phase must define how a merchant's charge authorization reaches the relayer without it custodying a merchant secret key.",
      );
    },
  });

  const worker = createChargeWorker({ connection, prisma, gateway, logger: consoleLogger });
  const stopScheduler = startScheduler(prisma, queue);

  const webhookQueue = createWebhookDeliveryQueue(connection);
  const webhookWorker = createWebhookDeliveryWorker({
    connection,
    prisma,
    webhookEncryptionKey: config.webhookEncryptionKey,
    // http:// webhook URLs are never permitted in production (CLAUDE.md
    // §12/§16's SSRF decision) — `allowInsecureWebhookHttp` intentionally
    // omitted here, defaulting to false.
    logger: consoleLogger,
  });
  const stopWebhookScheduler = startWebhookScheduler(prisma, webhookQueue);

  // Phase 12c — on-chain event indexer. Reuses `gateway` (already exposes
  // `getMandate`) as the `MandateReader` for the cold-start asset-backfill
  // case (mandate-index-sync.ts) rather than standing up a second RPC
  // client for the same read.
  const eventsGateway = createSorobanChainEventsGateway({ rpcUrl: config.deployment.rpcUrl, contractId: config.deployment.contractId });
  const stopIndexerScheduler = startIndexerScheduler({ prisma, events: eventsGateway, mandateReader: gateway, logger: consoleLogger });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        stopScheduler();
        stopWebhookScheduler();
        stopIndexerScheduler();
        await worker.close();
        await webhookWorker.close();
        await queue.close();
        await webhookQueue.close();
        await prisma.$disconnect();
        process.exit(0);
      })();
    });
  }
}

void main();
