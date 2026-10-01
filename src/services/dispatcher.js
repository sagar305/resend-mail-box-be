import { config } from '../config.js';
import { getCollections } from '../db.js';
import { nextUtcMidnight, utcDay } from '../lib/schedule.js';
import { startBulkJob } from './bulkJobs.js';
import { clearQuotaCache } from './quota.js';
import { findDueForDispatch, handOverToResend } from './scheduled.js';

/*
 * The daily hand-over.
 *
 * Mail is booked into MongoDB and only reaches Resend on the day it goes out.
 * This is what moves it, once a day, at 00:00 UTC.
 *
 * Why that instant and not local midnight: Resend's quota is a UTC calendar day,
 * so 00:00 UTC is the moment a date's allowance resets. Running at midnight IST
 * would mean calling Resend at 18:30 UTC the day before, spending the previous
 * day's quota on the next day's mail — the exact problem booking-on-the-day is
 * meant to solve. It therefore fires at 05:30 IST, and the UI says so.
 *
 * It also sweeps on boot. A redeploy or an outage across midnight would otherwise
 * skip a day entirely, and the sweep picks up anything still pending whose day has
 * arrived or passed — including mail whose send time is already behind us, which
 * goes out at once rather than being dropped.
 */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let timer = null;
let running = false;

/**
 * Hands over everything due. Safe to call at any time and more than once: the
 * query only ever matches mail still marked pending, and a `running` guard keeps
 * the boot sweep and the midnight firing from overlapping.
 */
export async function dispatchDue({ now = new Date() } = {}) {
  if (running) return { skipped: true };
  running = true;

  const today = utcDay(now);
  const summary = { handedOver: 0, late: 0, failed: 0, jobsStarted: 0 };

  try {
    const due = await findDueForDispatch(today);
    // Each hand-over is one Resend call, so they are paced the same way bulk
    // sending is rather than fired off in a burst against the rate limit.
    const intervalMs = Math.ceil(1000 / config.bulk.sendsPerSecond);

    for (const doc of due) {
      const startedAt = Date.now();
      const result = await handOverToResend(doc, { now });

      if (result.handedOver) {
        summary.handedOver += 1;
        if (result.late) summary.late += 1;
      } else {
        // Left pending on purpose: the next sweep retries it, which is the right
        // outcome for a rate limit or a blip hours before the send time.
        summary.failed += 1;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    }

    summary.jobsStarted = await startDueBulkJobs(today);

    // Both the ledger and today's usage just moved.
    clearQuotaCache();

    if (summary.handedOver || summary.failed || summary.jobsStarted) {
      console.log(
        `Dispatch for ${today}: ${summary.handedOver} handed to Resend` +
        `${summary.late ? ` (${summary.late} late)` : ''}` +
        `${summary.failed ? `, ${summary.failed} will retry` : ''}` +
        `${summary.jobsStarted ? `, ${summary.jobsStarted} bulk send(s) started` : ''}`,
      );
    }
    return summary;
  } finally {
    running = false;
  }
}

/**
 * Releases bulk jobs whose delivery day has come. They were parked at creation
 * rather than run, so that their sends land in the right day's quota too.
 */
async function startDueBulkJobs(today) {
  const { bulkJobs } = getCollections();
  const due = await bulkJobs.find({ status: 'pending', day: { $lte: today } }).toArray();

  for (const job of due) {
    await startBulkJob(job._id);
  }
  return due.length;
}

/**
 * Sweeps now, then every midnight UTC.
 *
 * The first delay is measured to the next boundary rather than assumed, so the
 * firing lands on 00:00 whatever time the process happened to start. After that a
 * fixed 24 hours is exact, because UTC has no daylight saving to drift against.
 */
export function startDailyDispatch() {
  const armNext = () => {
    const delay = nextUtcMidnight().getTime() - Date.now();
    timer = setTimeout(async () => {
      try {
        await dispatchDue();
      } catch (error) {
        console.error(`Daily dispatch failed: ${error.message}`);
      }
      // Re-armed from the new clock rather than on a fixed interval, so a slow
      // run cannot make every later firing drift away from midnight.
      armNext();
    }, delay);
    // Node would otherwise keep the process alive purely for this timer.
    timer.unref?.();
    console.log(`Next scheduled-mail dispatch in ${Math.round(delay / 60_000)} min (00:00 UTC)`);
  };

  // Catch up before waiting for midnight: this boot may itself be the restart
  // that missed one.
  dispatchDue().catch((error) => {
    console.error(`Startup dispatch sweep failed: ${error.message}`);
  });

  armNext();
}

export function stopDailyDispatch() {
  if (timer) clearTimeout(timer);
  timer = null;
}
