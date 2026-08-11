import { defineConfig } from "vitest/config";

// Integration tests hit a real Postgres (docker-compose.yml) and a real
// Redis (for the queue/scheduler tests) — generous timeouts avoid flakiness
// on a cold connection pool without masking a genuinely hung test. Mirrors
// apps/api/vitest.config.ts's rationale exactly.
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // The duplicate-delivery / concurrent-claim tests intentionally fire
    // overlapping work against the same Postgres rows — run test files
    // serially so two files' fixtures never race each other.
    fileParallelism: false,
  },
});
