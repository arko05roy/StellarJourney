/**
 * Idempotency for `POST /v1/checkout-sessions`, `POST
 * /v1/mandates/:id/charges`, and `POST /v1/payments/:id/refunds`
 * (CLAUDE.md §10).
 *
 * ## Concurrency-safety mechanism (the part CLAUDE.md §10 explicitly
 * requires: "Use a database transaction so concurrent identical requests
 * can't both execute")
 *
 * `runIdempotent` wraps *one* Postgres transaction around: (1) inserting the
 * `IdempotencyKey` row, (2) running the caller's side-effecting write, and
 * (3) writing the response back onto that same row — then commits. This
 * single-transaction shape is load-bearing, not incidental:
 *
 * The insert is a raw `INSERT ... ON CONFLICT ("merchantId", "key") DO
 * NOTHING RETURNING id`, deliberately *not* Prisma's typed `.create()`.
 * Postgres still applies the same MVCC rule to it: when a *different*,
 * not-yet-committed transaction already inserted a row with the same key,
 * this statement blocks until that transaction resolves, then either finds
 * the conflict (if it committed) or proceeds to insert normally (if it
 * rolled back) — same blocking guarantee as a plain `INSERT` would give.
 * The difference is `ON CONFLICT DO NOTHING` never raises a Postgres error
 * on a real conflict, only returns zero rows — verified necessary here, not
 * a stylistic choice: a plain `.create()` that hits a unique-violation
 * poisons the *entire* enclosing Postgres transaction (error `25P02`,
 * "current transaction is aborted") the instant it errors, and every
 * further statement in that same transaction — including the `SELECT` this
 * function needs to run next, to read the winning transaction's stored
 * response — fails too. Catching the JS exception doesn't undo that; only
 * `ROLLBACK` (ending the transaction) does, which isn't an option here
 * since the whole point is staying in the one transaction that can see the
 * winner's committed row. `ON CONFLICT DO NOTHING` sidesteps the problem
 * entirely by never raising the Postgres-level error in the first place.
 *
 * Because the insert, the handler, and the response write are *all* inside
 * the same transaction, "the first transaction committed" and "the first
 * transaction's response is fully populated" are the same event — a second,
 * concurrent caller that unblocks after a `P2002` is guaranteed to find
 * `responseStatus`/`responseBody` already set, never a half-finished row.
 * No polling, no retry loop, no advisory lock needed.
 *
 * A request that fails validation *before* calling `runIdempotent` (e.g. the
 * on-chain precheck rejecting a revoked mandate) never reaches this
 * function at all, and a handler that throws inside the transaction rolls
 * the whole thing back — including the `IdempotencyKey` insert. Retrying an
 * identical request after either of those re-runs validation from scratch
 * against current state, which is strictly more correct than replaying a
 * stale verdict would be; idempotency here protects exactly one thing —
 * "did the side-effecting write happen more than once" — not "cache every
 * response forever."
 */
import { createHash, randomUUID } from "node:crypto";
import { conflictError } from "../errors.js";
import type { Prisma, PrismaClient } from "../db.js";

/** Canonical hash of a JSON-serializable request body, used to detect key reuse with a different payload. */
export function computeRequestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export interface IdempotentHandlerResult {
  status: number;
  body: unknown;
}

export interface IdempotentOutcome {
  replayed: boolean;
  status: number;
  body: unknown;
}

/**
 * Runs `handler` at most once for a given `(merchantId, key)` pair. Same
 * key + same `requestHash` on a later call replays the stored response
 * (`replayed: true`). Same key + a *different* `requestHash` is rejected
 * with 409 (CLAUDE.md §10 — reject reuse with a different body) without
 * ever calling `handler`.
 */
export async function runIdempotent(
  prisma: PrismaClient,
  merchantId: string,
  key: string,
  requestHash: string,
  handler: (tx: Prisma.TransactionClient) => Promise<IdempotentHandlerResult>,
): Promise<IdempotentOutcome> {
  return prisma.$transaction(
    async (tx) => {
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "IdempotencyKey" (id, "merchantId", "key", "requestHash", "createdAt")
        VALUES (${randomUUID()}, ${merchantId}, ${key}, ${requestHash}, now())
        ON CONFLICT ("merchantId", "key") DO NOTHING
        RETURNING id
      `;
      const weOwnThisAttempt = inserted.length > 0;

      if (!weOwnThisAttempt) {
        const existing = await tx.idempotencyKey.findUniqueOrThrow({
          where: { merchantId_key: { merchantId, key } },
        });
        if (existing.requestHash !== requestHash) {
          throw conflictError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request body.");
        }
        if (existing.responseStatus === null || existing.responseBody === null) {
          // Defensive only: per the module doc, a committed row is only ever
          // visible here already-completed. Surfacing a typed conflict
          // instead of a null body if that invariant is ever violated.
          throw conflictError("IDEMPOTENCY_KEY_PROCESSING", "This request is still being processed. Retry shortly.");
        }
        return { replayed: true, status: existing.responseStatus, body: existing.responseBody };
      }

      const result = await handler(tx);
      await tx.idempotencyKey.update({
        where: { merchantId_key: { merchantId, key } },
        data: { responseStatus: result.status, responseBody: result.body as Prisma.InputJsonValue },
      });
      return { replayed: false, status: result.status, body: result.body };
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}
