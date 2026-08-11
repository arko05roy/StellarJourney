import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in, serial Phase 13 system suite.
 *
 * Unlike `playwright.config.ts`, this uses the real API/Postgres, committed
 * testnet deployment, live Soroban RPC, runtime-funded ephemeral accounts,
 * and a local in-memory signing relay. It is intentionally a separate
 * command so the normal fast/stub suite stays deterministic.
 */
const WEB_PORT = 4321;
const API_PORT = 4320;
const SIGNER_PORT = 4322;

export default defineConfig({
  testDir: "./e2e/system",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 15 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-system-testnet",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm exec next dev -p ${String(WEB_PORT)}`,
    port: WEB_PORT,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${String(API_PORT)}`,
      NEXT_PUBLIC_SYSTEM_E2E_SIGNER_URL: `http://127.0.0.1:${String(SIGNER_PORT)}`,
      STELLAR_NETWORK: "testnet",
    },
  },
});
