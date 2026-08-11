import { z } from "zod";

/**
 * Canonical environment schema (CLAUDE.md §16). Every variable is required —
 * fail fast at startup rather than surface a confusing downstream error when
 * a required secret or endpoint is missing.
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  STELLAR_NETWORK: z.enum(["testnet", "futurenet", "local"]),
  SOROBAN_RPC_URL: z.string().url("SOROBAN_RPC_URL must be a valid URL"),
  HORIZON_URL: z.string().url("HORIZON_URL must be a valid URL"),
  MANDATE_CONTRACT_ID: z.string().min(1, "MANDATE_CONTRACT_ID is required"),
  RELAYER_SECRET_KEY: z.string().min(1, "RELAYER_SECRET_KEY is required"),
  WEBHOOK_ENCRYPTION_KEY: z.string().min(1, "WEBHOOK_ENCRYPTION_KEY is required"),
  API_KEY_HASH_SECRET: z.string().min(1, "API_KEY_HASH_SECRET is required"),
});

export type Env = z.infer<typeof envSchema>;

/** Thrown by loadEnv()/getEnv() when required configuration is missing or invalid. */
export class EnvValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.join("\n")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Parses and validates the given process-env-shaped source. Pure function —
 * does not read `process.env` implicitly, so it is safe to call in tests
 * with a synthetic object.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new EnvValidationError(issues);
  }
  return result.data;
}

let cachedEnv: Env | undefined;

/**
 * Lazily-memoized environment accessor. Validation happens on first call,
 * not at module-import time, so importing this module never throws as a
 * side effect of another module graph (e.g. in unit tests or tooling that
 * does not set every variable).
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = loadEnv();
  }
  return cachedEnv;
}

/** Test-only escape hatch: clears the memoized env so the next getEnv() re-parses. */
export function resetEnvCache(): void {
  cachedEnv = undefined;
}
