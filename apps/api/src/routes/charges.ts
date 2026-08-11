import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  HexId32Schema,
  baseUnitsToDecimalString,
  decimalToPositiveBaseUnits,
  encryptChargeAuthorization,
  MoneyConversionError,
} from "@paymap/shared";
import {
  authorizationPreimageXdr,
  createUnsignedChargeAuthorization,
  validateChargeAuthorization,
} from "@paymap/stellar";
import type { Mandate } from "@paymap/contract-client";
import { badRequest, conflictError, mandateErrorToApiError, notFoundError } from "../errors.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { CompleteChargeAuthorizationSchema, CreateChargeSchema } from "../schemas/charges.js";
import { IdempotencyKeyHeaderSchema } from "../schemas/common.js";
import { computeRequestHash, runIdempotent } from "../idempotency/middleware.js";
import { precheckCharge } from "../chain/precheck.js";
import { MandateReadError } from "../chain/mandate-reader.js";
import { resolveAssetDecimalsForMandate } from "../services/asset-decimals.js";
import { randomHexId32 } from "../utils/ids.js";
import { ChargeRequestStatus, type ChargeRequest } from "../db.js";

const CHARGE_REQUEST_STATUS_VALUES: readonly string[] = Object.values(ChargeRequestStatus);
const LEDGER_SECONDS_ESTIMATE = 5;
const AUTHORIZATION_EXECUTION_MARGIN_LEDGERS = 720;
const MAX_AUTHORIZATION_TTL_LEDGERS = 400_000;

/** Comma-separated status filter (e.g. `?status=retryable_failed,permanently_failed` for the "Failed collections" view, PLAN.md §16.3) — validated against the real enum in the route handler (every value must be a real status, rejected outright otherwise rather than silently ignored). */
const ListChargesQuerySchema = z.object({
  mandateId: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

function requireIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw badRequest(
      "MISSING_IDEMPOTENCY_KEY",
      'This endpoint requires an "Idempotency-Key" header.',
    );
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
    "/mandates/:id/charge-authorizations",
    {
      preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["charges:write"]),
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
      const latestLedger = await app.mandateReader.getLatestLedgerSequence();
      const scheduledDelaySeconds = Math.max(
        0,
        Math.ceil((scheduledFor.getTime() - now.getTime()) / 1000),
      );
      const signatureExpirationLedger =
        latestLedger +
        Math.ceil(scheduledDelaySeconds / LEDGER_SECONDS_ESTIMATE) +
        AUTHORIZATION_EXECUTION_MARGIN_LEDGERS;
      if (signatureExpirationLedger - latestLedger > MAX_AUTHORIZATION_TTL_LEDGERS) {
        throw badRequest(
          "SCHEDULE_EXCEEDS_AUTHORIZATION_TTL",
          "scheduledFor is too far in the future for a bounded Soroban authorization.",
        );
      }

      const outcome = await runIdempotent(
        app.prisma,
        merchant.id,
        idempotencyKey,
        requestHash,
        async (tx) => {
          const chargeId = randomHexId32();
          const context = {
            contractId: app.chargeAuthorization.contractId,
            networkPassphrase: app.chargeAuthorization.networkPassphrase,
            merchantAddress: merchant.walletAddress,
          };
          const args = {
            mandateId,
            chargeId,
            amount: amountBaseUnits,
            invoiceHash: input.invoiceHash,
          };
          const unsignedEntryXdr = createUnsignedChargeAuthorization(
            context,
            args,
            signatureExpirationLedger,
          );
          const authorization = await tx.chargeAuthorization.create({
            data: {
              merchantId: merchant.id,
              mandateId,
              chargeId,
              amount: amountBaseUnits.toString(),
              invoiceHash: input.invoiceHash,
              scheduledFor,
              networkPassphrase: context.networkPassphrase,
              contractId: context.contractId,
              unsignedEntryXdr,
              signatureExpirationLedger: BigInt(signatureExpirationLedger),
            },
          });
          return {
            status: 201,
            body: {
              id: authorization.id,
              mandateId,
              chargeId,
              amount: baseUnitsToDecimalString(amountBaseUnits, decimals),
              invoiceHash: input.invoiceHash,
              scheduledFor: scheduledFor.toISOString(),
              merchantAddress: merchant.walletAddress,
              contractId: context.contractId,
              networkPassphrase: context.networkPassphrase,
              signatureExpirationLedger,
              unsignedAuthorizationEntryXdr: unsignedEntryXdr,
              authorizationPreimageXdr: authorizationPreimageXdr(
                unsignedEntryXdr,
                context.networkPassphrase,
              ),
              status: authorization.status,
            },
          };
        },
      );

      const responseBody = outcome.body as { chargeId: string };
      app.log.info(
        {
          requestId: request.id,
          merchantId: merchant.id,
          mandateId,
          chargeId: responseBody.chargeId,
        },
        "charge_authorization.issued",
      );
      reply
        .status(outcome.status)
        .header("Idempotency-Replayed", String(outcome.replayed))
        .send(outcome.body);
    },
  );

  app.post(
    "/charge-authorizations/:id/complete",
    {
      preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["charges:write"]),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const { id } = request.params as { id: string };
      const input = CompleteChargeAuthorizationSchema.parse(request.body);
      const authorization = await app.prisma.chargeAuthorization.findFirst({
        where: { id, merchantId: merchant.id },
        include: { chargeRequest: true },
      });
      if (!authorization) {
        throw notFoundError(
          "CHARGE_AUTHORIZATION_NOT_FOUND",
          `No charge authorization "${id}" for this merchant.`,
        );
      }
      if (authorization.chargeRequest) {
        const decimals = await resolveAssetDecimalsForMandate(
          app.prisma,
          merchant.id,
          authorization.mandateId,
        );
        reply.status(200).send(toChargeRequestResponse(authorization.chargeRequest, decimals));
        return;
      }
      if (authorization.status !== "pending") {
        throw conflictError(
          "CHARGE_AUTHORIZATION_NOT_PENDING",
          `Charge authorization "${id}" is ${authorization.status}.`,
        );
      }

      const latestLedger = await app.mandateReader.getLatestLedgerSequence();
      try {
        validateChargeAuthorization({
          signedEntryXdr: input.signedAuthorizationEntryXdr,
          context: {
            contractId: authorization.contractId,
            networkPassphrase: authorization.networkPassphrase,
            merchantAddress: merchant.walletAddress,
          },
          args: {
            mandateId: authorization.mandateId,
            chargeId: authorization.chargeId,
            amount: BigInt(authorization.amount),
            invoiceHash: authorization.invoiceHash,
          },
          currentLedgerSeq: latestLedger,
          expectedExpirationLedger: Number(authorization.signatureExpirationLedger),
        });
      } catch (error) {
        throw badRequest(
          "INVALID_CHARGE_AUTHORIZATION",
          error instanceof Error ? error.message : "Invalid charge authorization.",
        );
      }

      const ciphertext = encryptChargeAuthorization(
        input.signedAuthorizationEntryXdr,
        app.authorizationEncryptionKey,
      );
      const chargeRequest = await app.prisma.$transaction(async (tx) => {
        const updated = await tx.chargeAuthorization.updateMany({
          where: { id, merchantId: merchant.id, status: "pending" },
          data: { status: "ready", signedEntryCiphertext: ciphertext },
        });
        if (updated.count !== 1) {
          const existing = await tx.chargeRequest.findUnique({
            where: { authorizationId: id },
          });
          if (existing) return existing;
          throw conflictError(
            "CHARGE_AUTHORIZATION_ALREADY_USED",
            `Charge authorization "${id}" was already completed.`,
          );
        }
        return tx.chargeRequest.create({
          data: {
            merchantId: merchant.id,
            mandateId: authorization.mandateId,
            chargeId: authorization.chargeId,
            amount: authorization.amount,
            invoiceHash: authorization.invoiceHash,
            scheduledFor: authorization.scheduledFor,
            authorizationId: authorization.id,
          },
        });
      });

      const decimals = await resolveAssetDecimalsForMandate(
        app.prisma,
        merchant.id,
        authorization.mandateId,
      );
      reply.status(201).send(toChargeRequestResponse(chargeRequest, decimals));
    },
  );

  app.post(
    "/mandates/:id/charges",
    {
      preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["charges:write"]),
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async () => {
      throw conflictError(
        "MERCHANT_AUTHORIZATION_REQUIRED",
        "Create and complete a charge authorization before scheduling a charge.",
      );
    },
  );

  /** Merchant-scoped charge-request list, optionally filtered by status/mandate — backs "Upcoming collections" (scheduled, not yet due) and "Failed collections" (retryable_failed/permanently_failed) on the dashboard (PLAN.md §16.3). */
  app.get(
    "/charges",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["charges:read"]) },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const query = ListChargesQuerySchema.parse(request.query);

      let statusIn: string[] | undefined;
      if (query.status !== undefined) {
        statusIn = query.status.split(",").map((s) => s.trim());
        for (const value of statusIn) {
          if (!CHARGE_REQUEST_STATUS_VALUES.includes(value)) {
            throw badRequest("INVALID_STATUS_FILTER", `"${value}" is not a valid charge status.`);
          }
        }
      }

      const chargeRequests = await app.prisma.chargeRequest.findMany({
        where: {
          merchantId: merchant.id,
          ...(query.mandateId ? { mandateId: query.mandateId } : {}),
          ...(statusIn ? { status: { in: statusIn as ChargeRequest["status"][] } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: query.limit,
      });

      const withDecimals = await Promise.all(
        chargeRequests.map(async (chargeRequest) => {
          const decimals = await resolveAssetDecimalsForMandate(
            app.prisma,
            merchant.id,
            chargeRequest.mandateId,
          ).catch(() => 7);
          return toChargeRequestResponse(chargeRequest, decimals);
        }),
      );

      reply.status(200).send({ data: withDecimals });
    },
  );

  app.get(
    "/charges/:id",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["charges:read"]) },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const { id } = request.params as { id: string };
      const chargeRequest = await app.prisma.chargeRequest.findFirst({
        where: { id, merchantId: merchant.id },
      });
      if (!chargeRequest) {
        throw notFoundError("CHARGE_REQUEST_NOT_FOUND", `No charge "${id}" for this merchant.`);
      }
      const decimals = await resolveAssetDecimalsForMandate(
        app.prisma,
        merchant.id,
        chargeRequest.mandateId,
      );
      reply.status(200).send(toChargeRequestResponse(chargeRequest, decimals));
    },
  );
};

export default chargesRoutes;
