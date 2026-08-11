/**
 * The webhook delivery worker's per-row pipeline (CLAUDE.md §12/§17, this
 * phase's decisions #1-#5, #8). Reuses `apps/api/src/webhook-state-machine.ts`'s
 * guarded transition helper verbatim (deep import to built output — the
 * same established cross-app pattern `pipeline.ts` uses for
 * `transitionChargeRequest`/`ApiError`, CLAUDE.md §20).
 *
 * Order of operations:
 *   1. Claim: guarded DB transition `pending|retry_scheduled -> delivering`.
 *      A concurrent caller that loses this race returns
 *      `skipped_not_claimable` having made zero HTTP calls — this, not
 *      BullMQ's own job locking, is what guarantees "duplicate job delivery
 *      -> exactly one POST" (mirrors `pipeline.ts`'s identical charge-side
 *      guarantee).
 *   2. Load the owning `Merchant`. If it has no `webhookUrl`/`webhookSecret`
 *      configured yet, there is nothing to deliver to and nothing that will
 *      change by retrying (retrying doesn't make a URL appear) — this is a
 *      *permanent* condition, `dead_letter` immediately. A merchant that
 *      configures a webhook endpoint later only affects *future* events,
 *      not ones enqueued before configuration — documented, not silently
 *      papered over.
 *   3. Decrypt the merchant's webhook secret (`WEBHOOK_ENCRYPTION_KEY`). A
 *      decrypt failure (wrong key, corrupted ciphertext) is likewise
 *      permanent.
 *   4. Build the wire envelope fresh from the row's own columns (the one
 *      place this happens — see `webhook.ts`'s module doc) and sign+send it
 *      (`webhook-http.ts`, which also re-runs the SSRF guard and pins the
 *      connection immediately before sending).
 *   5. Classify the outcome (`webhook-classify.ts`) and transition to
 *      `delivered`, `retry_scheduled` (with `nextAttemptAt`), or
 *      `dead_letter` accordingly, atomically with the classification.
 */
import { transitionWebhookDelivery } from "@paymap/api/dist/webhook-state-machine.js";
import { ApiError } from "@paymap/api/dist/errors.js";
import { decryptWebhookSecret, WebhookSecretCryptoError, type HostResolver } from "@paymap/shared";
import type { WebhookDeliveryStatus, PrismaClient } from "./db.js";
import { classifyWebhookDeliveryOutcome, describeWebhookDeliveryOutcome } from "./webhook-classify.js";
import { nextWebhookRetryAt } from "./webhook-retry-schedule.js";
import { sendWebhook } from "./webhook-http.js";

export type WebhookLogger = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>) => void;
const noopLogger: WebhookLogger = () => undefined;

export interface WebhookDeliveryDeps {
  prisma: PrismaClient;
  now: () => Date;
  webhookEncryptionKey: string;
  allowInsecureWebhookHttp?: boolean;
  resolveWebhookHost?: HostResolver;
  /** Test-only escape hatch — see `assertSafeWebhookUrl`'s doc. Never set outside `apps/relayer/src/test/`. */
  allowPrivateWebhookAddresses?: boolean;
  logger?: WebhookLogger;
  /** Injectable — tests supply a fake instead of making a real HTTP call. Defaults to the real `sendWebhook`. */
  send?: typeof sendWebhook;
}

export type WebhookDeliveryOutcome =
  | { kind: "skipped_not_claimable" }
  | { kind: "delivered" }
  | { kind: "retry_scheduled"; nextAttemptAt: Date; reason: string }
  | { kind: "dead_letter"; reason: string };

export async function processWebhookDelivery(deps: WebhookDeliveryDeps, webhookDeliveryId: string): Promise<WebhookDeliveryOutcome> {
  const { prisma, now } = deps;
  const log = deps.logger ?? noopLogger;
  const send = deps.send ?? sendWebhook;

  const maybeDelivery = await prisma.webhookDelivery.findUnique({ where: { id: webhookDeliveryId } });
  if (!maybeDelivery) {
    throw new Error(`WebhookDelivery "${webhookDeliveryId}" does not exist.`);
  }
  // Re-bound as a fresh `const` so its non-null type is retained inside the
  // `deadLetter` closure below (TS widens a null-checked outer binding back
  // to its full type across a nested function boundary — see pipeline.ts's
  // identical `chargeRequest` rebinding for the same reason).
  const delivery = maybeDelivery;

  const claimFrom: WebhookDeliveryStatus = delivery.status === "retry_scheduled" ? "retry_scheduled" : "pending";
  const attemptCount = delivery.attemptCount + 1;
  try {
    await transitionWebhookDelivery(prisma, webhookDeliveryId, claimFrom, "delivering", { attemptCount });
  } catch (error) {
    if (error instanceof ApiError && error.code === "InvalidStateTransition") {
      log("info", "webhook_delivery.claim_lost", { webhookDeliveryId, attemptedFrom: claimFrom });
      return { kind: "skipped_not_claimable" };
    }
    throw error;
  }
  log("info", "webhook_delivery.claimed", { webhookDeliveryId, eventId: delivery.eventId, eventType: delivery.eventType, attemptCount });

  async function deadLetter(reason: string): Promise<WebhookDeliveryOutcome> {
    await transitionWebhookDelivery(prisma, webhookDeliveryId, "delivering", "dead_letter", { nextAttemptAt: null });
    log("error", "webhook_delivery.dead_letter", { webhookDeliveryId, eventId: delivery.eventId, reason });
    return { kind: "dead_letter", reason };
  }

  const merchant = await prisma.merchant.findUnique({ where: { id: delivery.merchantId } });
  if (!merchant?.webhookUrl || !merchant.webhookSecret) {
    return deadLetter("WEBHOOK_ENDPOINT_NOT_CONFIGURED");
  }

  let secret: string;
  try {
    secret = decryptWebhookSecret(merchant.webhookSecret, deps.webhookEncryptionKey);
  } catch (error) {
    if (error instanceof WebhookSecretCryptoError) {
      return deadLetter("WEBHOOK_SECRET_DECRYPT_FAILED");
    }
    throw error;
  }

  // The wire envelope is assembled here, fresh, from the row's own columns
  // — the single point that ever constructs it (see `webhook.ts`'s module
  // doc); `WebhookDelivery.payload` stores only the event `data`.
  const envelope = {
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    createdAt: delivery.createdAt.toISOString(),
    signatureVersion: "v1" as const,
    data: delivery.payload,
  };
  const rawBody = JSON.stringify(envelope);
  const timestampSeconds = Math.floor(now().getTime() / 1000);

  const outcome = await send({
    url: merchant.webhookUrl,
    eventId: delivery.eventId,
    timestampSeconds,
    rawBody,
    secret,
    allowInsecureHttp: deps.allowInsecureWebhookHttp ?? false,
    allowPrivateAddresses: deps.allowPrivateWebhookAddresses ?? false,
    ...(deps.resolveWebhookHost ? { resolveHost: deps.resolveWebhookHost } : {}),
  });

  const responseClass = classifyWebhookDeliveryOutcome(outcome);
  const reason = describeWebhookDeliveryOutcome(outcome);

  if (responseClass === "success") {
    await transitionWebhookDelivery(prisma, webhookDeliveryId, "delivering", "delivered");
    log("info", "webhook_delivery.delivered", { webhookDeliveryId, eventId: delivery.eventId, eventType: delivery.eventType });
    return { kind: "delivered" };
  }

  if (responseClass === "permanent") {
    return deadLetter(reason);
  }

  // retryable
  const retryAt = nextWebhookRetryAt(attemptCount, now());
  if (retryAt === undefined) {
    return deadLetter(`RETRY_SCHEDULE_EXHAUSTED (last: ${reason})`);
  }
  await transitionWebhookDelivery(prisma, webhookDeliveryId, "delivering", "retry_scheduled", { nextAttemptAt: retryAt });
  log("warn", "webhook_delivery.retry_scheduled", { webhookDeliveryId, eventId: delivery.eventId, reason, nextAttemptAt: retryAt.toISOString() });
  return { kind: "retry_scheduled", nextAttemptAt: retryAt, reason };
}
