import { config } from '../config.js';
import { ApiError } from './ApiError.js';

/*
 * Everything about the daily cap hangs off one question: which day does this
 * send belong to? The answer here is always UTC.
 *
 * Resend has no timezone of its own — `scheduled_at` is an ISO 8601 instant, and
 * their plan quota is the only thing with a day boundary at all. That boundary is
 * undocumented, but UTC midnight is what every mail platform uses and it keeps our
 * counter in step with the quota figure shown beside it. A local-midnight window
 * would put the two readouts hours out of phase, disagreeing for part of every day.
 *
 * The cost is that the cap resets at 05:30 IST, so every surface that shows a
 * remaining count also states the reset time. Confusing arithmetic beats silently
 * wrong arithmetic.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The UTC calendar day an instant falls in, as `YYYY-MM-DD`. */
export function utcDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Midnight UTC opening the day an instant falls in. */
export function startOfUtcDay(date) {
  return new Date(`${utcDay(date)}T00:00:00.000Z`);
}

/** When the current day's counters roll over — shown wherever a count is. */
export function nextUtcMidnight(now = new Date()) {
  return new Date(startOfUtcDay(now).getTime() + MS_PER_DAY);
}

/**
 * Validates a `YYYY-MM-DD` day from a query string.
 *
 * The caps are counted per delivery day, so every screen that shows a remaining
 * count has to ask about the day the mail is actually going out — not today.
 * Showing today's number while reserving another day's is how a picker promises
 * sixty free slots and then refuses the send.
 */
export function parseDayParam(value, fallback = new Date()) {
  if (value === undefined || value === null || value === '') return utcDay(fallback);

  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ApiError(422, `day must look like YYYY-MM-DD (got "${text}")`, 'validation_error');
  }
  // Catches the shapes the pattern lets through, like 2026-02-31.
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || utcDay(parsed) !== text) {
    throw new ApiError(422, `day is not a real date: "${text}"`, 'validation_error');
  }
  return text;
}

/**
 * Validates a client-supplied schedule time and returns it normalized.
 *
 * Resend accepts ISO 8601 for single sends (natural language is a broadcasts
 * feature), so an explicit offset is required rather than guessed — a bare
 * "2026-08-12T09:00" would be read as UTC and silently send 5.5 hours early for
 * a user who meant IST.
 */
export function parseScheduledAt(value, { now = new Date() } = {}) {
  if (value === undefined || value === null || value === '') return null;

  const text = String(value).trim();
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(text)) {
    throw new ApiError(
      422,
      'scheduledAt must carry a timezone, e.g. 2026-08-12T09:00:00+05:30 or 2026-08-12T03:30:00Z',
      'validation_error',
    );
  }

  const when = new Date(text);
  if (Number.isNaN(when.getTime())) {
    throw new ApiError(422, `scheduledAt is not a valid date: "${text}"`, 'validation_error');
  }
  if (when.getTime() <= now.getTime()) {
    throw new ApiError(422, 'scheduledAt must be in the future', 'validation_error');
  }

  const horizonMs = config.scheduling.maxHorizonDays * MS_PER_DAY;
  if (when.getTime() - now.getTime() > horizonMs) {
    throw new ApiError(
      422,
      `Resend will not schedule further than ${config.scheduling.maxHorizonDays} days ahead`,
      'validation_error',
    );
  }

  // Resend wants ISO 8601; toISOString normalizes any offset to UTC, which is the
  // same instant and removes one thing that can be malformed on the way out.
  return when.toISOString();
}
