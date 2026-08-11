/**
 * Fastify preHandler that resolves the calling merchant from the
 * `Authorization: Bearer <credential>` header. Human dashboard requests use
 * short-lived merchant sessions; integrations use scoped API keys.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { authenticateApiKey } from "./api-key.js";
import { authenticateMerchantSession } from "./merchant-session.js";
import { forbiddenError, unauthorizedError } from "../errors.js";
import type { ApiKey, Merchant, MerchantSession, PrismaClient } from "../db.js";
import { requireApiKeyScopes, type ApiKeyScope } from "./scopes.js";

export type MerchantCredential =
  { kind: "api_key"; apiKey: ApiKey } | { kind: "session"; session: MerchantSession };

declare module "fastify" {
  interface FastifyRequest {
    merchantContext?: { merchant: Merchant; credential: MerchantCredential };
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
        'Authorization header must be "Bearer <credential>".',
      );
    }
    const rawCredential = match[1];
    if (rawCredential.startsWith("pms_live_")) {
      const authenticated = await authenticateMerchantSession(
        prisma,
        hashSecret,
        rawCredential,
        request.server.now(),
      );
      if (!authenticated.merchant) {
        throw forbiddenError(
          "MERCHANT_PROFILE_REQUIRED",
          "Complete your merchant profile before continuing.",
        );
      }
      request.merchantContext = {
        merchant: authenticated.merchant,
        credential: { kind: "session", session: authenticated.session },
      };
      return;
    }

    const authenticated = await authenticateApiKey(prisma, hashSecret, rawCredential);
    requireApiKeyScopes(authenticated.apiKey, requiredScopes);
    request.merchantContext = {
      merchant: authenticated.merchant,
      credential: { kind: "api_key", apiKey: authenticated.apiKey },
    };
  };
}

/** Throws if called before the auth preHandler ran — a programming error in route wiring, not a client-facing failure mode. */
export function requireMerchantContext(request: FastifyRequest): {
  merchant: Merchant;
  credential: MerchantCredential;
} {
  if (!request.merchantContext) {
    throw new Error(
      "requireMerchantContext() called without the auth preHandler having run for this route",
    );
  }
  return request.merchantContext;
}

export function requireApiKeyCredential(request: FastifyRequest): ApiKey {
  const { credential } = requireMerchantContext(request);
  if (credential.kind !== "api_key") {
    throw forbiddenError(
      "API_KEY_CREDENTIAL_REQUIRED",
      "This operation requires an API key credential.",
    );
  }
  return credential.apiKey;
}
