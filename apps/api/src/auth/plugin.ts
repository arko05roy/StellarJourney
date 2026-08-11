/**
 * Fastify preHandler that resolves the calling merchant from the
 * `Authorization: Bearer <api key>` header. Attached per-route (every
 * `/v1/*` route except the unauthenticated `POST /v1/merchants` bootstrap
 * endpoint), not globally, so the bootstrap endpoint can remain
 * unauthenticated without an explicit opt-out mechanism.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { authenticateApiKey } from "./api-key.js";
import { unauthorizedError } from "../errors.js";
import type { ApiKey, Merchant, PrismaClient } from "../db.js";
import { requireApiKeyScopes, type ApiKeyScope } from "./scopes.js";

declare module "fastify" {
  interface FastifyRequest {
    merchantContext?: { merchant: Merchant; apiKey: ApiKey };
  }
}

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export function createAuthPreHandler(
  prisma: PrismaClient,
  hashSecret: string,
  requiredScopes: readonly ApiKeyScope[] = [],
): preHandlerHookHandler {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header) {
      throw unauthorizedError("MISSING_API_KEY", 'Missing "Authorization" header.');
    }
    const match = BEARER_PATTERN.exec(header);
    if (!match?.[1]) {
      throw unauthorizedError(
        "MISSING_API_KEY",
        'Authorization header must be "Bearer <api key>".',
      );
    }
    request.merchantContext = await authenticateApiKey(prisma, hashSecret, match[1]);
    requireApiKeyScopes(request.merchantContext.apiKey, requiredScopes);
  };
}

/** Throws if called before the auth preHandler ran — a programming error in route wiring, not a client-facing failure mode. */
export function requireMerchantContext(request: FastifyRequest): {
  merchant: Merchant;
  apiKey: ApiKey;
} {
  if (!request.merchantContext) {
    throw new Error(
      "requireMerchantContext() called without the auth preHandler having run for this route",
    );
  }
  return request.merchantContext;
}
