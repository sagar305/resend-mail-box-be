import './helpers/env.js';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { useDatabase } from '../src/db.js';
import { ApiError } from '../src/lib/ApiError.js';
import { releaseSlots, reserveSlots, slotUsage } from '../src/services/slots.js';
import { createMemoryDb } from './helpers/memoryDb.js';

const DAY = '2026-08-11';
const LIMIT = 60;

const db = createMemoryDb();

beforeEach(() => {
  db.reset();
  useDatabase(db);
});

describe('slotUsage', () => {
  it('reports a full allowance on a day nothing has touched', async () => {
    const usage = await slotUsage(DAY);
    assert.equal(usage.used, 0);
    assert.equal(usage.remaining, LIMIT);
    assert.equal(usage.limit, LIMIT);
  });

  it('states when the count resets, since the boundary is not local midnight', async () => {
    const usage = await slotUsage(DAY);
    assert.match(usage.resetsAt, /T00:00:00\.000Z$/);
  });
});

describe('reserveSlots', () => {
  it('claims a single slot and reports what is left', async () => {
    const usage = await reserveSlots(DAY, 1);
    assert.equal(usage.used, 1);
    assert.equal(usage.remaining, LIMIT - 1);
  });

  it('accumulates across separate claims', async () => {
    await reserveSlots(DAY, 10);
    await reserveSlots(DAY, 5);
    assert.equal((await slotUsage(DAY)).used, 15);
  });

  it('keeps days independent', async () => {
    await reserveSlots(DAY, LIMIT);
    const other = await reserveSlots('2026-08-12', 1);
    assert.equal(other.used, 1);
  });

  it('allows a claim that exactly fills the day', async () => {
    const usage = await reserveSlots(DAY, LIMIT);
    assert.equal(usage.used, LIMIT);
    assert.equal(usage.remaining, 0);
  });

  it('refuses the slot after the day is full', async () => {
    await reserveSlots(DAY, LIMIT);
    await assert.rejects(
      () => reserveSlots(DAY, 1),
      (error) => error instanceof ApiError
        && error.status === 429
        && error.code === 'schedule_limit_exceeded',
    );
  });

  it('refuses a bulk claim that does not fit, rather than partly filling it', async () => {
    await reserveSlots(DAY, 50);
    // 20 more will not fit in the remaining 10. Taking 10 and abandoning 10
    // recipients is the outcome this all-or-nothing rule exists to prevent.
    await assert.rejects(() => reserveSlots(DAY, 20), /Only 10 of the 60/);
    assert.equal((await slotUsage(DAY)).used, 50, 'a refused claim must spend nothing');
  });

  it('refuses a claim larger than a day could ever hold', async () => {
    await assert.rejects(
      () => reserveSlots(DAY, LIMIT + 1),
      (error) => error instanceof ApiError && /more than the daily limit/.test(error.message),
    );
  });

  it('never lets concurrent claims exceed the limit', async () => {
    // The reason the reservation is one conditional $inc rather than a read
    // followed by a write. Eighty simultaneous composes, sixty slots: exactly
    // sixty must succeed, whatever order they interleave in.
    const attempts = Array.from({ length: 80 }, () => reserveSlots(DAY, 1));
    const results = await Promise.allSettled(attempts);

    const granted = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');

    assert.equal(granted.length, LIMIT);
    assert.equal(refused.length, 80 - LIMIT);
    assert.equal((await slotUsage(DAY)).used, LIMIT);
  });

  it('never oversells when concurrent claims are for different sizes', async () => {
    const attempts = [
      reserveSlots(DAY, 25),
      reserveSlots(DAY, 25),
      reserveSlots(DAY, 25),
    ];
    const results = await Promise.allSettled(attempts);
    const granted = results.filter((result) => result.status === 'fulfilled');

    // Two fit, the third cannot. Whichever loses, the total must stay within 60.
    assert.equal(granted.length, 2);
    assert.ok((await slotUsage(DAY)).used <= LIMIT);
  });
});

describe('releaseSlots', () => {
  it('returns a slot so the day can use it again', async () => {
    await reserveSlots(DAY, LIMIT);
    await releaseSlots(DAY, 1);
    assert.equal((await slotUsage(DAY)).remaining, 1);
    await assert.doesNotReject(() => reserveSlots(DAY, 1));
  });

  it('returns a whole bulk reservation at once', async () => {
    await reserveSlots(DAY, 40);
    await releaseSlots(DAY, 40);
    assert.equal((await slotUsage(DAY)).used, 0);
  });

  it('refuses to drive the counter negative', async () => {
    // A double release would otherwise mint slots that were never returned, and
    // the day would quietly allow more than the limit.
    await reserveSlots(DAY, 1);
    await releaseSlots(DAY, 1);
    await releaseSlots(DAY, 1);
    assert.equal((await slotUsage(DAY)).used, 0);
  });

  it('ignores a nonsensical count instead of throwing inside a failure path', async () => {
    await reserveSlots(DAY, 1);
    await assert.doesNotReject(() => releaseSlots(DAY, 0));
    await assert.doesNotReject(() => releaseSlots(DAY, -5));
    assert.equal((await slotUsage(DAY)).used, 1);
  });
});
