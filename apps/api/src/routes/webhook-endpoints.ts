/**
 * Merchant webhook endpoint configuration + delivery test (CLAUDE.md §12,
 * §16; this phase's decisions #6 "webhook secrets are per-merchant,
 * encrypted at rest" and #8 "SSRF matters").
 *
 * `POST /v1/webhook-endpoints/test` (Phase 8) only ever queued a
 * `webhook.test` `WebhookDelivery` row — it never persisted a real
 * `webhookUrl`/`webhookSecret` onto the `Merchant` row, and nothing did:
 * there was no endpoint to configure one. `POST /v1/webhook-endpoints`
 * (this phase) is that endpoint — it is what makes real delivery (Phase
 * 12a's `apps/relayer` delivery worker) possible at all.
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assertSafeWebhookUrl, encryptWebhookSecret, generateWebhookSecret, UnsafeWebhookUrlError, type HostResolver } from "@paymap/shared";
import { badRequest } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { RegisterWebhookEndpointSchema, WebhookEndpointTestSchema, type WebhookEventEnvelope } from "../schemas/webhooks.js";
import { randomHexId32 } from "../utils/ids.js";
import { WebhookDeliveryStatus, type WebhookDelivery } from "../db.js";

const WEBHOOK_DELIVERY_STATUS_VALUES: readonly string[] = Object.values(WebhookDeliveryStatus);

const ListWebhookDeliveriesQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

function toWebhookDeliveryResponse(delivery: WebhookDelivery) {
  return {
    id: delivery.id,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    nextAttemptAt: delivery.nextAttemptAt?.toISOString() ?? undefined,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
  };
}

async function guardedWebhookUrl(app: { allowInsecureWebhookHttp: boolean; resolveWebhookHost: HostResolver | undefined }, url: string): Promise<void> {
  try {
    await assertSafeWebhookUrl(url, { allowInsecureHttp: app.allowInsecureWebhookHttp, ...(app.resolveWebhookHost ? { resolveHost: app.resolveWebhookHost } : {}) });
  } catch (error) {
    if (error instanceof UnsafeWebhookUrlError) {
      throw badRequest(error.code, error.message);
    }
    throw error;
  }
}

const webhookEndpointsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Registers (or rotates, on repeat calls) the merchant's real delivery
   * endpoint. The new secret is shown exactly once, here — only its
   * encrypted form (`encryptWebhookSecret`, `WEBHOOK_ENCRYPTION_KEY`) is
   * ever persisted, mirroring `auth/api-key.ts`'s "raw form never stored"
   * discipline for API keys.
   */
  app.post("/webhook-endpoints", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const input = RegisterWebhookEndpointSchema.parse(request.body);

    await guardedWebhookUrl(app, input.url);

    const rawSecret = generateWebhookSecret();
    const encryptedSecret = encryptWebhookSecret(rawSecret, app.webhookEncryptionKey);

    await app.prisma.merchant.update({
      where: { id: merchant.id },
      data: { webhookUrl: input.url, webhookSecret: encryptedSecret },
    });

    reply.status(201).send({
      webhookUrl: input.url,
      // Shown once, here, and never again — not retrievable through any other endpoint (mirrors POST /v1/merchants and the API-key rotation endpoint).
      webhookSecret: rawSecret,
    });
  });

  /** Non-secret status read — never returns the secret (encrypted or otherwise). */
  app.get("/webhook-endpoints", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    reply.status(200).send({
      configured: merchant.webhookUrl !== null && merchant.webhookSecret !== null,
      webhookUrl: merchant.webhookUrl ?? undefined,
    });
  });

  /**
   * Merchant-scoped delivery history — backs the dashboard's "Webhooks"
   * status/history view (PLAN.md §16.3, this phase's decision #7). Only
   * `status`/`attemptCount`/timestamps are returned, never `payload` (kept
   * minimal and never a place a merchant's own customer data could leak
   * into this UI unexpectedly) and never anything secret (the encrypted
   * `webhookSecret` lives only on `Merchant`, never on `WebhookDelivery`).
   */
  app.get("/webhook-deliveries", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const query = ListWebhookDeliveriesQuerySchema.parse(request.query);

    let statusIn: string[] | undefined;
    if (query.status !== undefined) {
      statusIn = query.status.split(",").map((s) => s.trim());
      for (const value of statusIn) {
        if (!WEBHOOK_DELIVERY_STATUS_VALUES.includes(value)) {
          throw badRequest("INVALID_STATUS_FILTER", `"${value}" is not a valid webhook delivery status.`);
        }
      }
    }

    const deliveries = await app.prisma.webhookDelivery.findMany({
      where: { merchantId: merchant.id, ...(statusIn ? { status: { in: statusIn as WebhookDelivery["status"][] } } : {}) },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });

    reply.status(200).send({ data: deliveries.map(toWebhookDeliveryResponse) });
  });

  /**
   * Validates a candidate URL and queues a sample `webhook.test` delivery
   * against it — a merchant can use this to test a URL before (or without)
   * registering it as their real endpoint above. The delivery worker
   * (`apps/relayer`) drains this the same as any other `WebhookDelivery`
   * row, so it *is* actually POSTed and signed, but signed with the
   * merchant's currently-registered secret (or, if none is registered yet,
   * this call still queues the row — delivery will simply have no secret
   * to sign with until one is registered, and the worker skips such rows;
   * see `apps/relayer/src/webhook-delivery.ts`).
   */
  app.post("/webhook-endpoints/test", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const input = WebhookEndpointTestSchema.parse(request.body);

    await guardedWebhookUrl(app, input.url);

    const eventId = randomHexId32();
    // `WebhookDelivery.payload` stores only the event *data* — the
    // delivery worker builds the full `WebhookEventEnvelope` (eventId,
    // eventType, createdAt, signatureVersion) fresh at send time from the
    // row's own columns, so there is exactly one place that assembles the
    // wire envelope (CLAUDE.md §20), not two slightly-different copies.
    const data: WebhookEventEnvelope<{ url: string; message: string }>["data"] = { url: input.url, message: "This is a test event from Paymap." };

    const delivery = await app.prisma.webhookDelivery.create({
      data: {
        merchantId: merchant.id,
        eventId,
        eventType: "webhook.test",
        payload: data,
        status: "pending",
      },
    });

    reply.status(202).send({
      id: delivery.id,
      eventId: delivery.eventId,
      status: delivery.status,
      createdAt: delivery.createdAt.toISOString(),
    });
  });
};

export default webhookEndpointsRoutes;
