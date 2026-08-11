/**
 * Merchant account bootstrap + API key rotation. Not part of PLAN.md §14's
 * literal endpoint list — added because CLAUDE.md §10 explicitly requires
 * "issue / hash / rotate" API keys with a "show full key only once" UX and
 * rate-limited key issuance, and without *some* endpoint there is no way to
 * ever obtain the first key that authenticates every other route. Kept
 * under `/v1/merchants` rather than invented as a separate unversioned
 * surface. Documented as a deliberate scope addition in
 * `docs/merchant-api.md`.
 */
import type { FastifyPluginAsync } from "fastify";
import { CreateApiKeySchema, CreateMerchantSchema } from "../schemas/merchants.js";
import { createMerchantWithApiKey, createScopedApiKey, rotateApiKey } from "../auth/api-key.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";
import { conflictError, notFoundError } from "../errors.js";

const merchantsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/merchants",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = CreateMerchantSchema.parse(request.body);
      const { merchant, apiKey, rawApiKey } = await createMerchantWithApiKey(
        app.prisma,
        app.hashSecret,
        input,
      );
      reply.status(201).send({
        merchantId: merchant.id,
        name: merchant.name,
        walletAddress: merchant.walletAddress,
        apiKeyId: apiKey.id,
        // Shown once, here, and never again — not retrievable through any other endpoint.
        apiKey: rawApiKey,
      });
    },
  );

  app.post(
    "/merchants/me/api-keys/rotate",
    {
      preHandler: createAuthPreHandler(app.prisma, app.hashSecret, ["api_keys:manage"]),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { merchant, apiKey } = requireMerchantContext(request);
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
      const { merchant, apiKey: currentApiKey } = requireMerchantContext(request);
      const { id } = request.params as { id: string };
      if (id === currentApiKey.id) {
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
