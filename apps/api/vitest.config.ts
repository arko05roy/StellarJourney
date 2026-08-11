import { defineConfig } from "vitest/config";

// Integration tests hit a real Postgres (docker-compose.yml) and run
// interactive Prisma transactions (idempotency, concurrency) — generous
// timeouts avoid flakiness on a cold connection pool without masking a
// genuinely hung test.
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // Concurrency tests intentionally fire overlapping requests against the
    // same Postgres rows — run test files serially so two files' fixture
    // data (e.g. two "revoked API key" merchants) never race each other on
    // shared connection-pool timing.
    fileParallelism: false,
  },
});
