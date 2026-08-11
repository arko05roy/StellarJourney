import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { badRequest, conflictError, notFoundError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { CreateCheckoutSessionSchema, LinkMandateToCheckoutSessionSchema } from "../schemas/checkout-sessions.js";
import { IdempotencyKeyHeaderSchema } from "../schemas/common.js";
import { computeRequestHash, runIdempotent } from "../idempotency/middleware.js";
import { toProductResponse } from "./products.js";
import { CheckoutSessionStatus, type CheckoutSession } from "../db.js";
import { MandateReadError } from "../chain/mandate-reader.js";

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

  /**
   * Unauthenticated by design — the consumer's browser opening a checkout
   * link never holds (and must never be handed) the merchant's API key.
   * Only non-secret, display-purpose fields are returned: no webhook URL,
   * webhook secret, API keys, or other merchant account internals. This is
   * the read the Phase 10 checkout page (`apps/web`) loads before the payer
   * connects a wallet.
   */
  app.get("/checkout-sessions/:id/public", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await app.prisma.checkoutSession.findUnique({
      where: { id },
      include: { product: true, merchant: true },
    });
    if (!session) {
      throw notFoundError("CHECKOUT_SESSION_NOT_FOUND", `No checkout session "${id}".`);
    }
    const now = app.now();
    // A session past its own expiry is reported as `expired` here even if a
    // background job hasn't yet flipped the stored `status` column — the
    // checkout page must never let a payer proceed against a stale-but-not-
    // yet-swept session (mirrors the contract's own computed-only-expiry
    // read path, PLAN.md §10.8).
    const effectiveStatus = session.status === CheckoutSessionStatus.pending && session.expiresAt <= now ? "expired" : session.status;

    reply.status(200).send({
      id: session.id,
      status: effectiveStatus,
      expiresAt: session.expiresAt.toISOString(),
      clientReference: session.clientReference ?? undefined,
      mandateId: session.mandateId ?? undefined,
      payerAddress: session.payerAddress ?? undefined,
      merchant: { name: session.merchant.name, walletAddress: session.merchant.walletAddress },
      product: toProductResponse(session.product),
    });
  });

  /**
   * Unauthenticated by design (same reasoning as the `/public` read above).
   * The consumer checkout page calls this once it has submitted
   * `create_mandate` on-chain, to associate the resulting `mandate_id` with
   * this session so the merchant dashboard can find it. This endpoint
   * grants no authority of its own: the mandate is independently re-verified
   * on-chain (existence, and that its merchant/asset/payer match this
   * session's product and the caller's claimed `payerAddress`) before
   * anything is persisted — a forged call here can at worst point a
   * session at a real, unrelated on-chain mandate, never fabricate one or
   * move funds (CLAUDE.md §2 — the contract remains the policy authority,
   * this DB row is never trusted as proof of anything on its own).
   */
  app.post("/checkout-sessions/:id/mandate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = LinkMandateToCheckoutSessionSchema.parse(request.body);

    const session = await app.prisma.checkoutSession.findUnique({ where: { id }, include: { product: true, merchant: true } });
    if (!session) {
      throw notFoundError("CHECKOUT_SESSION_NOT_FOUND", `No checkout session "${id}".`);
    }
    if (session.mandateId !== null) {
      if (session.mandateId === input.mandateId) {
        reply.status(200).send(toCheckoutSessionResponse(session));
        return;
      }
      throw conflictError("CHECKOUT_SESSION_ALREADY_LINKED", `Checkout session "${id}" is already linked to a different mandate.`);
    }
    if (session.status !== CheckoutSessionStatus.pending || session.expiresAt <= app.now()) {
      throw conflictError("CHECKOUT_SESSION_NOT_PENDING", `Checkout session "${id}" is no longer open (status "${session.status}").`);
    }

    let mandate;
    try {
      mandate = await app.mandateReader.getMandate(input.mandateId);
    } catch (error) {
      if (error instanceof MandateReadError) {
        throw badRequest("MandateNotFound", `No on-chain mandate "${input.mandateId}" found — it must be submitted before linking.`);
      }
      throw error;
    }
    if (mandate.merchant !== session.merchant.walletAddress) {
      throw badRequest("MANDATE_MERCHANT_MISMATCH", "The mandate's merchant does not match this checkout session's merchant.");
    }
    if (mandate.asset !== session.product.assetAddress) {
      throw badRequest("MANDATE_ASSET_MISMATCH", "The mandate's asset does not match this checkout session's product.");
    }
    if (mandate.payer !== input.payerAddress) {
      throw badRequest("MANDATE_PAYER_MISMATCH", "The mandate's payer does not match the supplied payerAddress.");
    }

    const updated = await app.prisma.checkoutSession.update({
      where: { id },
      data: { mandateId: input.mandateId, payerAddress: input.payerAddress, status: CheckoutSessionStatus.completed },
    });

    // Seeds `MandateIndex` with `payerAddress` so the consumer dashboard
    // (Phase 11) can discover this mandate — before this, the only writer
    // of `MandateIndex` was the merchant-authenticated `GET /v1/mandates/:id`
    // read (`mandates.ts`), which the payer's browser never calls. This is
    // purely a discovery/enrichment cache (CLAUDE.md §2): the dashboard
    // still re-reads live on-chain state for anything it displays or acts
    // on, never trusting this row as authoritative.
    await app.prisma.mandateIndex
      .upsert({
        where: { mandateId: input.mandateId },
        create: {
          mandateId: input.mandateId,
          merchantId: session.merchantId,
          payerAddress: mandate.payer,
          merchantAddress: mandate.merchant,
          assetAddress: mandate.asset,
          status: mandate.status,
          lastIndexedAt: app.now(),
        },
        update: {
          payerAddress: mandate.payer,
          status: mandate.status,
          lastIndexedAt: app.now(),
          contractStateVersion: { increment: 1 },
        },
      })
      .catch((error: unknown) => {
        app.log.warn({ error, mandateId: input.mandateId }, "failed to seed MandateIndex cache (non-fatal)");
      });

    reply.status(200).send(toCheckoutSessionResponse(updated));
  });
};

export default checkoutSessionsRoutes;
