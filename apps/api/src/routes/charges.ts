import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { HexId32Schema, baseUnitsToDecimalString, decimalToPositiveBaseUnits, MoneyConversionError } from "@paymap/shared";
import type { Mandate } from "@paymap/contract-client";
import { badRequest, mandateErrorToApiError, notFoundError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { CreateChargeSchema } from "../schemas/charges.js";
import { IdempotencyKeyHeaderSchema } from "../schemas/common.js";
import { computeRequestHash, runIdempotent } from "../idempotency/middleware.js";
import { precheckCharge } from "../chain/precheck.js";
import { MandateReadError } from "../chain/mandate-reader.js";
import { resolveAssetDecimalsForMandate } from "../services/asset-decimals.js";
import { randomHexId32 } from "../utils/ids.js";
import type { ChargeRequest } from "../db.js";

function requireIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw badRequest("MISSING_IDEMPOTENCY_KEY", 'This endpoint requires an "Idempotency-Key" header.');
  }
  return IdempotencyKeyHeaderSchema.parse(value);
}

function toChargeRequestResponse(chargeRequest: ChargeRequest, decimals: number) {
  return {
    id: chargeRequest.id,
    mandateId: chargeRequest.mandateId,
    chargeId: chargeRequest.chargeId,
    amount: baseUnitsToDecimalString(BigInt(chargeRequest.amount), decimals),
    invoiceHash: chargeRequest.invoiceHash,
    scheduledFor: chargeRequest.scheduledFor.toISOString(),
    status: chargeRequest.status,
    attemptCount: chargeRequest.attemptCount,
    failureCode: chargeRequest.failureCode ?? undefined,
    transactionHash: chargeRequest.transactionHash ?? undefined,
    createdAt: chargeRequest.createdAt.toISOString(),
  };
}

const chargesRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/mandates/:id/charges",
    {
      preHandler: createAuthPreHandler(app.prisma, app.hashSecret),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const { id } = request.params as { id: string };
      const mandateId = HexId32Schema.parse(id);
      const input = CreateChargeSchema.parse(request.body);
      const requestHash = computeRequestHash(request.body);

      const decimals = await resolveAssetDecimalsForMandate(app.prisma, merchant.id, mandateId);

      let amountBaseUnits: bigint;
      try {
        amountBaseUnits = decimalToPositiveBaseUnits(input.amount, decimals);
      } catch (error) {
        if (error instanceof MoneyConversionError) {
          throw badRequest("INVALID_AMOUNT", error.message);
        }
        throw error;
      }

      let mandate: Mandate;
      try {
        mandate = await app.mandateReader.getMandate(mandateId);
      } catch (error) {
        if (error instanceof MandateReadError) {
          throw notFoundError("MandateNotFound", `No mandate "${mandateId}".`);
        }
        throw error;
      }
      if (mandate.merchant !== merchant.walletAddress) {
        throw notFoundError("MandateNotFound", `No mandate "${mandateId}".`);
      }

      // Verify on-chain state *before* accepting the charge request
      // (CLAUDE.md §2) — reject deterministically-doomed requests with the
      // specific contract error code rather than queuing work that can't
      // succeed. This happens outside the idempotency transaction: it's a
      // pure read, so a retry re-validating against fresh chain state is
      // strictly more correct than replaying a stale verdict would be.
      const now = app.now();
      const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
      const precheckError = precheckCharge(mandate, amountBaseUnits, nowSeconds);
      if (precheckError) {
        throw mandateErrorToApiError(precheckError);
      }

      const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : now;

      const outcome = await runIdempotent(app.prisma, merchant.id, idempotencyKey, requestHash, async (tx) => {
        const chargeRequest = await tx.chargeRequest.create({
          data: {
            merchantId: merchant.id,
            mandateId,
            chargeId: randomHexId32(),
            amount: amountBaseUnits.toString(),
            invoiceHash: input.invoiceHash,
            scheduledFor,
            // status defaults to "scheduled" — Phase 8 owns only this
            // transition; Phase 9's relayer drives the rest (CLAUDE.md §17).
          },
        });
        return { status: 201, body: toChargeRequestResponse(chargeRequest, decimals) };
      });

      reply.status(outcome.status).header("Idempotency-Replayed", String(outcome.replayed)).send(outcome.body);
    },
  );

  app.get("/charges/:id", { preHandler: createAuthPreHandler(app.prisma, app.hashSecret) }, async (request, reply) => {
    const { merchant } = requireMerchantContext(request);
    const { id } = request.params as { id: string };
    const chargeRequest = await app.prisma.chargeRequest.findFirst({ where: { id, merchantId: merchant.id } });
    if (!chargeRequest) {
      throw notFoundError("CHARGE_REQUEST_NOT_FOUND", `No charge "${id}" for this merchant.`);
    }
    const decimals = await resolveAssetDecimalsForMandate(app.prisma, merchant.id, chargeRequest.mandateId);
    reply.status(200).send(toChargeRequestResponse(chargeRequest, decimals));
  });
};

export default chargesRoutes;
