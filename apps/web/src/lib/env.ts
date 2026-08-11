/**
 * Typed, validated environment access (CLAUDE.md §16 — validate required
 * env vars at startup, fail fast). Only `NEXT_PUBLIC_*` vars belong here:
 * this module is imported from client components, and Next.js inlines
 * `NEXT_PUBLIC_*` references at build time (which requires the literal
 * `process.env.NEXT_PUBLIC_X` property access below — not a computed
 * lookup). Server-only configuration (the deployment registry — contract
 * id, network passphrase, RPC URL, asset info — all public but
 * filesystem-sourced via `@paymap/contract-client`'s `loadDeployment`) is
 * read once in `app/checkout/[sessionId]/page.tsx` (a Server Component) and
 * passed down as props instead of duplicated into env vars here.
 */
import { z } from "zod";

const EnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
});

function readEnv() {
  const parsed = EnvSchema.safeParse({
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  });
  if (!parsed.success) {
    throw new Error(`Invalid/missing environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export const env = readEnv();
