import './helpers/env.js';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { useDatabase } from '../src/db.js';
import { config } from '../src/config.js';
import { utcDay } from '../src/lib/schedule.js';
import { clearQuotaCache, dailyQuota } from '../src/services/quota.js';
import { reserveSlots, slotUsage } from '../src/services/slots.js';
import { createMemoryDb } from './helpers/memoryDb.js';

/*
 * Delivery-day accounting.
 *
 * The property that matters: a schedule charges the day it goes out, so a week
 * of mail can be laid out over a weekend without the weekend refusing it. And a
 * date can never be booked past what Resend will deliver that day.
 */

const db = createMemoryDb();
const TODAY = utcDay(new Date());
const NEXT_MONDAY = '2026-12-07';
const NEXT_TUESDAY = '2026-12-08';

beforeEach(() => {
  db.reset();
  useDatabase(db);
  clearQuotaCache();
});

describe('the schedulable cap is derived from the quota', () => {
  it('leaves the reserve unbookable', () => {
    // 100 a day with 20 held back for inbound and ad-hoc mail.
    assert.equal(config.quota.dailyLimit, 100);
    assert.equal(config.quota.reserve, 20);
    assert.equal(config.scheduling.maxPerDay, 80);
  });
});

describe('scheduling charges the delivery day', () => {
  it('lets two weekdays be booked without exhausting one allowance', async () => {
    // The whole point of the change: sitting down on a weekend and laying out
    // fifty for Monday and fifty for Tuesday. Under today-based accounting the
    // second fifty would have been refused.
    await reserveSlots(NEXT_MONDAY, 50);
    await reserveSlots(NEXT_TUESDAY, 50);

    assert.equal((await slotUsage(NEXT_MONDAY)).used, 50);
    assert.equal((await slotUsage(NEXT_TUESDAY)).used, 50);
    // Neither spent anything from the day they were booked on.
    assert.equal((await slotUsage(TODAY)).used, 0);
  });

  it('refuses to book a single date past the schedulable cap', async () => {
    await reserveSlots(NEXT_MONDAY, 80);
    await assert.rejects(
      () => reserveSlots(NEXT_MONDAY, 1),
      (error) => error.code === 'schedule_limit_exceeded',
    );
  });

  it('never lets a date exceed the cap however the bookings are split', async () => {
    const attempts = [
      reserveSlots(NEXT_MONDAY, 30),
      reserveSlots(NEXT_MONDAY, 30),
      reserveSlots(NEXT_MONDAY, 30),
    ];
    await Promise.allSettled(attempts);
    assert.ok((await slotUsage(NEXT_MONDAY)).used <= config.scheduling.maxPerDay);
  });
});

describe('dailyQuota', () => {
  it('reports a future date from the ledger alone', async () => {
    await reserveSlots(NEXT_MONDAY, 50);

    const usage = await dailyQuota({ day: NEXT_MONDAY });
    assert.equal(usage.scheduled, 50);
    // Nothing can have been sent immediately on a day that has not arrived, so
    // there is nothing to ask Resend about and the figure is exact.
    assert.equal(usage.immediate, 0);
    assert.equal(usage.used, 50);
    assert.equal(usage.remaining, 50);
    assert.equal(usage.exact, true);
  });

  it('keeps the reserve visible as the gap between the cap and the limit', async () => {
    await reserveSlots(NEXT_MONDAY, 80);

    const usage = await dailyQuota({ day: NEXT_MONDAY });
    // The date is fully booked for scheduling, yet twenty of its allowance
    // remain — which is what keeps inbound mail working that day.
    assert.equal((await slotUsage(NEXT_MONDAY)).remaining, 0);
    assert.equal(usage.remaining, 20);
  });

  it('counts each date separately', async () => {
    await reserveSlots(NEXT_MONDAY, 70);
    assert.equal((await dailyQuota({ day: NEXT_TUESDAY })).used, 0);
  });

  it('caches per day rather than globally', async () => {
    await reserveSlots(NEXT_MONDAY, 10);
    const monday = await dailyQuota({ day: NEXT_MONDAY });
    const tuesday = await dailyQuota({ day: NEXT_TUESDAY });

    // A cache keyed on nothing would have handed Monday's answer back for
    // Tuesday, which is the bug this replaced.
    assert.equal(monday.used, 10);
    assert.equal(tuesday.used, 0);
  });
});
