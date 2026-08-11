import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "./env.js";

const validEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/paymap",
  REDIS_URL: "redis://localhost:6379",
  STELLAR_NETWORK: "testnet",
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  MANDATE_CONTRACT_ID: "CCEXAMPLE",
  RELAYER_SECRET_KEY: "SEXAMPLE",
  WEBHOOK_ENCRYPTION_KEY: "whsec_example",
  API_KEY_HASH_SECRET: "pepper",
};

describe("loadEnv", () => {
  it("parses a complete, valid environment", () => {
    const env = loadEnv(validEnv);
    expect(env.STELLAR_NETWORK).toBe("testnet");
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
  });

  it("fails fast and lists every missing variable", () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);

    try {
      loadEnv({});
      expect.unreachable("loadEnv should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("STELLAR_NETWORK");
      expect(message).toContain("RELAYER_SECRET_KEY");
    }
  });

  it("rejects an invalid STELLAR_NETWORK value", () => {
    expect(() => loadEnv({ ...validEnv, STELLAR_NETWORK: "mainnet" })).toThrow(EnvValidationError);
  });

  it("rejects a non-URL SOROBAN_RPC_URL", () => {
    expect(() => loadEnv({ ...validEnv, SOROBAN_RPC_URL: "not-a-url" })).toThrow(EnvValidationError);
  });
});
