/**
 * Single point of contact with the generated Prisma client. Every other
 * module in this app imports `PrismaClient`/`Prisma`/model types from here,
 * never from the generated output directly — this is the one file that
 * knows the relative filesystem path from `apps/api` to `prisma/generated`
 * (mirrors `packages/contract-client/src/deployment-registry.ts`'s
 * reach-through-to-repo-root convention).
 *
 * The generated client lives at `prisma/generated/client` (an explicit
 * `output` in `prisma/schema.prisma`) rather than the classic
 * `node_modules/@prisma/client` location — verified necessary in this pnpm
 * workspace: with no explicit `output`, `prisma generate` resolves
 * `@prisma/client` relative to the *schema's* directory (repo root
 * `prisma/`), and when it isn't satisfied there it shells out to
 * `pnpm add @prisma/client@<version>`, which reliably fails when that
 * subprocess is itself spawned from inside another `pnpm run` invocation
 * (lockfile/store contention). An explicit `output` path is also Prisma's
 * own documented forward-compatible pattern.
 */
import { PrismaClient } from "../../../prisma/generated/client/index.js";

export { PrismaClient, Prisma } from "../../../prisma/generated/client/index.js";
export type {
  ApiKey,
  ChargeAuthorization,
  ChargeRequest,
  CheckoutSession,
  IdempotencyKey,
  MandateIndex,
  Merchant,
  MerchantAuthChallenge,
  MerchantSession,
  Payment,
  Product,
  RefundRequest,
  User,
  WebhookDelivery,
} from "../../../prisma/generated/client/index.js";
export {
  AmountType,
  ApiKeyStatus,
  ChargeAuthorizationStatus,
  ChargeRequestStatus,
  CheckoutSessionStatus,
  MerchantStatus,
  WebhookDeliveryStatus,
} from "../../../prisma/generated/client/index.js";

/** Fresh client per call — callers (the real server, or each test file) own the connection lifecycle and must call `$disconnect()`. */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}
