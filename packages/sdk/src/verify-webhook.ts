/**
 * Webhook signature verification (this phase's decision #9 — "the
 * security-critical function in the package; test it hard"). A thin,
 * SDK-shaped wrapper over `@paymap/shared`'s `verifyWebhookSignature` — the
 * exact same canonical-string/HMAC logic the delivery worker
 * (`apps/relayer`) signs with, imported rather than re-implemented
 * (CLAUDE.md §20; also the reason a signature bug can never silently drift
 * between signer and verifier).
 */
import { verifyWebhookSignature, WebhookSignatureError, type ParsedWebhookSignatureHeader } from "@paymap/shared";

export { WebhookSignatureError };

export interface VerifyWebhookOptions {
  /** Replay-protection window in seconds (both directions). Default 300 (5 minutes). */
  toleranceSeconds?: number;
  /** Injectable clock — tests only; defaults to the real wall clock. */
  now?: Date;
}

export interface VerifiedWebhook {
  eventId: string;
  timestampSeconds: number;
}

/**
 * Verifies a received webhook. `payload` must be the **exact raw request
 * body bytes as a string** — not a re-serialized `JSON.stringify` of a
 * parsed object, which can differ in whitespace/key order and would make a
 * genuinely valid signature appear invalid. `signature` is the raw value of
 * the `Paymap-Signature` header.
 *
 * @example
 * ```ts
 * import { verifyWebhook, WebhookSignatureError } from "@paymap/sdk";
 *
 * // Express: `app.post(..., express.text({ type: "*\/*" }), handler)` so
 * // `req.body` is the raw string, not pre-parsed JSON.
 * try {
 *   const { eventId } = verifyWebhook(req.body, req.header("Paymap-Signature")!, process.env.WEBHOOK_SECRET!);
 *   const event = JSON.parse(req.body);
 *   // ... handle event, deduping on `eventId` (stable across retries) ...
 * } catch (error) {
 *   if (error instanceof WebhookSignatureError) {
 *     return res.status(400).send(`invalid webhook signature: ${error.code}`);
 *   }
 *   throw error;
 * }
 * ```
 *
 * Throws {@link WebhookSignatureError} (with a specific `.code`:
 * `"MALFORMED_HEADER"`, `"TIMESTAMP_OUT_OF_TOLERANCE"`, or
 * `"SIGNATURE_MISMATCH"`) on any verification failure — never returns a
 * falsy value for "invalid", so a caller can't accidentally forget to
 * check a boolean.
 */
export function verifyWebhook(payload: string, signature: string, secret: string, options: VerifyWebhookOptions = {}): VerifiedWebhook {
  const parsed: ParsedWebhookSignatureHeader = verifyWebhookSignature({
    rawBody: payload,
    header: signature,
    secret,
    ...(options.toleranceSeconds !== undefined ? { toleranceSeconds: options.toleranceSeconds } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { eventId: parsed.eventId, timestampSeconds: parsed.timestampSeconds };
}
