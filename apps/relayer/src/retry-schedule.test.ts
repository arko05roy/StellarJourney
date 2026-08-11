import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, nextRetryAt } from "./retry-schedule.js";

const HOUR = 60 * 60 * 1000;

describe("nextRetryAt — PLAN.md §15's +6h / +24h / +72h then permanently_failed schedule", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");

  it("attempt 1 failing transiently schedules the next attempt +6h out", () => {
    expect(nextRetryAt(1, from)).toEqual(new Date(from.getTime() + 6 * HOUR));
  });

  it("attempt 2 failing transiently schedules +24h out", () => {
    expect(nextRetryAt(2, from)).toEqual(new Date(from.getTime() + 24 * HOUR));
  });

  it("attempt 3 failing transiently schedules +72h out", () => {
    expect(nextRetryAt(3, from)).toEqual(new Date(from.getTime() + 72 * HOUR));
  });

  it("attempt 4 failing transiently exhausts the schedule (undefined -> permanently_failed)", () => {
    expect(nextRetryAt(4, from)).toBeUndefined();
  });

  it("MAX_ATTEMPTS is 4 (1 initial + 3 retries)", () => {
    expect(MAX_ATTEMPTS).toBe(4);
  });
});
