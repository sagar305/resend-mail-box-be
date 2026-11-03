import './helpers/env.js';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { useDatabase } from '../src/db.js';
import { utcDay } from '../src/lib/schedule.js';
import { dispatchDue } from '../src/services/dispatcher.js';
import { getBulkJob } from '../src/services/bulkJobs.js';
import { getScheduled, listScheduled } from '../src/services/scheduled.js';
import { setMailSender } from '../src/services/resendClient.js';
import { reserveSlots, slotUsage } from '../src/services/slots.js';
import { createMemoryDb } from './helpers/memoryDb.js';

/*
 * The daily hand-over.
 *
 * Mail is booked into Mongo and only reaches Resend on the day it goes out, so
 * the properties worth pinning down are: nothing leaves early, everything due
 * leaves, a missed midnight still gets the mail out, and no sweep ever hands the
 * same mail over twice.
 */

const db = createMemoryDb();
const NOW = new Date('2026-10-05T00:00:00.000Z');
const TODAY = utcDay(NOW);
const TOMORROW = '2026-10-06';

let sent;

/** Writes a booked-but-not-handed-over mail, as scheduleMail would have. */
async function seedPending({ id, day, scheduledAt, status = 'pending' }) {
  await db.collection('scheduled').insertOne({
    _id: id,
    day,
    to: [`${id}@example.test`],
    cc: [],
    bcc: [],
    subject: `Subject ${id}`,
    html: `<p>Body ${id}</p>`,
    text: `Body ${id}`,
    preview: `Body ${id}`,
    attachments: [],
    scheduledAt,
    createdAt: '2026-10-01T09:00:00.000Z',
    status,
    resendId: null,
    jobId: null,
  });
}

beforeEach(() => {
  db.reset();
  useDatabase(db);
  sent = [];
  setMailSender(async (payload) => {
    sent.push(payload);
    return { id: `resend-${sent.length}` };
  });
});

describe('dispatchDue', () => {
  it('hands over mail whose delivery day has arrived', async () => {
    await reserveSlots(TODAY, 1);
    await seedPending({ id: 'a', day: TODAY, scheduledAt: '2026-10-05T11:30:00.000Z' });

    const summary = await dispatchDue({ now: NOW });

    assert.equal(summary.handedOver, 1);
    assert.equal(sent.length, 1);
    // Still a schedule as far as Resend is concerned: they hold it until 11:30.
    assert.equal(sent[0].scheduledAt, '2026-10-05T11:30:00.000Z');
    assert.equal((await getScheduled('a')).status, 'scheduled');
  });

  it('leaves a later day alone', async () => {
    await reserveSlots(TOMORROW, 1);
    await seedPending({ id: 'b', day: TOMORROW, scheduledAt: '2026-10-06T11:30:00.000Z' });

    const summary = await dispatchDue({ now: NOW });

    // The whole point of deferring: tomorrow's mail must not spend today's quota.
    assert.equal(summary.handedOver, 0);
    assert.equal(sent.length, 0);
    assert.equal((await getScheduled('b')).status, 'pending');
  });

  it('sends mail whose time already passed, and marks it late', async () => {
    // What a restart across midnight leaves behind.
    await reserveSlots(TODAY, 1);
    await seedPending({ id: 'c', day: TODAY, scheduledAt: '2026-10-05T11:30:00.000Z' });

    const summary = await dispatchDue({ now: new Date('2026-10-05T14:00:00.000Z') });

    assert.equal(summary.handedOver, 1);
    assert.equal(summary.late, 1);
    // Resend rejects a schedule in the past, so it goes out with none at all.
    assert.equal(sent[0].scheduledAt, undefined);

    const doc = await getScheduled('c');
    assert.equal(doc.status, 'sent');
    assert.equal(doc.late, true);
  });

  it('returns a late mail’s slot, so the ledger and the sent log cannot both count it', async () => {
    await reserveSlots(TODAY, 1);
    await seedPending({ id: 'd', day: TODAY, scheduledAt: '2026-10-05T11:30:00.000Z' });

    await dispatchDue({ now: new Date('2026-10-05T14:00:00.000Z') });

    // It went out with no scheduled_at, so Resend's log now counts it as an
    // immediate send; keeping the ledger slot too would double it.
    assert.equal((await slotUsage(TODAY)).used, 0);
  });

  it('keeps a slot spent when the mail is handed over on time', async () => {
    await reserveSlots(TODAY, 1);
    await seedPending({ id: 'e', day: TODAY, scheduledAt: '2026-10-05T11:30:00.000Z' });

    await dispatchDue({ now: NOW });

    // Resend has it as a schedule, which the log count skips, so the ledger is
    // the only thing accounting for it.
    assert.equal((await slotUsage(TODAY)).used, 1);
  });

  it('never hands the same mail over twice', async () => {
    await reserveSlots(TODAY, 1);
    await seedPending({ id: 'f', day: TODAY, scheduledAt: '2026-10-05T11:30:00.000Z' });

    await dispatchDue({ now: NOW });
    await dispatchDue({ now: NOW });

    // The boot sweep and the midnight firing both run; only pending mail matches.
    assert.equal(sent.length, 1);
  });

  it('leaves a mail pending when Resend refuses, so the next sweep retries it', async () => {
    setMailSender(async () => { throw new Error('Resend is having a moment'); });
    await reserveSlots(TODAY, 1);
    await seedPending({ id: 'g', day: TODAY, scheduledAt: '2026-10-05T11:30:00.000Z' });

    const summary = await dispatchDue({ now: NOW });

    assert.equal(summary.failed, 1);
    const doc = await getScheduled('g');
    assert.equal(doc.status, 'pending');
    assert.match(doc.error, /having a moment/);
  });

  it('picks up a day that was missed entirely', async () => {
    // Nothing ran on the 4th; the 5th's sweep has to catch it.
    await reserveSlots('2026-10-04', 1);
    await seedPending({ id: 'h', day: '2026-10-04', scheduledAt: '2026-10-04T11:30:00.000Z' });

    const summary = await dispatchDue({ now: NOW });

    assert.equal(summary.handedOver, 1);
    assert.equal(summary.late, 1);
  });

  it('starts a parked bulk job on its delivery day', async () => {
    await db.collection('bulkJobs').insertOne({
      _id: 'job-1',
      status: 'pending',
      subject: 'Hi {{name}}',
      html: '<p>Hello {{name}}</p>',
      text: 'Hello {{name}}',
      columns: ['name'],
      tokens: ['name'],
      scheduledAt: '2026-10-05T11:30:00.000Z',
      day: TODAY,
      attachments: [],
      totals: { total: 1, sent: 0, failed: 0 },
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
      error: null,
    });
    await db.collection('bulkRecipients').insertOne({
      _id: 'job-1:0',
      jobId: 'job-1',
      order: 0,
      email: 'person@example.test',
      vars: { name: 'Person' },
      status: 'pending',
      attempts: 0,
      resendId: null,
      error: null,
    });

    const summary = await dispatchDue({ now: NOW });
    assert.equal(summary.jobsStarted, 1);

    // The runner is started without being awaited, so let it drain.
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    assert.notEqual((await getBulkJob('job-1')).status, 'pending');
  });

  it('leaves the Scheduled folder showing both pending and handed-over mail', async () => {
    await reserveSlots(TODAY, 1);
    await reserveSlots(TOMORROW, 1);
    await seedPending({ id: 'i', day: TODAY, scheduledAt: '2026-10-05T11:30:00.000Z' });
    await seedPending({ id: 'j', day: TOMORROW, scheduledAt: '2026-10-06T11:30:00.000Z' });

    await dispatchDue({ now: NOW });

    const folder = await listScheduled();
    // One is with Resend now, one is still here — both are still "to go", which
    // is what the folder is for.
    assert.deepEqual(folder.map((mail) => mail.id).sort(), ['i', 'j']);
    assert.equal(folder.find((mail) => mail.id === 'i').handedOver, true);
    assert.equal(folder.find((mail) => mail.id === 'j').handedOver, false);
  });
});
