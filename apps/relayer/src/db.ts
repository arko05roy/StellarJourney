/**
 * Single point of contact with the generated Prisma client, mirroring
 * `apps/api/src/db.ts` exactly (same relative depth from repo root — both
 * apps live at `apps/<name>/src`). Every other module in this app imports
 * `PrismaClient`/`Prisma`/model types from here, never from the generated
 * output directly.
 */
import { PrismaClient } from "../../../prisma/generated/client/index.js";

export { PrismaClient, Prisma } from "../../../prisma/generated/client/index.js";
export type {
  ChargeAuthorization,
  ChargeRequest,
  Merchant,
  Payment,
  MandateIndex,
  IndexerCursor,
} from "../../../prisma/generated/client/index.js";
export {
  ChargeAuthorizationStatus,
  ChargeRequestStatus,
  WebhookDeliveryStatus,
} from "../../../prisma/generated/client/index.js";

/** Fresh client per call — callers (the real server, or each test file) own the connection lifecycle and must call `$disconnect()`. */
export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}
