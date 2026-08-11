import type { FastifyPluginAsync } from "fastify";
import { HexId32Schema } from "@paymap/shared";
import type { Mandate } from "@paymap/contract-client";
import { notFoundError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { MandateReadError } from "../chain/mandate-reader.js";

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
