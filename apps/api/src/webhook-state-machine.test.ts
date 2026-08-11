import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALL_WEBHOOK_DELIVERY_STATUSES,
  assertLegalWebhookDeliveryTransition,
  WEBHOOK_DELIVERY_LEGAL_TRANSITIONS,
  transitionWebhookDelivery,
} from "./webhook-state-machine.js";
import { ApiError } from "./errors.js";
import { cleanDatabase, createTestPrisma, createTestMerchant } from "./test/helpers.js";
import type { PrismaClient } from "./db.js";

describe("WEBHOOK_DELIVERY_LEGAL_TRANSITIONS guard (pure, exhaustive)", () => {
  for (const [from, tos] of Object.entries(WEBHOOK_DELIVERY_LEGAL_TRANSITIONS)) {
    for (const to of tos) {
      it(`allows "${from}" -> "${to}"`, () => {
        expect(() => assertLegalWebhookDeliveryTransition(from as never, to)).not.toThrow();
      });
    }
  }

  for (const from of ALL_WEBHOOK_DELIVERY_STATUSES) {
    for (const to of ALL_WEBHOOK_DELIVERY_STATUSES) {
      const legal = (WEBHOOK_DELIVERY_LEGAL_TRANSITIONS[from] as readonly string[]).includes(to);
      if (legal) continue;
      it(`rejects "${from}" -> "${to}"`, () => {
        expect(() => assertLegalWebhookDeliveryTransition(from, to)).toThrow(ApiError);
        try {
          assertLegalWebhookDeliveryTransition(from, to);
        } catch (error) {
          expect(error).toBeInstanceOf(ApiError);
          expect((error as ApiError).code).toBe("InvalidStateTransition");
          expect((error as ApiError).httpStatus).toBe(409);
        }
      });
    }
  }

  it("delivered and dead_letter are terminal (no legal outgoing edge)", () => {
    expect(WEBHOOK_DELIVERY_LEGAL_TRANSITIONS.delivered).toEqual([]);
    expect(WEBHOOK_DELIVERY_LEGAL_TRANSITIONS.dead_letter).toEqual([]);
  });

  it("retry_scheduled -> delivering is the one retry re-entry edge", () => {
    expect(WEBHOOK_DELIVERY_LEGAL_TRANSITIONS.retry_scheduled).toEqual(["delivering"]);
  });
});

describe("transitionWebhookDelivery (DB-atomic)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = createTestPrisma();
    await cleanDatabase(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function createPendingDelivery(): Promise<string> {
    const merchant = await createTestMerchant(prisma);
    const row = await prisma.webhookDelivery.create({
      data: {
        merchantId: merchant.merchantId,
        eventId: "evt_" + Math.random().toString(36).slice(2),
        eventType: "payment.succeeded",
        payload: { hello: "world" },
      },
    });
    return row.id;
  }

  it("applies a legal transition and persists it", async () => {
    const id = await createPendingDelivery();
    await transitionWebhookDelivery(prisma, id, "pending", "delivering");
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("delivering");
  });

  it("rejects an illegal transition without mutating the row", async () => {
    const id = await createPendingDelivery();
    await expect(transitionWebhookDelivery(prisma, id, "pending", "delivered")).rejects.toThrow(ApiError);
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("pending");
  });

  it("rejects a transition whose declared `from` no longer matches the row's actual current status (concurrent-safety guard)", async () => {
    const id = await createPendingDelivery();
    await transitionWebhookDelivery(prisma, id, "pending", "delivering");
    await expect(transitionWebhookDelivery(prisma, id, "pending", "delivering")).rejects.toThrow(ApiError);
  });

  it("carries extra data through the transition atomically", async () => {
    const id = await createPendingDelivery();
    await transitionWebhookDelivery(prisma, id, "pending", "delivering", { attemptCount: 1 });
    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("delivering");
    expect(row.attemptCount).toBe(1);
  });
});
