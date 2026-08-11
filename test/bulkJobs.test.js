import './helpers/env.js';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { useDatabase } from '../src/db.js';
import { ApiError } from '../src/lib/ApiError.js';
import {
  getBulkJob,
  resumeInterruptedJobs,
  runJob,
  setBulkSender,
} from '../src/services/bulkJobs.js';
import { reserveSlots, slotUsage } from '../src/services/slots.js';
import { createMemoryDb } from './helpers/memoryDb.js';

/*
 * Exercises the sending loop itself — claiming, pacing, partial failure, quota
 * halts and resuming — with the Resend call swapped out. That loop is the part
 * of the feature a person would find out about by reading a job report, so it is
 * the part worth pinning down.
 */

const db = createMemoryDb();
const DAY = '2026-08-11';

/** Writes a job straight to the database, as createBulkJob would have. */
async function seedJob({ id = 'job-1', recipients, scheduledAt = null, day = null }) {
  const { bulkJobs, bulkRecipients } = db;
  await db.collection('bulkJobs').insertOne({
    _id: id,
    status: 'running',
    subject: 'Hi {{name}}',
    html: '<p>Hello {{name}}</p>',
    text: 'Hello {{name}}',
    columns: ['name'],
    tokens: ['name'],
    scheduledAt,
    day,
    attachments: [],
    totals: { total: recipients.length, sent: 0, failed: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
  });
  await db.collection('bulkRecipients').insertMany(recipients.map((recipient, index) => ({
    _id: `${id}:${index}`,
    jobId: id,
    order: index,
    email: recipient.email,
    vars: recipient.vars ?? {},
    status: recipient.status ?? 'pending',
    attempts: 0,
    resendId: null,
    error: null,
  })));
  return { bulkJobs, bulkRecipients };
}

const rows = (count) => Array.from({ length: count }, (_unused, index) => ({
  email: `person${index}@example.test`,
  vars: { name: `Person ${index}` },
}));

beforeEach(() => {
  db.reset();
  useDatabase(db);
  setBulkSender(async () => ({ id: `resend-${Math.random()}` }));
});

describe('runJob', () => {
  it('sends one separate mail per recipient', async () => {
    const sent = [];
    setBulkSender(async (payload) => {
      sent.push(payload);
      return { id: `resend-${sent.length}` };
    });

    await seedJob({ recipients: rows(3) });
    await runJob('job-1');

    assert.equal(sent.length, 3);
    // The point of the feature: three mails, each addressed to one person.
    assert.deepEqual(sent.map((mail) => mail.to), [
      ['person0@example.test'],
      ['person1@example.test'],
      ['person2@example.test'],
    ]);
  });

  it('never puts a cc or bcc on a bulk mail', async () => {
    const sent = [];
    setBulkSender(async (payload) => {
      sent.push(payload);
      return { id: 'resend-1' };
    });

    await seedJob({ recipients: rows(2) });
    await runJob('job-1');

    // A shared cc would leak the whole list, which is the thing this feature
    // exists to avoid.
    assert.ok(sent.every((mail) => mail.cc.length === 0 && mail.bcc.length === 0));
  });

  it('personalizes each mail from that row', async () => {
    const sent = [];
    setBulkSender(async (payload) => {
      sent.push(payload);
      return { id: 'resend-1' };
    });

    await seedJob({
      recipients: [
        { email: 'a@example.test', vars: { name: 'Ana' } },
        { email: 'b@example.test', vars: { name: 'Ben' } },
      ],
    });
    await runJob('job-1');

    assert.equal(sent[0].subject, 'Hi Ana');
    assert.equal(sent[1].subject, 'Hi Ben');
    assert.equal(sent[0].html, '<p>Hello Ana</p>');
  });

  it('marks the job completed and counts what was sent', async () => {
    await seedJob({ recipients: rows(4) });
    await runJob('job-1');

    const job = await getBulkJob('job-1');
    assert.equal(job.status, 'completed');
    assert.equal(job.totals.sent, 4);
    assert.equal(job.totals.failed, 0);
  });

  it('records a per-recipient failure without abandoning the rest', async () => {
    setBulkSender(async ({ to }) => {
      if (to[0] === 'person1@example.test') throw new ApiError(422, 'Invalid recipient');
      return { id: 'resend-ok' };
    });

    await seedJob({ recipients: rows(3) });
    await runJob('job-1');

    const job = await getBulkJob('job-1', { withRecipients: true });
    assert.equal(job.status, 'completed_with_failures');
    assert.equal(job.totals.sent, 2);
    assert.equal(job.totals.failed, 1);

    const failed = job.recipients.find((recipient) => recipient.status === 'failed');
    assert.equal(failed.email, 'person1@example.test');
    assert.match(failed.error, /Invalid recipient/);
  });

  it('stops the job when Resend reports the daily quota is gone', async () => {
    let calls = 0;
    setBulkSender(async () => {
      calls += 1;
      if (calls > 2) throw new ApiError(429, 'Daily quota reached', 'daily_quota_exceeded');
      return { id: `resend-${calls}` };
    });

    await seedJob({ recipients: rows(10) });
    await runJob('job-1');

    const job = await getBulkJob('job-1', { withRecipients: true });
    assert.equal(job.status, 'halted');
    assert.equal(job.totals.sent, 2);
    // Everything unsent stays pending, so a retry tomorrow picks up exactly the
    // people who did not get it — rather than mailing the first two again.
    const pending = job.recipients.filter((recipient) => recipient.status === 'pending');
    assert.equal(pending.length, 8);
    assert.match(job.error, /8 recipients still to send/);
  });

  it('retries a rate-limited recipient rather than failing them', async () => {
    let attempts = 0;
    setBulkSender(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError(429, 'Too many requests', 'rate_limit_exceeded');
      return { id: 'resend-ok' };
    });

    await seedJob({ recipients: rows(1) });
    await runJob('job-1');

    const job = await getBulkJob('job-1');
    assert.equal(job.totals.sent, 1);
    assert.equal(job.totals.failed, 0);
    assert.equal(attempts, 2);
  });

  it('gives back the scheduled slots of recipients that failed', async () => {
    setBulkSender(async ({ to }) => {
      if (to[0] === 'person0@example.test') throw new ApiError(422, 'Invalid recipient');
      return { id: 'resend-ok' };
    });

    await reserveSlots(DAY, 3);
    await seedJob({ recipients: rows(3), scheduledAt: '2026-08-11T18:00:00.000Z', day: DAY });
    await runJob('job-1');

    // Two mails are actually scheduled, so only two slots stay spent.
    assert.equal((await slotUsage(DAY)).used, 2);
  });

  it('passes the schedule time through to every mail in a scheduled job', async () => {
    const sent = [];
    setBulkSender(async (payload) => {
      sent.push(payload);
      return { id: 'resend-1' };
    });

    await seedJob({ recipients: rows(2), scheduledAt: '2026-08-11T18:00:00.000Z', day: DAY });
    await runJob('job-1');

    assert.ok(sent.every((mail) => mail.scheduledAt === '2026-08-11T18:00:00.000Z'));
  });
});

describe('resumeInterruptedJobs', () => {
  it('reclaims recipients left mid-send by a restart', async () => {
    const sent = [];
    setBulkSender(async (payload) => {
      sent.push(payload.to[0]);
      return { id: 'resend-ok' };
    });

    // What a SIGTERM between claim and send leaves behind: one recipient marked
    // sending by a process that no longer exists.
    await seedJob({
      recipients: [
        { email: 'a@example.test', vars: { name: 'Ana' }, status: 'sent' },
        { email: 'b@example.test', vars: { name: 'Ben' }, status: 'sending' },
        { email: 'c@example.test', vars: { name: 'Cal' }, status: 'pending' },
      ],
    });

    await resumeInterruptedJobs();
    // The resumed runner is started without being awaited, so let it drain.
    await new Promise((resolve) => { setTimeout(resolve, 50); });

    // The interrupted one is retried and the untouched one still goes; the
    // already-sent recipient is not mailed a second time.
    assert.deepEqual(sent.sort(), ['b@example.test', 'c@example.test']);
  });

  it('does nothing when no job was interrupted', async () => {
    assert.equal(await resumeInterruptedJobs(), 0);
  });
});
