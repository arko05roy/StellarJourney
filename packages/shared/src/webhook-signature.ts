/**
 * Webhook HMAC-SHA256 signing/verification (CLAUDE.md §12, PLAN.md §14).
 * The single source of truth for the canonical string both the delivery
 * worker (`apps/relayer`, signs) and the merchant SDK (`packages/sdk`,
 * verifies) use — a signer/verifier pair defined in two places is exactly
 * the kind of duplicated business rule CLAUDE.md §20 forbids, so both sides
 * import this module rather than re-implementing the scheme.
 *
 * ## Scheme (documented in full in `docs/merchant-api.md`)
 *
 * Canonical string: `${unixTimestampSeconds}.${eventId}.${rawBodyString}`
 * Signature: hex(HMAC-SHA256(merchantWebhookSecret, canonicalString))
 * Header (`Paymap-Signature`): `t=<timestamp>,id=<eventId>,v1=<hex signature>`
 *
 * Including the timestamp in the signed material (not just as an
 * unauthenticated header) is what makes replay protection possible — a
 * captured request can't be re-sent later with a forged fresh timestamp
 * without also forging a valid signature for it. Including the event id
 * binds the signature to *this* event, not just "a" valid signature from
 * this secret at this timestamp.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "Paymap-Signature";
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/** Default replay-protection window: a timestamp more than this many seconds away from "now" (past or future) is rejected. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export class WebhookSignatureError extends Error {
  readonly code: "MALFORMED_HEADER" | "TIMESTAMP_OUT_OF_TOLERANCE" | "SIGNATURE_MISMATCH";

  constructor(code: WebhookSignatureError["code"], message: string) {
    super(message);
    this.name = "WebhookSignatureError";
    this.code = code;
  }
}

function canonicalString(timestampSeconds: number, eventId: string, rawBody: string): string {
  return `${String(timestampSeconds)}.${eventId}.${rawBody}`;
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

export interface SignWebhookInput {
  secret: string;
  eventId: string;
  /** Unix seconds. */
  timestampSeconds: number;
  /** The exact bytes that will be sent as the HTTP body — sign the literal string, never a re-serialization of it. */
  rawBody: string;
}

/** Builds the `Paymap-Signature` header value for a given event + body. */
export function signWebhookPayload(input: SignWebhookInput): string {
  const digest = hmacHex(input.secret, canonicalString(input.timestampSeconds, input.eventId, input.rawBody));
  return `t=${String(input.timestampSeconds)},id=${input.eventId},${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}

export interface ParsedWebhookSignatureHeader {
  timestampSeconds: number;
  eventId: string;
  /** Hex-encoded HMAC-SHA256 digest under the `v1` scheme. */
  signature: string;
}

/** Parses (without verifying) a `Paymap-Signature` header value into its `t`/`id`/`v1` fields. */
export function parseWebhookSignatureHeader(header: string): ParsedWebhookSignatureHeader {
  const fields = new Map<string, string>();
  for (const segment of header.split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) {
      throw new WebhookSignatureError("MALFORMED_HEADER", `Malformed "${WEBHOOK_SIGNATURE_HEADER}" segment (expected "key=value"): "${segment}"`);
    }
    fields.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }
  const t = fields.get("t");
  const id = fields.get("id");
  const v1 = fields.get(WEBHOOK_SIGNATURE_VERSION);
  if (!t || !id || !v1) {
    throw new WebhookSignatureError(
      "MALFORMED_HEADER",
      `"${WEBHOOK_SIGNATURE_HEADER}" header is missing required "t"/"id"/"${WEBHOOK_SIGNATURE_VERSION}" fields.`,
    );
  }
  const timestampSeconds = Number(t);
  if (!Number.isInteger(timestampSeconds)) {
    throw new WebhookSignatureError("MALFORMED_HEADER", `"${WEBHOOK_SIGNATURE_HEADER}" header's "t" field is not a valid integer: "${t}".`);
  }
  return { timestampSeconds, eventId: id, signature: v1 };
}

export interface VerifyWebhookSignatureInput {
  /** The exact raw HTTP body bytes received, as a string — never a re-serialized/re-parsed form. */
  rawBody: string;
  header: string;
  secret: string;
  /** Replay-protection window in seconds (both directions). Defaults to {@link DEFAULT_WEBHOOK_TOLERANCE_SECONDS}. */
  toleranceSeconds?: number;
  /** Injectable clock for tests. Defaults to the real wall clock. */
  now?: Date;
}

/**
 * Verifies a received webhook's signature and timestamp freshness.
 * Constant-time signature comparison (`node:crypto`'s `timingSafeEqual`) —
 * never a `===`/substring check, which would leak how many leading bytes of
 * the digest matched via response-timing. Throws {@link WebhookSignatureError}
 * with a specific `code` on any failure; returns the parsed header fields on
 * success.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): ParsedWebhookSignatureHeader {
  const parsed = parseWebhookSignatureHeader(input.header);

  const tolerance = input.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - parsed.timestampSeconds) > tolerance) {
    throw new WebhookSignatureError(
      "TIMESTAMP_OUT_OF_TOLERANCE",
      `Webhook timestamp ${String(parsed.timestampSeconds)} is outside the ${String(tolerance)}s tolerance window (server time ${String(nowSeconds)}).`,
    );
  }

  const expectedHex = hmacHex(input.secret, canonicalString(parsed.timestampSeconds, parsed.eventId, input.rawBody));
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(parsed.signature, "hex");
  // Length compared first (cheap, and digest length is not secret-dependent
  // — both sides always produce a 32-byte SHA-256 digest for any
  // well-formed input); only equal-length buffers ever reach
  // `timingSafeEqual`, which itself throws on a length mismatch.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new WebhookSignatureError("SIGNATURE_MISMATCH", "Webhook signature does not match the expected value for this secret.");
  }

  return parsed;
}
