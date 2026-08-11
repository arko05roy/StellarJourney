import { randomBytes } from "node:crypto";

/** A fresh 32-byte hex id, matching `@paymap/shared`'s `HexId32Schema` shape — used for server-generated `charge_id`/`refund_id` values before they're ever submitted on-chain. */
export function randomHexId32(): string {
  return randomBytes(32).toString("hex");
}
