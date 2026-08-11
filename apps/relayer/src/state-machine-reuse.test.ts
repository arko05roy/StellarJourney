/**
 * Proves this app reuses `apps/api/src/state-machine.ts` verbatim (CLAUDE.md
 * §5 "don't duplicate business rules across frontend, backend, and
 * contract" — extended here to backend-vs-relayer) rather than maintaining
 * a second copy of the `ChargeRequest` transition guard. Illegal
 * transitions are rejected; the one edge Phase 9 adds
 * (`retryable_failed -> processing`) is legal.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertLegalChargeRequestTransition, transitionChargeRequest, CHARGE_REQUEST_LEGAL_TRANSITIONS } from "@paymap/api/dist/state-machine.js";
import { cleanDatabase, createChargeRequest, createMerchantWithMandateContext, createTestPrisma } from "./test/helpers.js";
import type { PrismaClient } from "./db.js";

describe("ChargeRequest state machine (reused from apps/api, not re-implemented)", () => {
  it("rejects an illegal transition (e.g. scheduled -> succeeded)", () => {
    expect(() => assertLegalChargeRequestTransition("scheduled", "succeeded")).toThrow();
  });

  it("rejects permanently_failed -> processing (a permanently-failed request is never retried)", () => {
    expect(() => assertLegalChargeRequestTransition("permanently_failed", "processing")).toThrow();
  });

  it("allows retryable_failed -> processing (Phase 9's scheduler retry re-entry, the one edge this phase adds)", () => {
    expect(() => assertLegalChargeRequestTransition("retryable_failed", "processing")).not.toThrow();
    expect(CHARGE_REQUEST_LEGAL_TRANSITIONS.retryable_failed).toEqual(["processing"]);
  });

  describe("transitionChargeRequest (DB-atomic, real Postgres)", () => {
    let prisma: PrismaClient;

    beforeEach(async () => {
      prisma = createTestPrisma();
      await cleanDatabase(prisma);
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("applies the retry re-entry transition and persists it", async () => {
      const fixture = await createMerchantWithMandateContext(prisma);
      const { id } = await createChargeRequest(prisma, fixture, { status: "retryable_failed" });
      await transitionChargeRequest(prisma, id, "retryable_failed", "processing", { attemptCount: 2 });
      const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("processing");
      expect(row.attemptCount).toBe(2);
    });
  });
});
