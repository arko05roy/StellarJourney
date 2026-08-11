import { describe, expect, it } from "vitest";
import { signWebhookPayload } from "@paymap/shared";
import { verifyWebhook, WebhookSignatureError } from "./verify-webhook.js";

const SECRET = "whsec_test";
const EVENT_ID = "evt_abc123";
const NOW = new Date("2026-07-29T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const BODY = JSON.stringify({ eventId: EVENT_ID, eventType: "payment.succeeded", data: { paymentId: "pay_1" } });

describe("verifyWebhook", () => {
  it("accepts a validly signed payload and returns eventId/timestampSeconds", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS, rawBody: BODY });
    const result = verifyWebhook(BODY, header, SECRET, { now: NOW });
    expect(result).toEqual({ eventId: EVENT_ID, timestampSeconds: NOW_SECONDS });
  });

  it("rejects a tampered body", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS, rawBody: BODY });
    expect(() => verifyWebhook(BODY + "tampered", header, SECRET, { now: NOW })).toThrow(WebhookSignatureError);
  });

  it("rejects a wrong secret", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS, rawBody: BODY });
    expect(() => verifyWebhook(BODY, header, "wrong-secret", { now: NOW })).toThrow(WebhookSignatureError);
  });

  it("rejects a stale timestamp", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS - 3600, rawBody: BODY });
    expect(() => verifyWebhook(BODY, header, SECRET, { now: NOW })).toThrow(WebhookSignatureError);
  });

  it("rejects a future timestamp", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS + 3600, rawBody: BODY });
    expect(() => verifyWebhook(BODY, header, SECRET, { now: NOW })).toThrow(WebhookSignatureError);
  });

  it("honors a custom tolerance", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS - 10, rawBody: BODY });
    expect(() => verifyWebhook(BODY, header, SECRET, { now: NOW, toleranceSeconds: 5 })).toThrow(WebhookSignatureError);
    expect(verifyWebhook(BODY, header, SECRET, { now: NOW, toleranceSeconds: 60 })).toEqual({ eventId: EVENT_ID, timestampSeconds: NOW_SECONDS - 10 });
  });

  it("rejects a malformed header", () => {
    expect(() => verifyWebhook(BODY, "not-a-real-header", SECRET, { now: NOW })).toThrow(WebhookSignatureError);
  });
});
