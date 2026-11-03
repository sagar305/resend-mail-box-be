import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';
import { nextUtcMidnight, startOfUtcDay, utcDay } from '../lib/schedule.js';
import { countImmediateSentSince } from './resendClient.js';
import { slotUsage } from './slots.js';

/*
 * How much of a given date's Resend allowance is committed.
 *
 * Accounted per DELIVERY day, not per the day the API call was made. That is what
 * lets a week of mail be laid out over a weekend: fifty for Monday and fifty for
 * Tuesday, booked on Saturday, charge Monday and Tuesday rather than exhausting
 * Saturday.
 *
 * Two sources, deliberately disjoint:
 *
 *   scheduled  — the ledger, keyed by delivery day. Authoritative, and the only
 *                thing that can know about a date that has not arrived yet.
 *   immediate  — Resend's own sent log, counting only mail with no scheduled_at.
 *                Asking Resend rather than tallying our own sends is what closes
 *                the gap if the API key is used anywhere else.
 *
 * The exclusion of scheduled mail from the log count is what keeps them from
 * overlapping: a scheduled mail is in the ledger under the day it goes out, and
 * in the log under the day it was created. Counting both would charge it twice.
 *
 * Received mail also spends the quota, one apiece, and is not counted here. The
 * reserve exists to absorb it — see config.quota.reserve.
 */

const CACHE_TTL_MS = 30_000;

/** Keyed by day: a future date's answer does not change when today's does. */
const cache = new Map();

export function clearQuotaCache() {
  cache.clear();
}

/**
 * Immediate sends only ever land on the day they are made, so a date other than
 * today has none — and there is nothing to ask Resend about.
 */
async function immediateUsage(day) {
  if (day !== utcDay(new Date())) return { count: 0, complete: true };
  return countImmediateSentSince(startOfUtcDay(new Date()));
}

async function readUsage(day) {
  const [scheduled, immediate] = await Promise.all([slotUsage(day), immediateUsage(day)]);

  const used = scheduled.used + immediate.count;
  return {
    day,
    limit: config.quota.dailyLimit,
    reserve: config.quota.reserve,
    scheduled: scheduled.used,
    immediate: immediate.count,
    used,
    remaining: Math.max(0, config.quota.dailyLimit - used),
    // False when the log walk hit its page ceiling, so `immediate` is a floor and
    // the remainder must not be treated as fully spendable.
    exact: immediate.complete,
    resetsAt: nextUtcMidnight().toISOString(),
  };
}

/**
 * A date's committed usage. Pass `{ fresh: true }` where the answer decides
 * whether mail goes out — a 30-second-old number is fine for a meter, not a gate.
 */
export async function dailyQuota({ day = utcDay(new Date()), fresh = false } = {}) {
  const now = Date.now();
  const held = cache.get(day);
  if (!fresh && held && now - held.at < CACHE_TTL_MS) return held.value;

  const value = await readUsage(day);
  cache.set(day, { at: now, value });
  return value;
}

/**
 * Record sends just made so a meter moves without waiting for the cache to lapse.
 *
 * Only ever adjusts upward, and only the immediate tally: a scheduled send is
 * already counted by the ledger the moment its slot is reserved, so adding it
 * here as well would double it.
 */
export function noteImmediateSends(count) {
  if (!Number.isInteger(count) || count < 1) return;
  const day = utcDay(new Date());
  const held = cache.get(day);
  if (!held) return;

  const immediate = held.value.immediate + count;
  const used = held.value.scheduled + immediate;
  held.value = {
    ...held.value,
    immediate,
    used,
    remaining: Math.max(0, held.value.limit - used),
  };
}

/**
 * Refuses an immediate send that would not fit in what is left of today.
 *
 * Immediate sends may spend the reserve — that is what it is for. Only scheduling
 * is held to the lower per-date cap, which the slot ledger enforces.
 *
 * Checked up front rather than discovered mid-flight: sending until Resend says
 * no leaves a job half delivered and a person reading a report to find out.
 */
export async function assertImmediateQuota(count) {
  const usage = await dailyQuota({ fresh: true });
  if (count <= usage.remaining) return usage;

  const committed = usage.scheduled > 0
    ? ` ${usage.scheduled} of today's allowance is already committed to scheduled mail.`
    : '';

  throw new ApiError(
    429,
    `This needs ${count} sends but only ${usage.remaining} of today's ${usage.limit} Resend ` +
    `emails are left${usage.exact ? '' : ' (at least — the count could not be fully read)'}.` +
    `${committed} The allowance resets at midnight UTC.`,
    'daily_quota_exceeded',
  );
}
