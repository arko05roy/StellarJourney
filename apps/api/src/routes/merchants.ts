/**
 * Merchant wallet authentication, verified profile creation, dashboard
 * sessions, and scoped integration-key management.
 */
import type { FastifyPluginAsync } from "fastify";
import {
  CompleteMerchantAuthChallengeSchema,
  CreateApiKeySchema,
  CreateMerchantAuthChallengeSchema,
  RegisterVerifiedMerchantSchema,
} from "../schemas/merchants.js";
import { createScopedApiKey, rotateApiKey } from "../auth/api-key.js";
import {
  createAuthPreHandler,
  requireApiKeyCredential,
  requireMerchantContext,
} from "../auth/plugin.js";
import {
  authenticateMerchantSession,
  completeMerchantAuthChallenge,
  createMerchantAuthChallenge,
  registerVerifiedMerchant,
  revokeMerchantSession,
} from "../auth/merchant-session.js";
import { conflictError, notFoundError, unauthorizedError } from "../errors.js";

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function requireBearerCredential(request: Parameters<typeof requireMerchantContext>[0]): string {
  const match = BEARER_PATTERN.exec(request.headers.authorization ?? "");
  if (!match?.[1]) {
    throw unauthorizedError(
      "MISSING_API_KEY",
      'Authorization header must be "Bearer <credential>".',
    );
  }
  return match[1];
}

const merchantsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/merchant-auth/challenges",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = CreateMerchantAuthChallengeSchema.parse(request.body);
      const challenge = await createMerchantAuthChallenge(app.prisma, {
        walletAddress: input.walletAddress,
        networkPassphrase: app.chargeAuthorization.networkPassphrase,
        domain: app.merchantAuthDomain,
        now: app.now(),
      });
      reply.status(201).send({
        challengeId: challenge.id,
        message: challenge.message,
        networkPassphrase: challenge.networkPassphrase,
        expiresAt: challenge.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    "/merchant-auth/complete",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = CompleteMerchantAuthChallengeSchema.parse(request.body);
      const result = await completeMerchantAuthChallenge(app.prisma, app.hashSecret, {
        ...input,
        now: app.now(),
      });
      reply.status(201).send({
        sessionToken: result.rawSessionToken,
        expiresAt: result.expiresAt.toISOString(),
        profileRequired: result.profileRequired,
        ...(result.merchant
          ? {
              merchant: {
                id: result.merchant.id,
                name: result.merchant.name,
                walletAddress: result.merchant.walletAddress,
              },
            }
          : {}),
      });
    },
  );

  app.post(
    "/merchant-auth/register",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = RegisterVerifiedMerchantSchema.parse(request.body);
      const authenticated = await authenticateMerchantSession(
        app.prisma,
        app.hashSecret,
        requireBearerCredential(request),
        app.now(),
        { allowPendingProfile: true },
      );
      const merchant = await registerVerifiedMerchant(
        app.prisma,
        authenticated.session,
        input.name,
      );
      reply.status(201).send({
        merchantId: merchant.id,
        name: merchant.name,
        walletAddress: merchant.walletAddress,
      });
    },
  );

  app.post("/merchant-auth/logout", async (request, reply) => {
    const authenticated = await authenticateMerchantSession(
      app.prisma,
      app.hashSecret,
      requireBearerCredential(request),
      app.now(),
      { allowPendingProfile: true },
    );
    await revokeMerchantSession(app.prisma, authenticated.session.id, app.now());
    reply.status(204).send();
  });

  app.post(
    "/merchants/me/api-keys/rotate",
    {
      preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["api_keys:manage"]),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const apiKey = requireApiKeyCredential(request);
      const { apiKey: newApiKey, rawApiKey } = await rotateApiKey(
        app.prisma,
        app.hashSecret,
        merchant.id,
        apiKey.id,
      );
      reply.status(201).send({
        apiKeyId: newApiKey.id,
        // Shown once, here, and never again.
        apiKey: rawApiKey,
        revokedApiKeyId: apiKey.id,
      });
    },
  );

  app.get(
    "/merchants/me/api-keys",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["api_keys:manage"]) },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const keys = await app.prisma.apiKey.findMany({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: "desc" },
      });
      reply.status(200).send({
        data: keys.map((key) => ({
          id: key.id,
          name: key.name,
          keyPrefix: key.keyPrefix,
          scopes: key.scopes,
          status: key.status,
          lastUsedAt: key.lastUsedAt?.toISOString(),
          createdAt: key.createdAt.toISOString(),
          revokedAt: key.revokedAt?.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/merchants/me/api-keys",
    {
      preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["api_keys:manage"]),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { merchant } = requireMerchantContext(request);
      const input = CreateApiKeySchema.parse(request.body);
      const { apiKey, rawApiKey } = await createScopedApiKey(
        app.prisma,
        app.hashSecret,
        merchant.id,
        input,
      );
      reply.status(201).send({
        apiKeyId: apiKey.id,
        name: apiKey.name,
        scopes: apiKey.scopes,
        apiKey: rawApiKey,
      });
    },
  );

  app.delete(
    "/merchants/me/api-keys/:id",
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["api_keys:manage"]) },
    async (request, reply) => {
      const { merchant, credential } = requireMerchantContext(request);
      const { id } = request.params as { id: string };
      if (credential.kind === "api_key" && id === credential.apiKey.id) {
        throw conflictError(
          "CANNOT_REVOKE_CURRENT_API_KEY",
          "Rotate this API key instead of revoking the credential used for this request.",
        );
      }
      const result = await app.prisma.apiKey.updateMany({
        where: { id, merchantId: merchant.id, status: "active" },
        data: { status: "revoked", revokedAt: app.now() },
      });
      if (result.count !== 1) {
        throw notFoundError("API_KEY_NOT_FOUND", `No active API key "${id}".`);
      }
      reply.status(204).send();
    },
  );
};

export default merchantsRoutes;
