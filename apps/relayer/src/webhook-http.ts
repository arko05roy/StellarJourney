/**
 * The one place that actually POSTs a signed webhook (CLAUDE.md §12, §16's
 * SSRF decision). Three things happen here, in order, and none of them is
 * optional:
 *
 *   1. Re-validate the URL with `@paymap/shared`'s `assertSafeWebhookUrl`
 *      immediately before sending — never trust that registration-time
 *      validation (`apps/api`'s `POST /v1/webhook-endpoints`) is still true;
 *      DNS can change between registration and any given delivery attempt.
 *   2. *Pin* the actual TCP connection to the exact address that check just
 *      resolved and approved, via `undici`'s `Agent({ connect: { lookup } })`
 *      — the request is still made to the original hostname (correct
 *      TLS SNI/certificate hostname, correct `Host` header), but the
 *      resolver undici uses internally to find where to connect is
 *      overridden to return only the pre-validated address. Without this,
 *      an attacker controlling DNS for the merchant's webhook domain could
 *      pass the check with a public IP and then rebind to a private one by
 *      the time the actual socket connects a few milliseconds later
 *      (classic TOCTOU/DNS-rebinding SSRF).
 *   3. Never follow a redirect (`redirect: "manual"`) — a redirect response
 *      is reported to the caller as `{kind:"redirect"}` rather than
 *      silently chased, which would otherwise let a URL that *did* pass the
 *      SSRF check bounce the request somewhere that wouldn't have.
 *
 * Signing happens here too (not one layer up) so the signed timestamp is as
 * close as possible to actual send time.
 */
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { assertSafeWebhookUrl, signWebhookPayload, UnsafeWebhookUrlError, WEBHOOK_SIGNATURE_HEADER, type HostResolver } from "@paymap/shared";
import type { WebhookDeliveryOutcome } from "./webhook-classify.js";

export interface SendWebhookInput {
  url: string;
  eventId: string;
  timestampSeconds: number;
  /** The exact bytes to send — already-serialized JSON, signed and sent verbatim (never re-serialized between signing and sending). */
  rawBody: string;
  secret: string;
  allowInsecureHttp?: boolean;
  /** Injectable DNS resolver (tests) — omitted in production, which gets a real `node:dns` lookup via `assertSafeWebhookUrl`'s own default. */
  resolveHost?: HostResolver;
  /** Test-only escape hatch — see `assertSafeWebhookUrl`'s doc. Never set outside `apps/relayer/src/test/`. */
  allowPrivateAddresses?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function pinnedDispatcher(address: string, family: 4 | 6): Dispatcher {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, address, family);
      },
    },
  });
}

/** Signs and POSTs one webhook delivery attempt. Never throws for an expected failure mode (SSRF block, timeout, network error, non-2xx, redirect) — those are all returned as a typed {@link WebhookDeliveryOutcome} for `webhook-classify.ts` to classify. Only a genuine programming error propagates. */
export async function sendWebhook(input: SendWebhookInput): Promise<WebhookDeliveryOutcome> {
  let guard;
  try {
    guard = await assertSafeWebhookUrl(input.url, {
      allowInsecureHttp: input.allowInsecureHttp ?? false,
      allowPrivateAddresses: input.allowPrivateAddresses ?? false,
      ...(input.resolveHost ? { resolveHost: input.resolveHost } : {}),
    });
  } catch (error) {
    if (error instanceof UnsafeWebhookUrlError) {
      return { kind: "ssrf_blocked", message: error.message };
    }
    throw error;
  }

  const pinned = guard.resolvedAddresses[0];
  if (!pinned) {
    // Unreachable in practice — `assertSafeWebhookUrl` never returns a
    // success with zero addresses — but never silently proceed unpinned.
    return { kind: "ssrf_blocked", message: "No resolved address available to pin the delivery connection to." };
  }

  const signatureHeader = signWebhookPayload({
    secret: input.secret,
    eventId: input.eventId,
    timestampSeconds: input.timestampSeconds,
    rawBody: input.rawBody,
  });

  const dispatcher = pinnedDispatcher(pinned.address, pinned.family);
  try {
    const response = await undiciFetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signatureHeader,
      },
      body: input.rawBody,
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      dispatcher,
    });

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "redirect", status: response.status, location: response.headers.get("location") ?? undefined };
    }

    // Drain and discard — the receiver's response body is never inspected
    // or logged (CLAUDE.md §12: a receiver's response is untrusted input
    // and must never be echoed anywhere that could leak into logs).
    await response.body?.cancel().catch(() => undefined);
    return { kind: "http", status: response.status };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { kind: "timeout" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "network_error", message };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}
