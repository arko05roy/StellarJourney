/**
 * Untrusted relayer entrypoint (BullMQ worker + due-charge scheduler).
 *
 * Merchant authorization arrives as an invocation-bound signed Soroban auth
 * entry. The API validates and encrypts it; the relayer never receives a
 * merchant secret key.
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
import { ObservabilityRegistry } from "./observability.js";
import { createSafeJsonLogger } from "./secure-logger.js";
import { startMetricsServer } from "./metrics-server.js";
import { INDEXER_CURSOR_ID } from "./indexer/cursor.js";

const consoleLogger: Logger = createSafeJsonLogger("relayer", (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
});

async function main(): Promise<void> {
  const config = loadRelayerConfig();
  const prisma = createPrismaClient();
  const connection = createRedisConnection(config.redisUrl);
  const queue = createChargeQueue(connection);
  const observability = new ObservabilityRegistry();
  const metricsServer = startMetricsServer({
    port: Number(process.env["PORT"] ?? process.env["METRICS_PORT"] ?? 9464),
    observability,
    ready: async () => {
      await prisma.$queryRaw`SELECT 1`;
      if (connection.status !== "ready") throw new Error("Redis is not connected.");
      if ((await connection.ping()) !== "PONG") throw new Error("Redis is not ready.");
    },
  });
  const gateway = createSorobanChainGateway({
    deployment: config.deployment,
    relayerSigner: config.relayerSigner,
  });
  const collectOperationalMetrics = async (): Promise<void> => {
    const [waiting, active, delayed, deadLetters, stuckSubmitted, cursor, latestLedger] =
      await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getDelayedCount(),
        prisma.webhookDelivery.count({ where: { status: "dead_letter" } }),
        prisma.chargeRequest.count({
          where: {
            status: "submitted",
            updatedAt: { lte: new Date(Date.now() - 15 * 60_000) },
          },
        }),
        prisma.indexerCursor.findUnique({ where: { id: INDEXER_CURSOR_ID } }),
        gateway.getLatestLedgerSequence?.(),
      ]);
    observability.setQueueDepth(waiting + active + delayed);
    observability.setWebhookDeadLetters(deadLetters);
    observability.setStuckSubmittedCharges(stuckSubmitted);
    if (cursor && latestLedger !== undefined) {
      observability.setIndexerLagLedgers(Math.max(0, latestLedger - Number(cursor.lastLedger)));
    }
    consoleLogger("info", "observability.snapshot", {
      requestId: "metrics",
      ...observability.snapshot(),
    });
  };
  const metricsTimer = setInterval(() => {
    void collectOperationalMetrics().catch((error: unknown) => {
      consoleLogger("warn", "observability.collection_failed", {
        requestId: "metrics",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, 60_000);
  void collectOperationalMetrics();

  const worker = createChargeWorker({
    connection,
    prisma,
    gateway,
    logger: consoleLogger,
    observability,
    authorizationEncryptionKey: config.authorizationEncryptionKey,
  });
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
    observability,
  });
  const stopWebhookScheduler = startWebhookScheduler(prisma, webhookQueue);

  // Phase 12c — on-chain event indexer. Reuses `gateway` (already exposes
  // `getMandate`) as the `MandateReader` for the cold-start asset-backfill
  // case (mandate-index-sync.ts) rather than standing up a second RPC
  // client for the same read.
  const eventsGateway = createSorobanChainEventsGateway({
    rpcUrl: config.deployment.rpcUrl,
    contractId: config.deployment.contractId,
  });
  const stopIndexerScheduler = startIndexerScheduler({
    prisma,
    events: eventsGateway,
    mandateReader: gateway,
    logger: consoleLogger,
    observability,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (async () => {
        stopScheduler();
        stopWebhookScheduler();
        stopIndexerScheduler();
        clearInterval(metricsTimer);
        await new Promise<void>((resolve, reject) => {
          metricsServer.close((error) => (error ? reject(error) : resolve()));
        });
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
