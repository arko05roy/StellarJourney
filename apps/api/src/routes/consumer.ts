import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { baseUnitsToDecimalString } from "@paymap/shared";
import { StellarAccountAddressSchema } from "../schemas/common.js";
import { resolveAssetDecimalsForMandate } from "../services/asset-decimals.js";
import type { ChargeRequest, Payment } from "../db.js";

/**
 * Unauthenticated by design (same reasoning as `checkout-sessions.ts`'s
 * `/public` routes) — a payer's browser never holds a merchant API key, so
 * the consumer dashboard (Phase 11) can only ever call the public surface.
 * Every field returned here is purely for *discovery* and *enrichment*
 * (merchant display name, a best-effort last-known status, payment-history
 * indexing) — CLAUDE.md §2's decision applies: the dashboard must re-verify
 * a mandate's actual status/limits/usage against `get_mandate` before
 * displaying or acting on it. `cachedStatus`/`lastIndexedAt` are explicitly
 * named to make clear they are not the authority.
 *
 * Discovery source: `MandateIndex.payerAddress`, seeded by
 * `checkout-sessions.ts`'s `/mandate` link endpoint (Phase 10) and
 * refreshed by the merchant-authenticated `GET /v1/mandates/:id` read
 * (Phase 8). A mandate created through some path that never touches either
 * of those (there isn't one in this product today) would not be
 * discoverable here — an accepted limitation of a DB-backed discovery index
 * for a contract that has no "list mandates by payer" method of its own.
 */

const PayerAddressQuerySchema = z.object({ payerAddress: StellarAccountAddressSchema });

const ListConsumerPaymentsQuerySchema = z.object({
  payerAddress: StellarAccountAddressSchema,
  limit: z.coerce.number().int().positive().max(100).default(50),
});

async function toConsumerMandateIndexResponse(
  row: {
    mandateId: string;
    merchantId: string;
    assetAddress: string;
    status: string;
    lastIndexedAt: Date | null;
    merchant: { name: string; walletAddress: string };
  },
  resolveDecimals: (merchantId: string, mandateId: string) => Promise<number>,
) {
  // The on-chain `Mandate` itself carries no `decimals` field (CLAUDE.md §9
  // — on-chain amounts are integer base units only); the dashboard needs it
  // to render any amount from a live `get_mandate` read. Resolved the same
  // way `payments.ts`/`charges.ts` already do (via the product that
  // originated the checkout session), falling back to 7 (PUSD's own
  // decimals, and the same fallback those routes use) if this mandate
  // wasn't linked through a checkout session this API knows about.
  const assetDecimals = await resolveDecimals(row.merchantId, row.mandateId).catch(() => 7);
  return {
    mandateId: row.mandateId,
    merchant: { name: row.merchant.name, walletAddress: row.merchant.walletAddress },
    assetAddress: row.assetAddress,
    assetDecimals,
    // Deliberately prefixed/named to signal "last known, not authoritative"
    // — never rendered by the dashboard as the mandate's actual status
    // without a live `get_mandate` read alongside it.
    cachedStatus: row.status,
    lastIndexedAt: row.lastIndexedAt?.toISOString() ?? undefined,
  };
}

async function toConsumerPaymentResponse(
  payment: Payment & { merchant: { name: string; walletAddress: string } },
  resolveDecimals: (merchantId: string, mandateId: string) => Promise<number>,
) {
  const decimals = await resolveDecimals(payment.merchantId, payment.mandateId).catch(() => 7);
  return {
    paymentId: payment.paymentId,
    mandateId: payment.mandateId,
    chargeId: payment.chargeId,
    merchant: { name: payment.merchant.name, walletAddress: payment.merchant.walletAddress },
    amount: baseUnitsToDecimalString(BigInt(payment.amount), decimals),
    assetAddress: payment.assetAddress,
    transactionHash: payment.transactionHash,
    createdAt: payment.createdAt.toISOString(),
  };
}

async function toConsumerFailedAttemptResponse(
  chargeRequest: ChargeRequest & { merchant: { name: string; walletAddress: string } },
  resolveDecimals: (merchantId: string, mandateId: string) => Promise<number>,
) {
  const decimals = await resolveDecimals(chargeRequest.merchantId, chargeRequest.mandateId).catch(() => 7);
  return {
    id: chargeRequest.id,
    mandateId: chargeRequest.mandateId,
    chargeId: chargeRequest.chargeId,
    merchant: { name: chargeRequest.merchant.name, walletAddress: chargeRequest.merchant.walletAddress },
    amount: baseUnitsToDecimalString(BigInt(chargeRequest.amount), decimals),
    status: chargeRequest.status,
    // The relayer's classifier reason (`apps/relayer/src/classify.ts`):
    // either one of the 24 frozen mandate-registry error names, or one of
    // the 3 infra-transient reasons (`RPC_UNAVAILABLE`/`SEND_FAILED`/
    // `TX_NOT_INCLUDED`). The web app's `describeFailureReason` decodes
    // this into consumer language; this endpoint never translates it
    // itself, so the stable machine code always survives to the client.
    failureCode: chargeRequest.failureCode ?? undefined,
    attemptedAt: chargeRequest.updatedAt.toISOString(),
  };
}

const consumerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/consumer/mandates", async (request, reply) => {
    const { payerAddress } = PayerAddressQuerySchema.parse(request.query);

    const rows = await app.prisma.mandateIndex.findMany({
      where: { payerAddress },
      include: { merchant: true },
      orderBy: { createdAt: "desc" },
    });

    const resolveDecimals = (merchantId: string, mandateId: string) => resolveAssetDecimalsForMandate(app.prisma, merchantId, mandateId);
    const data = await Promise.all(rows.map((row) => toConsumerMandateIndexResponse(row, resolveDecimals)));

    reply.status(200).send({ data });
  });

  app.get("/consumer/payments", async (request, reply) => {
    const { payerAddress, limit } = ListConsumerPaymentsQuerySchema.parse(request.query);

    const mandateIds = (
      await app.prisma.mandateIndex.findMany({ where: { payerAddress }, select: { mandateId: true } })
    ).map((row) => row.mandateId);

    if (mandateIds.length === 0) {
      reply.status(200).send({ payments: [], failedAttempts: [] });
      return;
    }

    const resolveDecimals = (merchantId: string, mandateId: string) => resolveAssetDecimalsForMandate(app.prisma, merchantId, mandateId);

    const [paymentRows, failedAttemptRows] = await Promise.all([
      app.prisma.payment.findMany({
        where: { mandateId: { in: mandateIds } },
        include: { merchant: true },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      app.prisma.chargeRequest.findMany({
        where: { mandateId: { in: mandateIds }, status: { in: ["retryable_failed", "permanently_failed"] } },
        include: { merchant: true },
        orderBy: { updatedAt: "desc" },
        take: limit,
      }),
    ]);

    const [payments, failedAttempts] = await Promise.all([
      Promise.all(paymentRows.map((row) => toConsumerPaymentResponse(row, resolveDecimals))),
      Promise.all(failedAttemptRows.map((row) => toConsumerFailedAttemptResponse(row, resolveDecimals))),
    ]);

    reply.status(200).send({ payments, failedAttempts });
  });
};

export default consumerRoutes;
