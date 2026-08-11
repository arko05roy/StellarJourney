/**
 * `POST /v1/webhook-endpoints/test` — validates a candidate webhook URL and
 * queues a sample delivery. Phase 8 explicitly does not build the delivery
 * worker (Phase 12): this creates a `WebhookDelivery` row in `pending` and
 * returns immediately (202) rather than performing a live HTTP call, which
 * would also require SSRF hardening (deferred to Phase 14) this endpoint
 * doesn't yet have.
 */
import type { FastifyPluginAsync } from "fastify";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { WebhookEndpointTestSchema, type WebhookEventEnvelope } from "../schemas/webhooks.js";
import { randomHexId32 } from "../utils/ids.js";

const webhookEndpointsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/webhook-endpoints/test", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const input = WebhookEndpointTestSchema.parse(request.body);

    const eventId = randomHexId32();
    const envelope: WebhookEventEnvelope<{ url: string; message: string }> = {
      eventId,
      eventType: "webhook.test",
      createdAt: app.now().toISOString(),
      signatureVersion: "v1",
      data: { url: input.url, message: "This is a test event from Paymap." },
    };

    const delivery = await app.prisma.webhookDelivery.create({
      data: {
        merchantId: merchant.id,
        eventId,
        eventType: envelope.eventType,
        payload: envelope as unknown as object,
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
