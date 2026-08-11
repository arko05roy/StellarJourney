// Vitest doesn't load .env files itself. The generated Prisma client reads
// `DATABASE_URL` from `process.env` at construction time (its datasource is
// `env("DATABASE_URL")` in `prisma/schema.prisma`) — default to the
// docker-compose.yml credentials (CLAUDE.md §16's own `.env.example`) so
// `pnpm test` works out of the box once `docker compose up -d` has run,
// while still respecting an explicitly-set DATABASE_URL (e.g. in CI).
process.env["DATABASE_URL"] ??= "postgresql://postgres:postgres@localhost:5432/paymap?schema=public";
