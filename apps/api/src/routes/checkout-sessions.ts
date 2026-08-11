import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { badRequest, notFoundError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { CreateCheckoutSessionSchema } from "../schemas/checkout-sessions.js";
import { IdempotencyKeyHeaderSchema } from "../schemas/common.js";
import { computeRequestHash, runIdempotent } from "../idempotency/middleware.js";
import type { CheckoutSession } from "../db.js";

function toCheckoutSessionResponse(session: CheckoutSession) {
  return {
    id: session.id,
    merchantId: session.merchantId,
    productId: session.productId,
    clientReference: session.clientReference ?? undefined,
    payerAddress: session.payerAddress ?? undefined,
    expiresAt: session.expiresAt.toISOString(),
    status: session.status,
    mandateId: session.mandateId ?? undefined,
    createdAt: session.createdAt.toISOString(),
  };
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw badRequest("MISSING_IDEMPOTENCY_KEY", 'This endpoint requires an "Idempotency-Key" header.');
  }
  return IdempotencyKeyHeaderSchema.parse(value);
}

const checkoutSessionsRoutes: FastifyPluginAsync = async (app) => {
  app.post("/checkout-sessions", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const input = CreateCheckoutSessionSchema.parse(request.body);
    const requestHash = computeRequestHash(request.body);

    const product = await app.prisma.product.findFirst({ where: { id: input.productId, merchantId: merchant.id } });
    if (!product) {
      throw notFoundError("PRODUCT_NOT_FOUND", `No product "${input.productId}" for this merchant.`);
    }

    const now = app.now();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + product.defaultDurationSeconds * 1000);

    const outcome = await runIdempotent(app.prisma, merchant.id, idempotencyKey, requestHash, async (tx) => {
      const session = await tx.checkoutSession.create({
        data: {
          merchantId: merchant.id,
          productId: product.id,
          clientReference: input.clientReference ?? null,
          payerAddress: input.payerAddress ?? null,
          expiresAt,
        },
      });
      return { status: 201, body: toCheckoutSessionResponse(session) };
    });

    reply.status(outcome.status).header("Idempotency-Replayed", String(outcome.replayed)).send(outcome.body);
  });

  app.get("/checkout-sessions/:id", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const { id } = request.params as { id: string };
    const session = await app.prisma.checkoutSession.findFirst({ where: { id, merchantId: merchant.id } });
    if (!session) {
      throw notFoundError("CHECKOUT_SESSION_NOT_FOUND", `No checkout session "${id}" for this merchant.`);
    }
    reply.status(200).send(toCheckoutSessionResponse(session));
  });
};

export default checkoutSessionsRoutes;
