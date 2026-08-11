import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { HexId32Schema } from "@paymap/shared";
import type { Mandate } from "@paymap/contract-client";
import { notFoundError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { MandateReadError } from "../chain/mandate-reader.js";

const ListMandatesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(25),
});

/**
 * Base-unit amounts here are returned as plain integer strings, *not* the
 * decimal-string convention used by `/products`/`/charges` — this endpoint
 * can read any on-chain mandate regardless of whether this API's own
 * `Product` catalog knows its asset's `decimals` (CLAUDE.md §2: this read
 * always reflects live chain state, never a DB-side assumption). Fields are
 * named `*BaseUnits` to make that explicit rather than ambiguous.
 */
function toMandateResponse(mandate: Mandate) {
  return {
    id: mandate.id,
    payer: mandate.payer,
    merchant: mandate.merchant,
    asset: mandate.asset,
    status: mandate.status,
    amountRule:
      mandate.amountRule.kind === "fixed"
        ? { kind: "fixed", amountBaseUnits: mandate.amountRule.amount.toString() }
        : { kind: "variable", maxPerChargeBaseUnits: mandate.amountRule.maxPerCharge.toString() },
    maxPerPeriodBaseUnits: mandate.maxPerPeriod.toString(),
    periodSeconds: mandate.periodSeconds.toString(),
    minIntervalSeconds: mandate.minIntervalSeconds.toString(),
    startAt: new Date(Number(mandate.startAt) * 1000).toISOString(),
    expiresAt: new Date(Number(mandate.expiresAt) * 1000).toISOString(),
    maxSuccessfulCharges: mandate.maxSuccessfulCharges,
    successfulCharges: mandate.successfulCharges,
    totalCollectedBaseUnits: mandate.totalCollected.toString(),
    currentPeriodStart: new Date(Number(mandate.currentPeriodStart) * 1000).toISOString(),
    currentPeriodCollectedBaseUnits: mandate.currentPeriodCollected.toString(),
    lastChargedAt: mandate.lastChargedAt !== undefined ? new Date(Number(mandate.lastChargedAt) * 1000).toISOString() : undefined,
    createdAt: new Date(Number(mandate.createdAt) * 1000).toISOString(),
  };
}

const mandatesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Merchant-scoped mandate list — backs the dashboard's "Active mandates"
   * and "Upcoming collections" views (PLAN.md §16.3). The contract has no
   * "list mandates by merchant" method of its own (CLAUDE.md §2 doesn't
   * change that), so discovery starts from `MandateIndex` (seeded by the
   * checkout-session link + the single-mandate read below) and every row is
   * then re-read live on-chain, exactly like `GET /mandates/:id` — the
   * response's `status`/usage fields are never the DB cache alone. A live
   * read that fails (e.g. transient RPC trouble) degrades that one row to
   * its last-known cached status rather than failing the whole list, with
   * `live: false` making the degradation visible rather than silent.
   */
  app.get("/mandates", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const query = ListMandatesQuerySchema.parse(request.query);

    const indexRows = await app.prisma.mandateIndex.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });

    const rows = await Promise.all(
      indexRows.map(async (row) => {
        try {
          const mandate = await app.mandateReader.getMandate(row.mandateId);
          return { live: true as const, mandate: toMandateResponse(mandate), mandateId: row.mandateId };
        } catch (error) {
          if (error instanceof MandateReadError) {
            return { live: false as const, mandateId: row.mandateId, cachedStatus: row.status, lastIndexedAt: row.lastIndexedAt?.toISOString() };
          }
          throw error;
        }
      }),
    );

    reply.status(200).send({ data: rows });
  });

  app.get("/mandates/:id", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const { id } = request.params as { id: string };
    const mandateId = HexId32Schema.parse(id);

    let mandate: Mandate;
    try {
      mandate = await app.mandateReader.getMandate(mandateId);
    } catch (error) {
      if (error instanceof MandateReadError) {
        throw notFoundError("MandateNotFound", `No mandate "${mandateId}".`);
      }
      throw error;
    }

    // Never reveal existence of a mandate that belongs to a different
    // merchant — same 404 as "doesn't exist at all".
    if (mandate.merchant !== merchant.walletAddress) {
      throw notFoundError("MandateNotFound", `No mandate "${mandateId}".`);
    }

    // Best-effort cache refresh — never the authority for the response
    // above, which is built entirely from the live read (CLAUDE.md §2).
    await app.prisma.mandateIndex
      .upsert({
        where: { mandateId },
        create: {
          mandateId,
          merchantId: merchant.id,
          payerAddress: mandate.payer,
          merchantAddress: mandate.merchant,
          assetAddress: mandate.asset,
          status: mandate.status,
          lastIndexedAt: app.now(),
        },
        update: {
          status: mandate.status,
          lastIndexedAt: app.now(),
          contractStateVersion: { increment: 1 },
        },
      })
      .catch((error: unknown) => {
        app.log.warn({ error, mandateId }, "failed to refresh MandateIndex cache (non-fatal)");
      });

    reply.status(200).send(toMandateResponse(mandate));
  });
};

export default mandatesRoutes;
