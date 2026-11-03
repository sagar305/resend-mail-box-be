import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getCollections } from '../db.js';
import { ApiError } from '../lib/ApiError.js';
import { runDeadline, runInBackground } from '../lib/background.js';
import { assertRecipientsResolvable, extractTokens, renderForRecipient } from '../lib/merge.js';
import { utcDay } from '../lib/schedule.js';
import { discardAttachments, loadAttachments, stageAttachments } from './attachmentStore.js';
import { assertImmediateQuota, noteImmediateSends } from './quota.js';
import { sendMail } from './resendClient.js';
import { releaseSlots, reserveSlots } from './slots.js';

/*
 * Bulk sending: one separate mail per recipient, personalized, never a shared
 * To or Bcc.
 *
 * The shape of this file is set by three constraints.
 *
 * Resend's rate limit is two requests a second, so sixty recipients take about
 * thirty seconds — far too long to hold an HTTP request open. The work happens
 * after the response, and progress is polled.
 *
 * There is no queue and no worker process. On Railway server.js is a single
 * Express app restarted on every deploy; on Vercel every request may land on a
 * different short-lived instance that is killed at its maxDuration. So the
 * state that matters lives in Mongo, a row per recipient, and an interrupted job
 * resumes from it — on boot, from the resume cron, or on the next request —
 * rather than starting over and mailing people twice.
 *
 * Because several instances may try to resume the same job, a runner first takes
 * a lease on it in Mongo. Only the lease holder sends, so the pace stays under
 * the rate limit, and holding it proves any recipient left `sending` was claimed
 * by a runner that is gone.
 *
 * And the batch endpoint is not an option here, because it drops attachments.
 * Every send goes through the single-email path, paced by hand.
 */

const MAX_ATTEMPTS_PER_RECIPIENT = 3;

/*
 * How long a runner's claim on a job lasts without renewal. It is renewed before
 * every send, and one send plus a 429 backoff is a few seconds, so a live runner
 * never comes near it. A runner that was killed simply stops renewing, and the
 * job becomes resumable this long after it died.
 */
const LEASE_MS = 90_000;

/** Jobs with a runner already attached, so a resume or a second call cannot double-send. */
const running = new Set();

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Set while the process is shutting down. The sender checks it between sends and
 * stops claiming new recipients, so a redeploy interrupts the job cleanly at a
 * recorded position instead of being cut off mid-flight.
 */
let stopping = false;
export function stopBulkSending() {
  stopping = true;
}


function toJob(doc, recipients) {
  return {
    id: doc._id,
    folder: 'bulk',
    status: doc.status,
    subject: doc.subject,
    html: doc.html,
    text: doc.text,
    columns: doc.columns ?? [],
    scheduledAt: doc.scheduledAt ?? null,
    attachmentCount: doc.attachments?.length ?? 0,
    totals: doc.totals,
    error: doc.error ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    finishedAt: doc.finishedAt ?? null,
    ...(recipients ? { recipients } : {}),
  };
}

function toRecipient(doc) {
  return {
    id: doc._id,
    email: doc.email,
    vars: doc.vars ?? {},
    status: doc.status,
    resendId: doc.resendId ?? null,
    error: doc.error ?? null,
  };
}

async function touchJob(jobId, fields) {
  const { bulkJobs } = getCollections();
  await bulkJobs.updateOne(
    { _id: jobId },
    { $set: { ...fields, updatedAt: new Date().toISOString() } },
  );
}

/**
 * Creates a job and starts it.
 *
 * The order of the checks matters. Quota is asked of Resend before anything is
 * written, because it is the check most likely to refuse and the cheapest to
 * unwind. Scheduled slots are claimed next, all or nothing — a job that only
 * half fits under the daily cap would mail some of the list and abandon the
 * rest, which is worse than refusing it outright.
 */
export async function createBulkJob({
  subject, html, text, recipients, attachments, scheduledAt, columns,
}) {
  if (!Array.isArray(recipients) || !recipients.length) {
    throw new ApiError(422, 'A bulk send needs at least one recipient', 'validation_error');
  }
  if (recipients.length > config.bulk.maxRecipients) {
    throw new ApiError(
      422,
      `${recipients.length} recipients is above the limit of ${config.bulk.maxRecipients} for one job`,
      'validation_error',
    );
  }

  // Decision: a missing merge value stops the job rather than sending a blank.
  const tokens = extractTokens(subject, html, text);
  assertRecipientsResolvable(recipients, tokens);

  /*
   * Which allowance this spends depends on when it goes out.
   *
   * A scheduled job charges its DELIVERY day, and the slot ledger is what holds
   * that date inside the quota — so laying out a week's mail over a weekend is
   * limited by each weekday's own budget, not by the weekend day it was booked on.
   *
   * An immediate job charges today, and may spend the reserve, since ad-hoc mail
   * is exactly what the reserve is held back for.
   */
  const day = scheduledAt ? utcDay(scheduledAt) : null;
  if (day) {
    await reserveSlots(day, recipients.length);
  } else {
    await assertImmediateQuota(recipients.length);
  }

  // Parked only if its day is still ahead. A job scheduled for later today has
  // already missed this morning's dispatch, and today is its right quota day
  // anyway, so it runs now and Resend holds each mail until its time.
  const parked = Boolean(day) && day > utcDay(new Date());

  const jobId = randomUUID();
  let staged = [];
  try {
    staged = await stageAttachments(jobId, attachments);

    const now = new Date().toISOString();
    const { bulkJobs, bulkRecipients } = getCollections();

    await bulkJobs.insertOne({
      _id: jobId,
      // A scheduled job is parked until its delivery day, so its sends land in
      // that day's Resend quota rather than in whichever day it was created.
      // The dispatcher releases it; anything due today runs now.
      status: parked ? 'pending' : 'running',
      subject,
      html,
      text,
      columns: columns ?? [],
      tokens,
      scheduledAt: scheduledAt ?? null,
      day,
      attachments: staged,
      totals: { total: recipients.length, sent: 0, failed: 0 },
      createdAt: now,
      updatedAt: now,
      error: null,
    });

    await bulkRecipients.insertMany(recipients.map((recipient, index) => ({
      _id: `${jobId}:${index}`,
      jobId,
      order: index,
      email: recipient.email,
      vars: recipient.vars ?? {},
      status: 'pending',
      attempts: 0,
      resendId: null,
      error: null,
    })));
  } catch (error) {
    // Nothing is sending yet, so give back anything already taken.
    if (day) await releaseSlots(day, recipients.length);
    await discardAttachments(staged);
    throw error;
  }

  // A job due today starts now, deliberately not awaited so the caller gets its
  // job id straight away and polls. A parked one waits for the dispatcher.
  if (!parked) runInBackground(runJob(jobId), `Bulk job ${jobId} failed`);

  return getBulkJob(jobId);
}

/**
 * Releases a parked job on its delivery day. Called by the dispatcher.
 *
 * Its slots were claimed when it was created, so there is nothing to re-check
 * here — only the sends themselves are still to happen.
 */
export async function startBulkJob(jobId) {
  const { bulkJobs } = getCollections();
  const claimed = await bulkJobs.findOneAndUpdate(
    // Conditional on still being pending, so two dispatch sweeps overlapping
    // cannot start the same job twice.
    { _id: jobId, status: 'pending' },
    { $set: { status: 'running', updatedAt: new Date().toISOString() } },
  );
  if (!claimed) return false;

  runInBackground(runJob(jobId), `Bulk job ${jobId} failed`);
  return true;
}

/**
 * Takes the job's lease if nobody holds a live one. `force` ignores an unexpired
 * lease: a single server that has just booted knows any lease is from the
 * process it replaced.
 */
async function acquireLease(jobId, owner, { force = false } = {}) {
  const { bulkJobs } = getCollections();
  const now = new Date();
  const free = force ? {} : {
    $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now.toISOString() } }],
  };
  const taken = await bulkJobs.findOneAndUpdate(
    { _id: jobId, status: 'running', ...free },
    {
      $set: {
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
      },
    },
  );
  return Boolean(taken);
}

/** Extends the lease; false means another runner has taken the job over. */
async function renewLease(jobId, owner) {
  const { bulkJobs } = getCollections();
  const result = await bulkJobs.updateOne(
    { _id: jobId, leaseOwner: owner },
    { $set: { leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() } },
  );
  return result.matchedCount > 0;
}

async function releaseLease(jobId, owner) {
  const { bulkJobs } = getCollections();
  await bulkJobs.updateOne(
    { _id: jobId, leaseOwner: owner },
    { $set: { leaseOwner: null, leaseUntil: null } },
  );
}

/**
 * Sends a job's remaining recipients, paced under the rate limit.
 *
 * Recipients are claimed one at a time with a conditional update, so two runners
 * could never pick up the same person — and the lease means two never run at
 * once. A recipient left in `sending` is reset as soon as the lease is held:
 * a live runner would still hold the lease, so whoever left it is gone.
 *
 * A run stops at a clean point before the function's time runs out, leaving the
 * job `running` with its remaining recipients `pending` for the next run.
 */
export async function runJob(jobId, { force = false } = {}) {
  if (running.has(jobId)) return;
  running.add(jobId);

  const { bulkJobs, bulkRecipients } = getCollections();
  const intervalMs = Math.ceil(1000 / config.bulk.sendsPerSecond);
  const stopAt = runDeadline();
  const owner = randomUUID();
  let leased = false;

  try {
    leased = await acquireLease(jobId, owner, { force });
    if (!leased) return;

    const reclaimed = await bulkRecipients.updateMany(
      { jobId, status: 'sending' },
      { $set: { status: 'pending' } },
    );
    if (reclaimed.modifiedCount) {
      console.log(`Bulk job ${jobId}: reclaimed ${reclaimed.modifiedCount} interrupted send(s)`);
    }

    const job = await bulkJobs.findOne({ _id: jobId });
    if (!job || job.status !== 'running') return;

    // Read once for the whole run rather than per recipient — see loadAttachments.
    const files = await loadAttachments(job.attachments);

    for (;;) {
      if (stopping) {
        console.log(`Bulk job ${jobId} paused for shutdown; it resumes on boot.`);
        return;
      }
      if (Date.now() >= stopAt) {
        console.log(`Bulk job ${jobId} reached this run's time limit; the next run resumes it.`);
        return;
      }
      if (!(await renewLease(jobId, owner))) {
        console.log(`Bulk job ${jobId} was taken over by another runner.`);
        return;
      }

      const claimed = await bulkRecipients.findOneAndUpdate(
        { jobId, status: 'pending' },
        { $set: { status: 'sending', claimedAt: new Date().toISOString() } },
        { returnDocument: 'after', sort: { order: 1 } },
      );
      if (!claimed) break;

      const startedAt = Date.now();
      const outcome = await sendToRecipient(job, claimed, files);

      if (outcome.retry) {
        // Put it back and wait out the limit rather than burning an attempt.
        await bulkRecipients.updateOne(
          { _id: claimed._id },
          { $set: { status: 'pending' }, $inc: { attempts: 1 } },
        );
        await sleep(config.bulk.rateLimitBackoffMs);
        continue;
      }

      if (outcome.stop) {
        // Out of quota: everything still waiting would fail the same way, so the
        // job stops with a reason rather than grinding through the rest.
        await bulkRecipients.updateOne({ _id: claimed._id }, { $set: { status: 'pending' } });
        await haltForQuota(jobId, outcome.message);
        return;
      }

      await bulkRecipients.updateOne(
        { _id: claimed._id },
        {
          $set: {
            status: outcome.sent ? 'sent' : 'failed',
            resendId: outcome.resendId ?? null,
            error: outcome.error ?? null,
            finishedAt: new Date().toISOString(),
          },
          $inc: { attempts: 1 },
        },
      );
      await bulkJobs.updateOne(
        { _id: jobId },
        {
          $inc: outcome.sent ? { 'totals.sent': 1 } : { 'totals.failed': 1 },
          $set: { updatedAt: new Date().toISOString() },
        },
      );
      // Only immediate sends are tallied here; a scheduled one was counted by
      // the ledger when its slot was reserved.
      if (outcome.sent && !job.scheduledAt) noteImmediateSends(1);

      // Pace the next send. Time already spent on this one counts toward the gap.
      const elapsed = Date.now() - startedAt;
      if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    }

    await finishJob(jobId);
  } finally {
    if (leased) {
      await releaseLease(jobId, owner).catch((error) => {
        // Not fatal: the lease expires on its own after LEASE_MS.
        console.error(`Bulk job ${jobId}: could not release lease: ${error.message}`);
      });
    }
    running.delete(jobId);
  }
}

/** One recipient's send, with the failure modes the loop needs to tell apart. */
async function sendToRecipient(job, recipient, files) {
  const rendered = renderForRecipient(job, recipient.vars);

  try {
    const { id } = await sendMail({
      to: [recipient.email],
      // A bulk send never carries cc or bcc: copying a fixed address onto every
      // one of these mails would leak the list and defeat the whole feature.
      cc: [],
      bcc: [],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: files,
      scheduledAt: job.scheduledAt ?? undefined,
    });
    return { sent: true, resendId: id };
  } catch (error) {
    if (error?.code === 'daily_quota_exceeded') {
      return { stop: true, message: error.message };
    }
    if (error?.code === 'rate_limit_exceeded' && recipient.attempts < MAX_ATTEMPTS_PER_RECIPIENT) {
      return { retry: true };
    }
    return { sent: false, error: error?.message ?? 'Send failed' };
  }
}

/**
 * Stops a job that ran into the plan's daily limit, returning any scheduled slots
 * the unsent recipients were holding. They are left `pending`, so retrying the
 * job tomorrow picks up exactly the people who did not get it.
 */
async function haltForQuota(jobId, message) {
  const { bulkJobs, bulkRecipients } = getCollections();
  const job = await bulkJobs.findOne({ _id: jobId });
  const outstanding = await bulkRecipients.countDocuments({ jobId, status: 'pending' });

  if (job?.day && outstanding > 0) await releaseSlots(job.day, outstanding);

  await touchJob(jobId, {
    status: 'halted',
    error: `${message} ${outstanding} recipient${outstanding === 1 ? '' : 's'} still to send.`,
  });
}

async function finishJob(jobId) {
  const { bulkJobs } = getCollections();
  const job = await bulkJobs.findOne({ _id: jobId });
  if (!job) return;

  // Slots were claimed for every recipient up front; anything that failed never
  // became a scheduled mail, so its slot goes back to the day.
  if (job.day && job.totals.failed > 0) await releaseSlots(job.day, job.totals.failed);

  await touchJob(jobId, {
    status: job.totals.failed === 0 ? 'completed' : 'completed_with_failures',
    finishedAt: new Date().toISOString(),
  });
  await discardAttachments(job.attachments);
}

export async function getBulkJob(jobId, { withRecipients = false } = {}) {
  const { bulkJobs, bulkRecipients } = getCollections();
  const doc = await bulkJobs.findOne({ _id: jobId });
  if (!doc) throw new ApiError(404, 'Bulk send not found', 'not_found');

  let recipients;
  if (withRecipients) {
    const docs = await bulkRecipients.find({ jobId }).sort({ order: 1 }).toArray();
    recipients = docs.map(toRecipient);
  }
  return toJob(doc, recipients);
}

export async function listBulkJobs() {
  const { bulkJobs } = getCollections();
  const docs = await bulkJobs.find({}).sort({ createdAt: -1 }).limit(50).toArray();
  return docs.map((doc) => toJob(doc));
}

/**
 * Retries just the recipients that failed. The successful ones are left alone —
 * re-running the whole job would mail them a second time.
 */
export async function retryFailedRecipients(jobId) {
  const { bulkJobs, bulkRecipients } = getCollections();
  const job = await bulkJobs.findOne({ _id: jobId });
  if (!job) throw new ApiError(404, 'Bulk send not found', 'not_found');

  const outstanding = await bulkRecipients.countDocuments({
    jobId,
    status: { $in: ['failed', 'pending'] },
  });
  if (!outstanding) {
    throw new ApiError(409, 'Nothing in this send is waiting to be retried', 'invalid_state');
  }

  // Same split as the original send: a scheduled job's retry re-books its
  // delivery day, an immediate one spends what is left of today.
  if (job.day) {
    await reserveSlots(job.day, outstanding);
  } else {
    await assertImmediateQuota(outstanding);
  }

  await bulkRecipients.updateMany(
    { jobId, status: 'failed' },
    { $set: { status: 'pending', error: null, attempts: 0 } },
  );
  await bulkJobs.updateOne(
    { _id: jobId },
    {
      $set: {
        status: 'running',
        error: null,
        'totals.failed': 0,
        updatedAt: new Date().toISOString(),
      },
    },
  );

  runInBackground(runJob(jobId), `Bulk job ${jobId} retry failed`);
  return getBulkJob(jobId);
}

/**
 * Picks up jobs that are running but have no live runner: left mid-flight by a
 * restart, or by a serverless function that hit its time limit or was killed.
 *
 * Called at boot (with `force`, since a fresh single server knows the old leases
 * are dead), by the Vercel resume cron, and opportunistically on requests. Jobs
 * whose lease is still live are skipped — their runner is working on them. The
 * runners themselves reset recipients stuck in `sending` once they hold the lease.
 */
export async function resumeInterruptedJobs({ force = false } = {}) {
  const { bulkJobs } = getCollections();
  const filter = { status: 'running' };
  if (!force) {
    filter.$or = [{ leaseUntil: null }, { leaseUntil: { $lt: new Date().toISOString() } }];
  }
  const jobs = await bulkJobs.find(filter).toArray();
  if (!jobs.length) return 0;

  for (const job of jobs) {
    runInBackground(runJob(job._id, { force }), `Bulk job ${job._id} could not resume`);
  }

  console.log(`Resuming ${jobs.length} interrupted bulk send(s)`);
  return jobs.length;
}
