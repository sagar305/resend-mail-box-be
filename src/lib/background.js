import { getDeadline, waitUntil } from '@vercel/functions';
import { config } from '../config.js';

/*
 * Work that continues after the response.
 *
 * On a long-lived server a promise left running simply runs. On Vercel the
 * function is frozen the moment it has answered, and an un-awaited promise would
 * stall mid-send. waitUntil() asks Vercel to keep the invocation alive until the
 * promise settles (up to the function's maxDuration). Off Vercel it has no
 * request context and does nothing, so the same call is correct on Railway.
 */
export function runInBackground(promise, label) {
  const guarded = promise.catch((error) => {
    console.error(`${label}: ${error?.message ?? error}`);
  });
  try {
    waitUntil(guarded);
  } catch {
    // No request context (boot, tests): the promise just runs.
  }
  return guarded;
}

// Room for one more send, including a 429 backoff, after the last check.
const SAFETY_MARGIN_MS = 20_000;

/**
 * The time after which a long-running loop should stop at a clean point, as a
 * millisecond timestamp, or Infinity when nothing will cut it off.
 *
 * Takes the earlier of Vercel's own deadline for this invocation, where it is
 * known, and the configured budget, which is what applies when it is not.
 */
export function runDeadline(startedAt = Date.now()) {
  const limits = [];
  try {
    const deadline = getDeadline();
    if (deadline) limits.push(deadline.getTime() - SAFETY_MARGIN_MS);
  } catch {
    // Not inside a Vercel invocation.
  }
  if (config.bulk.runBudgetMs) limits.push(startedAt + config.bulk.runBudgetMs);
  return limits.length ? Math.min(...limits) : Infinity;
}
