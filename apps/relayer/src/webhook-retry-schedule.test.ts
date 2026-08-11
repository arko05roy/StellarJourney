import { describe, expect, it } from "vitest";
import { MAX_WEBHOOK_ATTEMPTS, nextWebhookRetryAt } from "./webhook-retry-schedule.js";

const FROM = new Date("2026-01-01T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("nextWebhookRetryAt — documented schedule", () => {
  it("produces the exact documented sequence: +1m, +5m, +30m, +2h, +6h", () => {
    expect(nextWebhookRetryAt(1, FROM)).toEqual(new Date(FROM.getTime() + 1 * MIN));
    expect(nextWebhookRetryAt(2, FROM)).toEqual(new Date(FROM.getTime() + 5 * MIN));
    expect(nextWebhookRetryAt(3, FROM)).toEqual(new Date(FROM.getTime() + 30 * MIN));
    expect(nextWebhookRetryAt(4, FROM)).toEqual(new Date(FROM.getTime() + 2 * HOUR));
    expect(nextWebhookRetryAt(5, FROM)).toEqual(new Date(FROM.getTime() + 6 * HOUR));
  });

  it("the schedule is exhausted after the 6th attempt (1 initial + 5 retries)", () => {
    expect(nextWebhookRetryAt(6, FROM)).toBeUndefined();
    expect(MAX_WEBHOOK_ATTEMPTS).toBe(6);
  });

  it("relative delays are strictly increasing (each retry backs off further)", () => {
    const delays: number[] = [];
    for (let attempt = 1; attempt < MAX_WEBHOOK_ATTEMPTS; attempt++) {
      const at = nextWebhookRetryAt(attempt, FROM);
      expect(at).toBeDefined();
      delays.push((at as Date).getTime() - FROM.getTime());
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] as number);
    }
  });
});
