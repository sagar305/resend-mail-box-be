import './helpers/env.js';

import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { useDatabase } from '../src/db.js';
import { getBulkJob, resumeInterruptedJobs, runJob } from '../src/services/bulkJobs.js';
import { dispatchDueExclusive } from '../src/services/dispatcher.js';
import { setMailSender } from '../src/services/resendClient.js';
import { createMemoryDb } from './helpers/memoryDb.js';

/*
 * What running on Vercel adds: several instances may reach for the same job,
 * any of them may be cut off at its time limit, and cron may fire twice. The
 * properties worth pinning down are that none of that sends anyone a mail twice
 * and that an interrupted job is always left resumable.
 */

const db = createMemoryDb();
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function seedJob({ id = 'job-1', count = 3, lease = null }) {
  await db.collection('bulkJobs').insertOne({
    _id: id,
    status: 'running',
    subject: 'Hi',
    html: '<p>Hi</p>',
    text: 'Hi',
    columns: [],
    tokens: [],
    scheduledAt: null,
    day: null,
    attachments: [],
    totals: { total: count, sent: 0, failed: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    ...(lease ? { leaseOwner: 'someone-else', leaseUntil: lease } : {}),
  });
  await db.collection('bulkRecipients').insertMany(Array.from({ length: count }, (_u, index) => ({
    _id: `${id}:${index}`,
    jobId: id,
    order: index,
    email: `p${index}@example.test`,
    vars: {},
    status: 'pending',
    attempts: 0,
    resendId: null,
    error: null,
  })));
}

const originalBudget = config.bulk.runBudgetMs;

beforeEach(() => {
  db.reset();
  useDatabase(db);
  setMailSender(async () => ({ id: `resend-${Math.random()}` }));
});

afterEach(() => {
  config.bulk.runBudgetMs = originalBudget;
});

describe('bulk job leases', () => {
  it('does not run a job another runner holds a live lease on', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    await seedJob({ lease: future });

    await runJob('job-1');
    assert.equal(await resumeInterruptedJobs(), 0);

    const job = await getBulkJob('job-1');
    assert.equal(job.totals.sent, 0);
    assert.equal(job.status, 'running');
  });

  it('takes over a job whose lease has expired and reclaims its stuck send', async () => {
    const past = new Date(Date.now() - 1_000).toISOString();
    await seedJob({ lease: past });
    await db.collection('bulkRecipients').updateOne(
      { _id: 'job-1:0' },
      { $set: { status: 'sending' } },
    );

    assert.equal(await resumeInterruptedJobs(), 1);
    await sleep(20);

    const job = await getBulkJob('job-1');
    assert.equal(job.status, 'completed');
    assert.equal(job.totals.sent, 3);
  });

  it('releases the lease when the run ends', async () => {
    await seedJob({});
    await runJob('job-1');
    const doc = await db.collection('bulkJobs').findOne({ _id: 'job-1' });
    assert.equal(doc.leaseOwner, null);
  });
});

describe('run time limit', () => {
  it('stops at a clean point and leaves the rest for the next run', async () => {
    config.bulk.runBudgetMs = 1;
    setMailSender(async () => {
      await sleep(5);
      return { id: 'resend-ok' };
    });
    await seedJob({ count: 5 });

    await runJob('job-1');

    const job = await getBulkJob('job-1', { withRecipients: true });
    assert.equal(job.status, 'running');
    assert.ok(job.totals.sent < 5);
    assert.ok(job.recipients.every((r) => r.status === 'sent' || r.status === 'pending'));
    const doc = await db.collection('bulkJobs').findOne({ _id: 'job-1' });
    assert.equal(doc.leaseOwner, null, 'lease released so the next run can start at once');

    // The next run picks up exactly the people still waiting.
    config.bulk.runBudgetMs = 0;
    await runJob('job-1');
    const finished = await getBulkJob('job-1');
    assert.equal(finished.status, 'completed');
    assert.equal(finished.totals.sent, 5);
  });
});

describe('dispatchDueExclusive', () => {
  it('skips a sweep while another holds the lock', async () => {
    await db.collection('locks').insertOne({
      _id: 'dispatch',
      until: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.deepEqual(await dispatchDueExclusive(), { skipped: true, reason: 'already running' });
  });

  it('runs and frees the lock when it is free or expired', async () => {
    await db.collection('locks').insertOne({
      _id: 'dispatch',
      until: new Date(Date.now() - 1_000).toISOString(),
    });
    const summary = await dispatchDueExclusive();
    assert.equal(summary.skipped, undefined);
    const lock = await db.collection('locks').findOne({ _id: 'dispatch' });
    assert.equal(lock.until, null);
  });
});

describe('cron routes', () => {
  let server;
  let base;

  beforeEach(async () => {
    server = http.createServer(createApp());
    await new Promise((resolve) => { server.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    config.cronSecret = null;
    await new Promise((resolve) => { server.close(resolve); });
  });

  it('are disabled until CRON_SECRET is set', async () => {
    config.cronSecret = null;
    const res = await fetch(`${base}/api/cron/resume-bulk`);
    assert.equal(res.status, 503);
  });

  it('reject a wrong secret and accept the right one', async () => {
    config.cronSecret = 'cron-secret';
    const wrong = await fetch(`${base}/api/cron/dispatch`, {
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);

    const right = await fetch(`${base}/api/cron/dispatch`, {
      headers: { authorization: 'Bearer cron-secret' },
    });
    assert.equal(right.status, 200);
    const body = await right.json();
    assert.equal(body.ok, true);
  });
});
