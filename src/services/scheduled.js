import { getCollections } from '../db.js';
import { ApiError } from '../lib/ApiError.js';
import { utcDay } from '../lib/schedule.js';
import { noteSends } from './quota.js';
import { cancelScheduled, rescheduleEmail, sendMail } from './resendClient.js';
import { releaseSlots, reserveSlots } from './slots.js';

/*
 * Scheduled mail, and the ledger that makes the daily cap real.
 *
 * Resend holds the mail and sends it; this collection exists because Resend
 * cannot answer "how many are scheduled for next Tuesday" without walking every
 * page of the sent log. It is also what makes the Scheduled folder cheap and the
 * cap enforceable at compose time rather than after the fact.
 */

function toScheduled(doc) {
  return {
    id: doc._id,
    folder: 'scheduled',
    to: doc.to ?? [],
    cc: doc.cc ?? [],
    bcc: doc.bcc ?? [],
    subject: doc.subject ?? '',
    html: doc.html ?? '',
    text: doc.text ?? '',
    preview: doc.preview ?? '',
    scheduledAt: doc.scheduledAt,
    createdAt: doc.createdAt,
    status: doc.status,
    attachmentCount: doc.attachmentCount ?? 0,
    jobId: doc.jobId ?? null,
  };
}

/** A one-line preview for the message list, matching what sent mail shows. */
function buildPreview(text, html) {
  return String(text || html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/**
 * Schedules one mail: claim the slot, hand it to Resend, record it.
 *
 * The slot is claimed first and given back if Resend refuses. The reverse order
 * has a window where concurrent composes both read the same count and both send.
 */
export async function scheduleMail(payload) {
  const day = utcDay(payload.scheduledAt);
  const usage = await reserveSlots(day, 1);

  let sent;
  try {
    sent = await sendMail(payload);
  } catch (error) {
    // Nothing was scheduled, so the slot was never really spent.
    await releaseSlots(day, 1);
    throw error;
  }

  const { scheduled } = getCollections();
  const doc = {
    _id: sent.id,
    day,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    preview: buildPreview(payload.text, payload.html),
    attachmentCount: payload.attachments?.length ?? 0,
    scheduledAt: payload.scheduledAt,
    createdAt: new Date().toISOString(),
    status: 'scheduled',
    jobId: payload.jobId ?? null,
  };
  await scheduled.insertOne(doc);
  noteSends(1);

  return { scheduled: toScheduled(doc), usage };
}

/** The Scheduled folder: what is still pending, soonest first. */
export async function listScheduled() {
  const { scheduled } = getCollections();
  const docs = await scheduled
    .find({ status: 'scheduled' })
    .sort({ scheduledAt: 1 })
    .toArray();
  return docs.map(toScheduled);
}

export async function getScheduled(id) {
  const { scheduled } = getCollections();
  const doc = await scheduled.findOne({ _id: id });
  if (!doc) throw new ApiError(404, 'Scheduled email not found', 'not_found');
  return toScheduled(doc);
}

/**
 * Cancels a scheduled send and returns its slot to the day.
 *
 * Resend's cancel is terminal, so the local record is marked cancelled rather
 * than deleted — otherwise a cancelled mail simply vanishes with no trace of
 * where it went.
 */
export async function cancelScheduledMail(id) {
  const { scheduled } = getCollections();
  const doc = await scheduled.findOne({ _id: id });
  if (!doc) throw new ApiError(404, 'Scheduled email not found', 'not_found');
  if (doc.status !== 'scheduled') {
    throw new ApiError(409, `This email is already ${doc.status}`, 'invalid_state');
  }

  await cancelScheduled(id);
  await scheduled.updateOne(
    { _id: id },
    { $set: { status: 'cancelled', cancelledAt: new Date().toISOString() } },
  );
  await releaseSlots(doc.day, 1);

  return getScheduled(id);
}

/**
 * Moves a scheduled send to a new time.
 *
 * Crossing midnight UTC moves the slot from one day's ledger to another, so the
 * new day is claimed before the old one is released — releasing first would let
 * a concurrent compose take the slot we are about to need, and leave this mail
 * rescheduled on Resend but unaccounted for here.
 */
export async function rescheduleMail(id, scheduledAt) {
  const { scheduled } = getCollections();
  const doc = await scheduled.findOne({ _id: id });
  if (!doc) throw new ApiError(404, 'Scheduled email not found', 'not_found');
  if (doc.status !== 'scheduled') {
    throw new ApiError(409, `This email is already ${doc.status}`, 'invalid_state');
  }

  const nextDay = utcDay(scheduledAt);
  const movesDay = nextDay !== doc.day;
  if (movesDay) await reserveSlots(nextDay, 1);

  try {
    await rescheduleEmail(id, scheduledAt);
  } catch (error) {
    if (movesDay) await releaseSlots(nextDay, 1);
    throw error;
  }

  if (movesDay) await releaseSlots(doc.day, 1);
  await scheduled.updateOne({ _id: id }, { $set: { scheduledAt, day: nextDay } });

  return getScheduled(id);
}

/**
 * Drops scheduled mail whose time has passed out of the folder.
 *
 * Resend gives us no callback when a scheduled mail actually goes, and polling
 * each one costs an API call apiece. Since the mail appears in Sent the moment it
 * sends, treating a passed time as sent is accurate enough for a folder listing
 * and costs nothing. The slot is deliberately NOT returned: it was spent.
 */
export async function settleDueScheduled(now = new Date()) {
  const { scheduled } = getCollections();
  const result = await scheduled.updateMany(
    { status: 'scheduled', scheduledAt: { $lte: now.toISOString() } },
    { $set: { status: 'sent' } },
  );
  return result.modifiedCount;
}
