import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { baseUnitsToDecimalString, decimalToPositiveBaseUnits, MoneyConversionError } from "@paymap/shared";
import { badRequest, notFoundError, unprocessableError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { CreateRefundSchema } from "../schemas/refunds.js";
import { IdempotencyKeyHeaderSchema } from "../schemas/common.js";
import { computeRequestHash, runIdempotent } from "../idempotency/middleware.js";
import { resolveAssetDecimalsForMandate } from "../services/asset-decimals.js";
import { randomHexId32 } from "../utils/ids.js";
import type { Payment, RefundRequest } from "../db.js";

function requireIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw badRequest("MISSING_IDEMPOTENCY_KEY", 'This endpoint requires an "Idempotency-Key" header.');
  }
  return IdempotencyKeyHeaderSchema.parse(value);
}

function toPaymentResponse(payment: Payment, decimals: number) {
  return {
    paymentId: payment.paymentId,
    mandateId: payment.mandateId,
    chargeId: payment.chargeId,
    amount: baseUnitsToDecimalString(BigInt(payment.amount), decimals),
    assetAddress: payment.assetAddress,
    transactionHash: payment.transactionHash,
    ledger: payment.ledger.toString(),
    refundedTotal: baseUnitsToDecimalString(BigInt(payment.refundedTotal), decimals),
    createdAt: payment.createdAt.toISOString(),
  };
}

function toRefundRequestResponse(refundRequest: RefundRequest, decimals: number) {
  return {
    id: refundRequest.id,
    paymentId: refundRequest.paymentId,
    refundId: refundRequest.refundId,
    amount: baseUnitsToDecimalString(BigInt(refundRequest.amount), decimals),
    status: refundRequest.status,
    transactionHash: refundRequest.transactionHash ?? undefined,
    createdAt: refundRequest.createdAt.toISOString(),
  };
}

const ListPaymentsQuerySchema = z.object({
  mandateId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const paymentsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/payments", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const query = ListPaymentsQuerySchema.parse(request.query);

    const payments = await app.prisma.payment.findMany({
      where: { merchantId: merchant.id, ...(query.mandateId ? { mandateId: query.mandateId } : {}) },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });

    const withDecimals = await Promise.all(
      payments.map(async (payment) => {
        const decimals = await resolveAssetDecimalsForMandate(app.prisma, merchant.id, payment.mandateId).catch(() => 7);
        return toPaymentResponse(payment, decimals);
      }),
    );

    reply.status(200).send({ data: withDecimals });
  });

  app.post(
    "/payments/:id/refunds",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const { id: paymentId } = request.params as { id: string };
      const input = CreateRefundSchema.parse(request.body);
      const requestHash = computeRequestHash(request.body);

      const payment = await app.prisma.payment.findFirst({ where: { paymentId, merchantId: merchant.id } });
      if (!payment) {
        throw notFoundError("PaymentNotFound", `No payment "${paymentId}" for this merchant.`);
      }

      const decimals = await resolveAssetDecimalsForMandate(app.prisma, merchant.id, payment.mandateId);

      let amountBaseUnits: bigint;
      try {
        amountBaseUnits = decimalToPositiveBaseUnits(input.amount, decimals);
      } catch (error) {
        if (error instanceof MoneyConversionError) {
          throw badRequest("INVALID_AMOUNT", error.message);
        }
        throw error;
      }

      // CLAUDE.md §2: don't trust the DB's `refundedTotal` cache alone —
      // verify against the on-chain cumulative refunded total before
      // accepting a refund request that could exceed the payment.
      const onChainRefundedTotal = await app.mandateReader.getRefundedTotal(paymentId);
      const dbRefundedTotal = BigInt(payment.refundedTotal);
      const refundedTotal = onChainRefundedTotal > dbRefundedTotal ? onChainRefundedTotal : dbRefundedTotal;
      const paymentAmount = BigInt(payment.amount);
      if (refundedTotal + amountBaseUnits > paymentAmount) {
        // Mirrors the contract's own error name (CLAUDE.md §8), even though
        // this specific check runs here rather than on-chain: no relayer
        // submission exists yet for refunds (Phase 8 only ever schedules
        // the request — see `RefundRequest`'s module doc in
        // `prisma/schema.prisma`), so there is no contract call to decode
        // this error *from* yet. Using the same name keeps the code stable
        // across whichever phase adds real submission.
        throw unprocessableError("RefundExceedsPayment", "Refund amount would exceed the original payment amount.");
      }

      const outcome = await runIdempotent(app.prisma, merchant.id, idempotencyKey, requestHash, async (tx) => {
        const refundRequest = await tx.refundRequest.create({
          data: {
            merchantId: merchant.id,
            paymentId: payment.paymentId,
            refundId: randomHexId32(),
            amount: amountBaseUnits.toString(),
            // status defaults to "scheduled" — submission is a future phase (see RefundRequest module doc in prisma/schema.prisma).
          },
        });
        return { status: 201, body: toRefundRequestResponse(refundRequest, decimals) };
      });

      reply.status(outcome.status).header("Idempotency-Replayed", String(outcome.replayed)).send(outcome.body);
    },
  );
};

export default paymentsRoutes;
