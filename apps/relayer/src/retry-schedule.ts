/**
 * Retry schedule for transient failures (PLAN.md §15, the lead's decision
 * #6):
 *
 *   Attempt 1: scheduled time (the originally requested `scheduledFor`)
 *   Attempt 2: +6 hours
 *   Attempt 3: +24 hours
 *   Attempt 4: +72 hours
 *   Then: permanently_failed
 *
 * `attemptCount` is the number of attempts already made (incremented by the
 * pipeline immediately before each attempt — see `pipeline.ts`). After the
 * first attempt fails transiently, `attemptCount === 1` and the next attempt
 * is scheduled +6h out; after the second, +24h; after the third, +72h; a
 * fourth transient failure exhausts the schedule and the request is marked
 * `permanently_failed` instead of scheduling a fifth attempt.
 */
const RETRY_DELAYS_MS: readonly number[] = [6, 24, 72].map((hours) => hours * 60 * 60 * 1000);

/** Total attempts the schedule allows before giving up (1 initial + 3 retries). */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * Returns the timestamp of the next retry attempt, or `undefined` once the
 * schedule is exhausted (caller must transition to `permanently_failed`
 * instead).
 */
export function nextRetryAt(attemptCount: number, from: Date): Date | undefined {
  const delay = RETRY_DELAYS_MS[attemptCount - 1];
  if (delay === undefined) return undefined;
  return new Date(from.getTime() + delay);
}
