import { config } from '../config.js';
import { getCollections } from '../db.js';
import { ApiError } from '../lib/ApiError.js';
import { nextUtcMidnight, utcDay } from '../lib/schedule.js';

/*
 * The daily scheduling cap.
 *
 * Slots are reserved BEFORE the mail is handed to Resend and released if that
 * hand-off fails. Doing it the other way round — send, then count — leaves a
 * window where two composes both see 59 used and both send, putting the day at 61.
 *
 * The reservation is a single conditional $inc, so the check and the increment
 * cannot be interleaved by another request. A read-then-write pair would be
 * exactly the race this exists to prevent.
 */

/** Mongo's duplicate-key error, raised when two upserts of the same day race. */
const DUPLICATE_KEY = 11000;

/**
 * Make sure the day's counter exists so the reservation below can be a plain
 * conditional update. Upserting inside the reservation instead would insert a
 * fresh document whenever the condition failed, which is a duplicate-key error
 * rather than the "no slots left" answer we want.
 */
async function ensureCounter(day) {
  const { scheduleCounters } = getCollections();
  try {
    await scheduleCounters.updateOne(
      { _id: day },
      { $setOnInsert: { count: 0 } },
      { upsert: true },
    );
  } catch (error) {
    // Two requests creating the same day at once: one wins, the other sees this.
    // The document exists either way, which is all this function promises.
    if (error?.code !== DUPLICATE_KEY) throw error;
  }
}

/** How many slots the given UTC day has spent, and what remains. */
export async function slotUsage(day = utcDay(new Date())) {
  const { scheduleCounters } = getCollections();
  const doc = await scheduleCounters.findOne({ _id: day });
  const used = doc?.count ?? 0;
  const limit = config.scheduling.maxPerDay;
  return {
    day,
    used,
    limit,
    // A released slot can push a counter below zero only if something double
    // released; clamping keeps a display bug from becoming a phantom allowance.
    remaining: Math.max(0, limit - used),
    resetsAt: nextUtcMidnight().toISOString(),
  };
}

/**
 * Claim `count` slots on a UTC day, all or nothing.
 *
 * All-or-nothing matters for bulk: a 40-recipient job that half fits would send
 * to 25 people and abandon 15, which is worse than refusing it outright.
 *
 * Returns the usage after the claim. Throws 429 when the day cannot take them.
 */
export async function reserveSlots(day, count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`reserveSlots needs a positive integer count, got ${count}`);
  }

  const limit = config.scheduling.maxPerDay;
  if (count > limit) {
    throw new ApiError(
      429,
      `${count} scheduled emails is more than the daily limit of ${limit}.`,
      'schedule_limit_exceeded',
    );
  }

  await ensureCounter(day);

  const { scheduleCounters } = getCollections();
  const updated = await scheduleCounters.findOneAndUpdate(
    // The condition and the increment are one operation, so nothing can slip
    // between them. `$lte: limit - count` is what makes it all-or-nothing.
    { _id: day, count: { $lte: limit - count } },
    { $inc: { count } },
    { returnDocument: 'after' },
  );

  if (!updated) {
    const { remaining } = await slotUsage(day);
    throw new ApiError(
      429,
      remaining === 0
        ? `The ${limit} scheduled emails per day limit is used up for ${day} (UTC). It resets at midnight UTC.`
        : `Only ${remaining} of the ${limit} daily scheduled slots are left for ${day} (UTC); this needs ${count}.`,
      'schedule_limit_exceeded',
    );
  }

  return {
    day,
    used: updated.count,
    limit,
    remaining: Math.max(0, limit - updated.count),
    resetsAt: nextUtcMidnight().toISOString(),
  };
}

/**
 * Hand slots back — a send that Resend rejected, or a cancelled schedule.
 *
 * Guarded so a double release cannot drive the counter negative and hand out
 * slots that were never returned. Silently does nothing when the count is already
 * lower than what is being released, since the alternative — throwing inside a
 * failure path — would mask the error that got us here.
 */
export async function releaseSlots(day, count) {
  if (!Number.isInteger(count) || count < 1) return;

  const { scheduleCounters } = getCollections();
  await scheduleCounters.updateOne(
    { _id: day, count: { $gte: count } },
    { $inc: { count: -count } },
  );
}
