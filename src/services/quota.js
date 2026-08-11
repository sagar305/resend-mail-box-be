import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';
import { nextUtcMidnight, startOfUtcDay } from '../lib/schedule.js';
import { countSentSince } from './resendClient.js';

/*
 * How much of the Resend plan's daily allowance is gone.
 *
 * Resend exposes no endpoint for this — the only signal is a 429 once you are
 * already over — so the allowance itself is configured (RESEND_DAILY_QUOTA) and
 * the usage is read back from their sent log. That log is the authority: counting
 * only our own sends would miss anything else using the same API key and report
 * a number that is too low, which is the failure mode that matters, because it
 * approves work Resend then refuses.
 *
 * Cached briefly so a composer polling the meter does not spend the rate limit
 * on it, and refreshed on demand before a bulk job decides whether it fits.
 */

const CACHE_TTL_MS = 30_000;

let cache = null;

export function clearQuotaCache() {
  cache = null;
}

async function readUsage() {
  const windowStart = startOfUtcDay(new Date());
  const { count, complete } = await countSentSince(windowStart);
  return {
    used: count,
    limit: config.quota.dailyLimit,
    remaining: Math.max(0, config.quota.dailyLimit - count),
    // False when the walk hit its page ceiling with the day still open, so `used`
    // is a floor. Callers must not treat the remainder as spendable.
    exact: complete,
    resetsAt: nextUtcMidnight().toISOString(),
    windowStart: windowStart.toISOString(),
  };
}

/**
 * Current usage. Pass `{ fresh: true }` where the answer decides whether mail
 * goes out — a 30-second-old number is fine for a meter, not for a gate.
 */
export async function dailyQuota({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const value = await readUsage();
  cache = { at: now, value };
  return value;
}

/**
 * Record sends we just made so the meter moves immediately rather than waiting
 * for the cache to lapse. Only ever adjusts upward — an optimistic count that
 * reads slightly high is safe, one that reads low is what causes rejected jobs.
 */
export function noteSends(count) {
  if (!cache || !Number.isInteger(count) || count < 1) return;
  const used = cache.value.used + count;
  cache.value = {
    ...cache.value,
    used,
    remaining: Math.max(0, cache.value.limit - used),
  };
}

/**
 * Refuses work that would not fit in what is left of the plan's day.
 *
 * Sending until Resend says no would leave a job half delivered and a person
 * reading a report to find out — so the check happens up front, against a figure
 * reconciled with Resend rather than our own tally. When the count is known to be
 * a floor the check still runs, since a floor over the limit is over the limit.
 */
export async function assertQuotaFor(count) {
  const usage = await dailyQuota({ fresh: true });
  if (count <= usage.remaining) return usage;

  throw new ApiError(
    429,
    `This needs ${count} sends but only ${usage.remaining} of the ${usage.limit} daily Resend ` +
    `emails are left${usage.exact ? '' : ' (at least — the count could not be fully read)'}. ` +
    'The allowance resets at midnight UTC.',
    'daily_quota_exceeded',
  );
}
