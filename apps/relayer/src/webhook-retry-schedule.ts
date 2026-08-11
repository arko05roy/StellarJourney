/**
 * Retry/backoff schedule for webhook delivery (CLAUDE.md §12's "retry
 * failed deliveries with exponential backoff", this phase's decision #4).
 * Mirrors `retry-schedule.ts`'s shape exactly (same `attemptCount`
 * semantics: incremented immediately before each attempt, so
 * `attemptCount === 1` after the first attempt fails looks up
 * `WEBHOOK_RETRY_DELAYS_MS[0]` for the second attempt's delay, etc.).
 *
 * Webhook receivers are expected to have brief, recoverable outages more
 * often than the relayer's own on-chain submissions do (a merchant's server
 * restarting, deploying, or hiccuping under load) — so the schedule here is
 * shorter at the start (retry fast, in case it was a blip) and longer at
 * the tail (stop hammering a receiver that's been down for a while) than
 * the charge-request schedule:
 *
 *   Attempt 1: immediately (delivery becomes due)
 *   Attempt 2: +1 minute
 *   Attempt 3: +5 minutes
 *   Attempt 4: +30 minutes
 *   Attempt 5: +2 hours
 *   Attempt 6: +6 hours
 *   Then: dead_letter
 *
 * Six total attempts spread over ~8.5 hours — generous enough to ride out a
 * typical deploy/incident window without retrying forever.
 */
const WEBHOOK_RETRY_DELAYS_MS: readonly number[] = [1, 5, 30, 120, 360].map((minutes) => minutes * 60 * 1000);

/** Total attempts the schedule allows before giving up (1 initial + 5 retries). */
export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/** Returns the timestamp of the next retry attempt, or `undefined` once the schedule is exhausted (caller must transition to `dead_letter` instead). */
export function nextWebhookRetryAt(attemptCount: number, from: Date): Date | undefined {
  const delay = WEBHOOK_RETRY_DELAYS_MS[attemptCount - 1];
  if (delay === undefined) return undefined;
  return new Date(from.getTime() + delay);
}
