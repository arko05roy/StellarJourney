import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  WebhookSignatureError,
  parseWebhookSignatureHeader,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_VERSION,
} from "./webhook-signature.js";

const SECRET = "whsec_test_secret_value";
const EVENT_ID = "evt_" + "a".repeat(32);
const BODY = JSON.stringify({ eventId: EVENT_ID, eventType: "payment.succeeded", data: { paymentId: "pay_123" } });
const NOW = new Date("2026-07-29T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

describe("signWebhookPayload / verifyWebhookSignature round-trip", () => {
  it("a signature this module produced verifies successfully", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS, rawBody: BODY });
    const parsed = verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, now: NOW });
    expect(parsed.eventId).toBe(EVENT_ID);
    expect(parsed.timestampSeconds).toBe(NOW_SECONDS);
  });

  it("known-vector: exact digest for a fixed secret/timestamp/eventId/body", () => {
    // Recomputed independently (hex(HMAC-SHA256(secret, `${t}.${id}.${body}`)))
    // to pin the canonical-string format itself, not just internal
    // self-consistency between sign and verify.
    const header = signWebhookPayload({ secret: "known-secret", eventId: "evt_fixed", timestampSeconds: 1_700_000_000, rawBody: '{"a":1}' });
    const expected = createHmac("sha256", "known-secret").update('1700000000.evt_fixed.{"a":1}', "utf8").digest("hex");
    expect(header).toBe(`t=1700000000,id=evt_fixed,${WEBHOOK_SIGNATURE_VERSION}=${expected}`);
  });

  it("rejects a tampered body", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS, rawBody: BODY });
    const tampered = BODY.replace("payment.succeeded", "payment.failed ");
    expect(() => verifyWebhookSignature({ rawBody: tampered, header, secret: SECRET, now: NOW })).toThrow(WebhookSignatureError);
    try {
      verifyWebhookSignature({ rawBody: tampered, header, secret: SECRET, now: NOW });
    } catch (error) {
      expect((error as WebhookSignatureError).code).toBe("SIGNATURE_MISMATCH");
    }
  });

  it("rejects a wrong secret", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS, rawBody: BODY });
    expect(() => verifyWebhookSignature({ rawBody: BODY, header, secret: "wrong-secret", now: NOW })).toThrow(WebhookSignatureError);
  });

  it("rejects a stale timestamp (older than tolerance)", () => {
    const staleSeconds = NOW_SECONDS - (DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1);
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: staleSeconds, rawBody: BODY });
    expect(() => verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, now: NOW })).toThrow(WebhookSignatureError);
    try {
      verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, now: NOW });
    } catch (error) {
      expect((error as WebhookSignatureError).code).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
    }
  });

  it("rejects a future timestamp (beyond tolerance)", () => {
    const futureSeconds = NOW_SECONDS + (DEFAULT_WEBHOOK_TOLERANCE_SECONDS + 1);
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: futureSeconds, rawBody: BODY });
    expect(() => verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, now: NOW })).toThrow(WebhookSignatureError);
    try {
      verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, now: NOW });
    } catch (error) {
      expect((error as WebhookSignatureError).code).toBe("TIMESTAMP_OUT_OF_TOLERANCE");
    }
  });

  it("accepts a timestamp exactly at the tolerance boundary", () => {
    const boundarySeconds = NOW_SECONDS - DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: boundarySeconds, rawBody: BODY });
    expect(() => verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, now: NOW })).not.toThrow();
  });

  it("a custom tolerance is honored", () => {
    const header = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS - 10, rawBody: BODY });
    expect(() => verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, now: NOW, toleranceSeconds: 5 })).toThrow(WebhookSignatureError);
  });
});

describe("parseWebhookSignatureHeader", () => {
  it("rejects a header missing required fields", () => {
    expect(() => parseWebhookSignatureHeader("t=123,id=evt_1")).toThrow(WebhookSignatureError);
    expect(() => parseWebhookSignatureHeader("garbage")).toThrow(WebhookSignatureError);
  });

  it("rejects a non-integer timestamp", () => {
    expect(() => parseWebhookSignatureHeader("t=not-a-number,id=evt_1,v1=abc")).toThrow(WebhookSignatureError);
  });
});

describe("event id stability across retries", () => {
  it("the same eventId re-signed at a later timestamp produces a verifiable header carrying the identical eventId", () => {
    const firstAttempt = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: NOW_SECONDS, rawBody: BODY });
    const retryTimestamp = NOW_SECONDS + 60;
    const retryAttempt = signWebhookPayload({ secret: SECRET, eventId: EVENT_ID, timestampSeconds: retryTimestamp, rawBody: BODY });

    const parsedFirst = parseWebhookSignatureHeader(firstAttempt);
    const parsedRetry = parseWebhookSignatureHeader(retryAttempt);

    expect(parsedFirst.eventId).toBe(EVENT_ID);
    expect(parsedRetry.eventId).toBe(EVENT_ID);
    expect(parsedFirst.eventId).toBe(parsedRetry.eventId);
    // Different timestamps produce different signatures even for the same eventId/body.
    expect(parsedFirst.signature).not.toBe(parsedRetry.signature);
  });
});
