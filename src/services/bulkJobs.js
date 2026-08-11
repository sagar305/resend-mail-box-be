import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getCollections } from '../db.js';
import { ApiError } from '../lib/ApiError.js';
import { assertRecipientsResolvable, extractTokens, renderForRecipient } from '../lib/merge.js';
import { utcDay } from '../lib/schedule.js';
import { discardAttachments, loadAttachments, stageAttachments } from './bulkAttachments.js';
import { assertQuotaFor, noteSends } from './quota.js';
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
 * There is no queue and no worker process: server.js is a single Express app
 * that Railway restarts on every deploy. So the state that matters lives in
 * Mongo, a row per recipient, and an interrupted job resumes from it on boot
 * rather than starting over and mailing people twice.
 *
 * And the batch endpoint is not an option here, because it drops attachments.
 * Every send goes through the single-email path, paced by hand.
 */

const MAX_ATTEMPTS_PER_RECIPIENT = 3;

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

/**
 * The function used to put one mail on the wire. Swappable so the loop's own
 * behaviour — pacing, claiming, retrying, halting — can be tested without
 * reaching Resend, which is the part of this file most worth testing and the
 * part hardest to reach otherwise.
 */
let sender = sendMail;
export function setBulkSender(fn) {
  sender = fn ?? sendMail;
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

  // Every recipient is a separate send, so the job costs one Resend email each
  // way. This is checked for scheduled jobs too: the API calls are made now, and
  // whether Resend bills the quota at call time or delivery time is not
  // documented, so the conservative reading is the safe one.
  await assertQuotaFor(recipients.length);

  const day = scheduledAt ? utcDay(scheduledAt) : null;
  if (day) await reserveSlots(day, recipients.length);

  const jobId = randomUUID();
  let staged = [];
  try {
    staged = await stageAttachments(jobId, attachments);

    const now = new Date().toISOString();
    const { bulkJobs, bulkRecipients } = getCollections();

    await bulkJobs.insertOne({
      _id: jobId,
      status: 'running',
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

  // Deliberately not awaited: the caller gets its job id straight away and polls.
  runJob(jobId).catch((error) => {
    console.error(`Bulk job ${jobId} failed: ${error.message}`);
  });

  return getBulkJob(jobId);
}

/**
 * Sends a job's remaining recipients, paced under the rate limit.
 *
 * Recipients are claimed one at a time with a conditional update, so a resumed
 * runner and a live one can never pick up the same person. A claim that is left
 * in `sending` by a crash is reset on boot rather than here — from inside the
 * process there is no way to tell a stalled claim from one in flight.
 */
export async function runJob(jobId) {
  if (running.has(jobId)) return;
  running.add(jobId);

  const { bulkJobs, bulkRecipients } = getCollections();
  const intervalMs = Math.ceil(1000 / config.bulk.sendsPerSecond);

  try {
    const job = await bulkJobs.findOne({ _id: jobId });
    if (!job || job.status !== 'running') return;

    // Read once for the whole run rather than per recipient — see loadAttachments.
    const files = await loadAttachments(job.attachments);

    for (;;) {
      if (stopping) {
        console.log(`Bulk job ${jobId} paused for shutdown; it resumes on boot.`);
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
      if (outcome.sent) noteSends(1);

      // Pace the next send. Time already spent on this one counts toward the gap.
      const elapsed = Date.now() - startedAt;
      if (elapsed < intervalMs) await sleep(intervalMs - elapsed);
    }

    await finishJob(jobId);
  } finally {
    running.delete(jobId);
  }
}

/** One recipient's send, with the failure modes the loop needs to tell apart. */
async function sendToRecipient(job, recipient, files) {
  const rendered = renderForRecipient(job, recipient.vars);

  try {
    const { id } = await sender({
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

  await assertQuotaFor(outstanding);
  if (job.day) await reserveSlots(job.day, outstanding);

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

  runJob(jobId).catch((error) => {
    console.error(`Bulk job ${jobId} retry failed: ${error.message}`);
  });
  return getBulkJob(jobId);
}

/**
 * Picks up jobs left mid-flight by a restart.
 *
 * Anything stuck in `sending` was claimed by a process that is gone, so it never
 * completed and is safe to hand out again — the claim is what makes that
 * knowable. Called once at boot, after the database connects.
 */
export async function resumeInterruptedJobs() {
  const { bulkJobs, bulkRecipients } = getCollections();
  const jobs = await bulkJobs.find({ status: 'running' }).toArray();
  if (!jobs.length) return 0;

  for (const job of jobs) {
    const reclaimed = await bulkRecipients.updateMany(
      { jobId: job._id, status: 'sending' },
      { $set: { status: 'pending' } },
    );
    if (reclaimed.modifiedCount) {
      console.log(`Bulk job ${job._id}: reclaimed ${reclaimed.modifiedCount} interrupted send(s)`);
    }
    runJob(job._id).catch((error) => {
      console.error(`Bulk job ${job._id} could not resume: ${error.message}`);
    });
  }

  console.log(`Resumed ${jobs.length} interrupted bulk send(s)`);
  return jobs.length;
}
