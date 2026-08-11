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
import { CreateMerchantSchema } from "../schemas/merchants.js";
import { createMerchantWithApiKey, rotateApiKey } from "../auth/api-key.js";
import { createAuthPreHandler, requireMerchantContext } from "../auth/plugin.js";

const merchantsRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/merchants",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = CreateMerchantSchema.parse(request.body);
      const { merchant, apiKey, rawApiKey } = await createMerchantWithApiKey(app.prisma, app.hashSecret, input);
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
    { preHandler: createAuthPreHandler(app.prisma, app.hashSecret), config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { merchant, apiKey } = requireMerchantContext(request);
      const { apiKey: newApiKey, rawApiKey } = await rotateApiKey(app.prisma, app.hashSecret, merchant.id, apiKey.id);
      reply.status(201).send({
        apiKeyId: newApiKey.id,
        // Shown once, here, and never again.
        apiKey: rawApiKey,
        revokedApiKeyId: apiKey.id,
      });
    },
  );
};

export default merchantsRoutes;
