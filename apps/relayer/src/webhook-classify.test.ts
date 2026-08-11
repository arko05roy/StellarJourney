import { describe, expect, it } from "vitest";
import { classifyWebhookDeliveryOutcome, describeWebhookDeliveryOutcome, type WebhookDeliveryOutcome } from "./webhook-classify.js";

describe("classifyWebhookDeliveryOutcome — response classification table", () => {
  for (const status of [200, 201, 202, 204, 299]) {
    it(`HTTP ${String(status)} -> success`, () => {
      expect(classifyWebhookDeliveryOutcome({ kind: "http", status })).toBe("success");
    });
  }

  for (const status of [408, 429]) {
    it(`HTTP ${String(status)} -> retryable`, () => {
      expect(classifyWebhookDeliveryOutcome({ kind: "http", status })).toBe("retryable");
    });
  }

  for (const status of [500, 502, 503, 504, 599]) {
    it(`HTTP ${String(status)} -> retryable`, () => {
      expect(classifyWebhookDeliveryOutcome({ kind: "http", status })).toBe("retryable");
    });
  }

  for (const status of [400, 401, 403, 404, 409, 410, 422, 451]) {
    it(`HTTP ${String(status)} (non-408/429 4xx) -> permanent`, () => {
      expect(classifyWebhookDeliveryOutcome({ kind: "http", status })).toBe("permanent");
    });
  }

  it("timeout -> retryable", () => {
    expect(classifyWebhookDeliveryOutcome({ kind: "timeout" })).toBe("retryable");
  });

  it("network_error -> retryable", () => {
    expect(classifyWebhookDeliveryOutcome({ kind: "network_error", message: "ECONNREFUSED" })).toBe("retryable");
  });

  it("redirect -> permanent (never followed)", () => {
    expect(classifyWebhookDeliveryOutcome({ kind: "redirect", status: 302, location: "https://evil.example/" })).toBe("permanent");
  });

  it("ssrf_blocked -> permanent", () => {
    expect(classifyWebhookDeliveryOutcome({ kind: "ssrf_blocked", message: "blocked host" })).toBe("permanent");
  });
});

describe("describeWebhookDeliveryOutcome", () => {
  const cases: [WebhookDeliveryOutcome, RegExp][] = [
    [{ kind: "http", status: 500 }, /HTTP_500/],
    [{ kind: "timeout" }, /TIMEOUT/],
    [{ kind: "network_error", message: "boom" }, /NETWORK_ERROR.*boom/],
    [{ kind: "redirect", status: 302, location: "https://x" }, /REDIRECT_NOT_ALLOWED/],
    [{ kind: "ssrf_blocked", message: "nope" }, /SSRF_BLOCKED.*nope/],
  ];
  for (const [outcome, pattern] of cases) {
    it(`describes ${outcome.kind}`, () => {
      expect(describeWebhookDeliveryOutcome(outcome)).toMatch(pattern);
    });
  }
});
