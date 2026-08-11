import { defineConfig, devices } from "@playwright/test";

/**
 * Phase 10 happy-path checkout test. Both the wallet (Stellar Wallets Kit)
 * and the Soroban RPC/mandate-registry calls are stubbed
 * (`NEXT_PUBLIC_E2E_STUBS=1` — see `src/lib/test-stubs.ts` and
 * `src/components/checkout/checkout-page-client.tsx`), and the merchant
 * API's public checkout endpoints are served by a tiny local stand-in
 * (`e2e/fixtures/mock-api-server.mjs`) instead of a real `apps/api` +
 * Postgres — this is deliberately a UI/flow smoke test, not a real-network
 * integration test (Phase 13 owns that, against testnet or local Soroban).
 *
 * Run locally:
 *   pnpm --filter @paymap/web test:e2e
 * (equivalent to `playwright test` — this config starts both webServers
 * itself; no separate `docker compose` or `apps/api` process needed for
 * this suite specifically.)
 */
const MOCK_API_PORT = 4310;
const WEB_PORT = 4311;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${String(WEB_PORT)}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `node e2e/fixtures/mock-api-server.mjs`,
      port: MOCK_API_PORT,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_API_PORT: String(MOCK_API_PORT) },
    },
    {
      command: `pnpm exec next dev -p ${String(WEB_PORT)}`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NEXT_PUBLIC_API_URL: `http://localhost:${String(MOCK_API_PORT)}`,
        NEXT_PUBLIC_E2E_STUBS: "1",
        STELLAR_NETWORK: "testnet",
      },
    },
  ],
});
