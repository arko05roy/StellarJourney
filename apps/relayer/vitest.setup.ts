// Vitest doesn't load .env files itself. Default both connection strings to
// the docker-compose.yml credentials (CLAUDE.md §16) so `pnpm test` works
// out of the box once `docker compose up -d` has run. Mirrors
// apps/api/vitest.setup.ts, plus REDIS_URL for this app's queue/scheduler
// tests.
//
// Deliberately a DIFFERENT Postgres *schema* (`relayer_test`, a namespace
// within the same `paymap` database, not a separate database) than
// apps/api's tests use (`public`) — this app's package.json `test` script
// already exports `DATABASE_URL` with `schema=relayer_test` before running
// `prisma migrate deploy`/vitest, so this default only matters when running
// `vitest` directly. Found necessary, not stylistic: turbo's task graph has
// no ordering between `@paymap/api#test` and `@paymap/relayer#test` (only
// `dependsOn: ["^build"]`), so `pnpm test` from the repo root runs both
// packages' real-Postgres suites concurrently. Both call a full
// `cleanDatabase()` at nearly every test's `beforeEach` — sharing one schema
// meant one suite's cleanup deleted rows out from under the other suite's
// in-flight test, a real, observed failure (FK violations on
// `deleteMany()`/`create()` mid-run), not a hypothetical one. A distinct
// Postgres schema gives full physical isolation with zero process-level
// coordination needed.
process.env["DATABASE_URL"] ??= "postgresql://postgres:postgres@localhost:5432/paymap?schema=relayer_test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
