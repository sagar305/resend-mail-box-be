import './helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/lib/ApiError.js';
import { nextUtcMidnight, parseScheduledAt, startOfUtcDay, utcDay } from '../src/lib/schedule.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');

describe('utcDay', () => {
  it('uses the UTC calendar day, not the host timezone', () => {
    // 04:00 IST on the 12th is still the 11th in UTC. A host running on IST would
    // report the 12th here, which is exactly the drift the UTC rule prevents.
    assert.equal(utcDay('2026-08-12T04:00:00+05:30'), '2026-08-11');
  });

  it('rolls over at midnight UTC', () => {
    assert.equal(utcDay('2026-08-11T23:59:59.999Z'), '2026-08-11');
    assert.equal(utcDay('2026-08-12T00:00:00.000Z'), '2026-08-12');
  });
});

describe('startOfUtcDay / nextUtcMidnight', () => {
  it('brackets the day the instant falls in', () => {
    assert.equal(startOfUtcDay(NOW).toISOString(), '2026-08-11T00:00:00.000Z');
    assert.equal(nextUtcMidnight(NOW).toISOString(), '2026-08-12T00:00:00.000Z');
  });

  it('does not skip a day when the instant is already midnight', () => {
    const midnight = new Date('2026-08-11T00:00:00.000Z');
    assert.equal(startOfUtcDay(midnight).toISOString(), '2026-08-11T00:00:00.000Z');
    assert.equal(nextUtcMidnight(midnight).toISOString(), '2026-08-12T00:00:00.000Z');
  });
});

describe('parseScheduledAt', () => {
  it('treats an absent value as an immediate send', () => {
    assert.equal(parseScheduledAt(undefined, { now: NOW }), null);
    assert.equal(parseScheduledAt('', { now: NOW }), null);
    assert.equal(parseScheduledAt(null, { now: NOW }), null);
  });

  it('rejects a timestamp with no timezone', () => {
    // The whole point: "09:00" from a user in IST is 03:30 UTC. Reading it as UTC
    // would send it 5.5 hours early, which no error message would ever explain.
    assert.throws(
      () => parseScheduledAt('2026-08-12T09:00:00', { now: NOW }),
      (error) => error instanceof ApiError && error.status === 422,
    );
  });

  it('accepts an explicit offset and normalizes it to the same instant in UTC', () => {
    assert.equal(
      parseScheduledAt('2026-08-12T09:00:00+05:30', { now: NOW }),
      '2026-08-12T03:30:00.000Z',
    );
  });

  it('accepts a Z timestamp unchanged', () => {
    assert.equal(
      parseScheduledAt('2026-08-12T03:30:00.000Z', { now: NOW }),
      '2026-08-12T03:30:00.000Z',
    );
  });

  it('rejects a time in the past', () => {
    assert.throws(
      () => parseScheduledAt('2026-08-10T09:00:00Z', { now: NOW }),
      (error) => error instanceof ApiError && /future/.test(error.message),
    );
  });

  it('rejects a time beyond the 30 day horizon Resend allows', () => {
    assert.throws(
      () => parseScheduledAt('2026-09-20T09:00:00Z', { now: NOW }),
      (error) => error instanceof ApiError && /30 days/.test(error.message),
    );
  });

  it('accepts a time just inside the horizon', () => {
    assert.ok(parseScheduledAt('2026-09-09T12:00:00Z', { now: NOW }));
  });

  it('rejects a malformed date that still carries an offset', () => {
    assert.throws(
      () => parseScheduledAt('not-a-date+05:30', { now: NOW }),
      (error) => error instanceof ApiError && /valid date/.test(error.message),
    );
  });
});
