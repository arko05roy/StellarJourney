import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_CHARGE_REQUEST_STATUSES,
  assertLegalChargeRequestTransition,
  CHARGE_REQUEST_LEGAL_TRANSITIONS,
  transitionChargeRequest,
} from "./state-machine.js";
import { ApiError } from "./errors.js";
import { cleanDatabase, createTestPrisma, randomHexId32, createTestMerchant } from "./test/helpers.js";
import type { PrismaClient } from "./db.js";

describe("CHARGE_REQUEST_LEGAL_TRANSITIONS guard (pure, exhaustive)", () => {
  // Every legal edge succeeds.
  for (const [from, tos] of Object.entries(CHARGE_REQUEST_LEGAL_TRANSITIONS)) {
    for (const to of tos) {
      it(`allows "${from}" -> "${to}"`, () => {
        expect(() => assertLegalChargeRequestTransition(from as never, to)).not.toThrow();
      });
    }
  }

  // Every other pair (49 total combinations minus the legal ones) is rejected.
  for (const from of ALL_CHARGE_REQUEST_STATUSES) {
    for (const to of ALL_CHARGE_REQUEST_STATUSES) {
      const legal = (CHARGE_REQUEST_LEGAL_TRANSITIONS[from] as readonly string[]).includes(to);
      if (legal) continue;
      it(`rejects "${from}" -> "${to}"`, () => {
        expect(() => assertLegalChargeRequestTransition(from, to)).toThrow(ApiError);
        try {
          assertLegalChargeRequestTransition(from, to);
        } catch (error) {
          expect(error).toBeInstanceOf(ApiError);
          expect((error as ApiError).code).toBe("InvalidStateTransition");
          expect((error as ApiError).httpStatus).toBe(409);
        }
      });
    }
  }

  it("succeeded and permanently_failed are terminal (no legal outgoing edge)", () => {
    expect(CHARGE_REQUEST_LEGAL_TRANSITIONS.succeeded).toEqual([]);
    expect(CHARGE_REQUEST_LEGAL_TRANSITIONS.permanently_failed).toEqual([]);
  });

  it("retryable_failed -> processing is the one edge Phase 9's scheduler owns (retry re-entry)", () => {
    expect(CHARGE_REQUEST_LEGAL_TRANSITIONS.retryable_failed).toEqual(["processing"]);
  });
});

describe("transitionChargeRequest (DB-atomic)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function createScheduledChargeRequest(): Promise<string> {
    const merchant = await createTestMerchant(prisma);
    const row = await prisma.chargeRequest.create({
      data: {
        merchantId: merchant.merchantId,
        mandateId: randomHexId32(),
        chargeId: randomHexId32(),
        amount: "1000000",
        invoiceHash: randomHexId32(),
        scheduledFor: new Date(),
      },
    });
    return row.id;
  }

  it("applies a legal transition and persists it", async () => {
    const id = await createScheduledChargeRequest();
    await transitionChargeRequest(prisma, id, "scheduled", "processing");
    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("processing");
  });

  it("rejects an illegal transition without mutating the row", async () => {
    const id = await createScheduledChargeRequest();
    await expect(transitionChargeRequest(prisma, id, "scheduled", "succeeded")).rejects.toThrow(ApiError);
    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("scheduled");
  });

  it("rejects a transition whose declared `from` no longer matches the row's actual current status (concurrent-safety guard)", async () => {
    const id = await createScheduledChargeRequest();
    await transitionChargeRequest(prisma, id, "scheduled", "processing");
    // Row is now "processing" — a second caller still claiming "scheduled" as `from` must fail, not silently overwrite.
    await expect(transitionChargeRequest(prisma, id, "scheduled", "processing")).rejects.toThrow(ApiError);
  });

  it("carries extra data through the transition atomically", async () => {
    const id = await createScheduledChargeRequest();
    await transitionChargeRequest(prisma, id, "scheduled", "processing", { attemptCount: 1 });
    const row = await prisma.chargeRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("processing");
    expect(row.attemptCount).toBe(1);
  });
});
