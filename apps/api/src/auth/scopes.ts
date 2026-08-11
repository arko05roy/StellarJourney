import { forbiddenError } from "../errors.js";
import type { ApiKey } from "../db.js";

export const API_KEY_SCOPES = [
  "products:read",
  "products:write",
  "checkout_sessions:read",
  "checkout_sessions:write",
  "mandates:read",
  "charges:read",
  "charges:write",
  "payments:read",
  "refunds:read",
  "refunds:write",
  "webhooks:read",
  "webhooks:write",
  "api_keys:manage",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const ALL_API_KEY_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPES];

export function assertValidScopes(
  scopes: readonly string[],
): asserts scopes is readonly ApiKeyScope[] {
  const invalid = scopes.filter((scope) => !API_KEY_SCOPES.includes(scope as ApiKeyScope));
  if (invalid.length > 0) {
    throw forbiddenError(
      "INVALID_API_KEY_SCOPE",
      `Unsupported API key scope: ${invalid.join(", ")}.`,
    );
  }
}

export function requireApiKeyScopes(apiKey: ApiKey, required: readonly ApiKeyScope[]): void {
  const missing = required.filter((scope) => !apiKey.scopes.includes(scope));
  if (missing.length > 0) {
    throw forbiddenError(
      "INSUFFICIENT_SCOPE",
      `This API key requires scope: ${missing.join(", ")}.`,
    );
  }
}
