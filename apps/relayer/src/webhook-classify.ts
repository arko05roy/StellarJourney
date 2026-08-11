/**
 * Webhook delivery-attempt response classification (Phase 12a task's
 * explicit requirement). Every outcome the delivery worker can observe maps
 * to exactly one of:
 *
 *   - "success": the attempt delivered — terminal `delivered`.
 *   - "retryable": worth trying again later, if attempts remain.
 *   - "permanent": will deterministically fail again — no point retrying,
 *     terminal `dead_letter` immediately regardless of remaining attempts.
 *
 * | Outcome                          | Class      |
 * | --------------------------------- | ---------- |
 * | HTTP 2xx                          | success    |
 * | HTTP 408, 429                     | retryable  |
 * | HTTP 5xx                          | retryable  |
 * | HTTP other 4xx                    | permanent  |
 * | HTTP 3xx (redirect)               | permanent  |
 * | timeout                           | retryable  |
 * | network error (DNS/connect/reset) | retryable  |
 * | SSRF guard blocked the URL        | permanent  |
 *
 * Redirects are never followed (`webhook-http.ts` sends with
 * `redirect: "manual"`) — a URL that redirects could otherwise be used to
 * bounce the request to a disallowed address *after* the SSRF check already
 * passed for the original URL, so a redirect response is treated as a
 * configuration error the merchant must fix (permanent), not retried.
 */

export type WebhookResponseClass = "success" | "retryable" | "permanent";

export type WebhookDeliveryOutcome =
  | { kind: "http"; status: number }
  | { kind: "timeout" }
  | { kind: "network_error"; message: string }
  | { kind: "redirect"; status: number; location: string | undefined }
  | { kind: "ssrf_blocked"; message: string };

export function classifyWebhookDeliveryOutcome(outcome: WebhookDeliveryOutcome): WebhookResponseClass {
  switch (outcome.kind) {
    case "timeout":
      return "retryable";
    case "network_error":
      return "retryable";
    case "redirect":
      return "permanent";
    case "ssrf_blocked":
      return "permanent";
    case "http":
      if (outcome.status >= 200 && outcome.status < 300) return "success";
      if (outcome.status === 408 || outcome.status === 429) return "retryable";
      if (outcome.status >= 500) return "retryable";
      return "permanent"; // any other 4xx (400-407, 409-428, 430-499)
  }
}

/** A short, stable reason string suitable for `WebhookDelivery.failureCode`-style logging/storage — never the raw response body (which may echo secrets back, per CLAUDE.md §12). */
export function describeWebhookDeliveryOutcome(outcome: WebhookDeliveryOutcome): string {
  switch (outcome.kind) {
    case "timeout":
      return "TIMEOUT";
    case "network_error":
      return `NETWORK_ERROR: ${outcome.message}`;
    case "redirect":
      return `REDIRECT_NOT_ALLOWED (status ${String(outcome.status)}${outcome.location ? `, location "${outcome.location}"` : ""})`;
    case "ssrf_blocked":
      return `SSRF_BLOCKED: ${outcome.message}`;
    case "http":
      return `HTTP_${String(outcome.status)}`;
  }
}
