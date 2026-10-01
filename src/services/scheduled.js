import { randomUUID } from 'node:crypto';
import { getCollections } from '../db.js';
import { ApiError } from '../lib/ApiError.js';
import { utcDay } from '../lib/schedule.js';
import { discardAttachments, loadAttachments, stageAttachments } from './attachmentStore.js';
import { cancelScheduled, rescheduleEmail, sendMail } from './resendClient.js';
import { releaseSlots, reserveSlots } from './slots.js';

/*
 * Scheduled mail, held here until the day it goes out.
 *
 * Resend is only told about a mail on its delivery day, by the dispatcher that
 * runs at 00:00 UTC. Handing it over at compose time instead would put the API
 * call in whatever quota day you happened to be sitting in — so booking a week of
 * mail on a Saturday would spend Saturday's allowance on mail that leaves on
 * Tuesday. Deferring the call makes the question moot: the call and the delivery
 * are now the same UTC day, whichever of the two Resend bills.
 *
 * So a mail has two lives. While `pending` it exists only here, and cancelling or
 * moving it is free and fully reversible. Once `scheduled` it is Resend's, held by
 * them for the hours until its time, and cancelling is terminal.
 *
 *   pending ─(dispatcher, on the delivery day)→ scheduled ─(its time passes)→ sent
 *      │                                            │
 *      └────────── cancelled ───────────────────────┘
 *
 * A mail whose time passed while undispatched — a restart over midnight — is sent
 * at once and marked late rather than dropped.
 */

/** Statuses a mail can still be acted on from. */
const LIVE = ['pending', 'scheduled'];

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
    // Whether Resend has it yet. The UI needs this: a pending mail can be moved
    // freely, a handed-over one cannot be un-cancelled.
    handedOver: Boolean(doc.resendId),
    late: Boolean(doc.late),
    error: doc.error ?? null,
    attachmentCount: doc.attachments?.length ?? 0,
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
 * Books a mail for a future delivery day.
 *
 * The slot is claimed before anything is written and given back if the write
 * fails, so a failure cannot leave a day's budget spent on a mail that does not
 * exist. Nothing reaches Resend here — see the note at the top of the file.
 */
export async function scheduleMail(payload) {
  const day = utcDay(payload.scheduledAt);
  const usage = await reserveSlots(day, 1);

  const id = randomUUID();
  let staged = [];
  try {
    // The files have to outlive this request by up to thirty days, so they go to
    // GridFS rather than into the document or straight out to Resend.
    staged = await stageAttachments(id, payload.attachments);

    const { scheduled } = getCollections();
    const doc = {
      _id: id,
      day,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      preview: buildPreview(payload.text, payload.html),
      attachments: staged,
      scheduledAt: payload.scheduledAt,
      createdAt: new Date().toISOString(),
      status: 'pending',
      resendId: null,
      jobId: payload.jobId ?? null,
    };
    await scheduled.insertOne(doc);

    /*
     * A mail for today has to go over now, not at the next midnight — today's
     * dispatch has already run, and waiting for the next one would send it a day
     * late. Today is also the right quota day for it, which is the whole reason
     * the hand-over is deferred at all, so there is nothing to gain by waiting.
     */
    if (day === utcDay(new Date())) {
      await handOverToResend(doc);
      return { scheduled: await getScheduled(id), usage };
    }

    return { scheduled: toScheduled(doc), usage };
  } catch (error) {
    await releaseSlots(day, 1);
    await discardAttachments(staged);
    throw error;
  }
}

/**
 * Hands one stored mail to Resend. Called by the dispatcher, never by a route.
 *
 * A mail whose time is still ahead goes over with its `scheduledAt` and Resend
 * holds it. One whose time has already passed — the dispatcher missed midnight —
 * is sent immediately instead, because Resend rejects a schedule in the past and
 * late is better than never.
 */
export async function handOverToResend(doc, { now = new Date() } = {}) {
  const { scheduled } = getCollections();
  const late = new Date(doc.scheduledAt).getTime() <= now.getTime();

  try {
    const attachments = await loadAttachments(doc.attachments);
    const { id: resendId } = await sendMail({
      to: doc.to,
      cc: doc.cc ?? [],
      bcc: doc.bcc ?? [],
      subject: doc.subject,
      html: doc.html,
      text: doc.text,
      attachments,
      scheduledAt: late ? undefined : doc.scheduledAt,
    });

    await scheduled.updateOne(
      { _id: doc._id },
      {
        $set: {
          // A late mail is already gone, so it is sent rather than scheduled.
          status: late ? 'sent' : 'scheduled',
          resendId,
          late,
          handedOverAt: new Date().toISOString(),
          error: null,
        },
      },
    );

    /*
     * A late mail went out with no schedule, so Resend logs it as an immediate
     * send and the quota reading counts it there. Its ledger slot is released to
     * keep those two sources from counting the same mail twice — the quota, which
     * is what actually prevents a 429, stays correct either way.
     */
    if (late) await releaseSlots(doc.day, 1);

    await discardAttachments(doc.attachments);
    return { handedOver: true, late };
  } catch (error) {
    // Left for the next sweep rather than failed outright: a rate limit or a
    // blip should not lose a mail that is still hours from its send time.
    await scheduled.updateOne({ _id: doc._id }, { $set: { error: error.message } });
    return { handedOver: false, error };
  }
}

/** Stored mail due to be handed over — anything pending on or before `day`. */
export async function findDueForDispatch(day) {
  const { scheduled } = getCollections();
  return scheduled
    .find({ status: 'pending', day: { $lte: day } })
    .sort({ scheduledAt: 1 })
    .toArray();
}

/** The Scheduled folder: everything still to go, soonest first. */
export async function listScheduled() {
  const { scheduled } = getCollections();
  const docs = await scheduled
    .find({ status: { $in: LIVE } })
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
 * Before hand-over there is nothing at Resend, so this is a local change and
 * completely reversible by scheduling again. After hand-over Resend has to be
 * told, and their cancel is terminal. The row is kept either way: a cancelled
 * mail that vanishes leaves no trace of where it went.
 */
export async function cancelScheduledMail(id) {
  const { scheduled } = getCollections();
  const doc = await scheduled.findOne({ _id: id });
  if (!doc) throw new ApiError(404, 'Scheduled email not found', 'not_found');
  if (!LIVE.includes(doc.status)) {
    throw new ApiError(409, `This email is already ${doc.status}`, 'invalid_state');
  }

  if (doc.resendId) await cancelScheduled(doc.resendId);

  await scheduled.updateOne(
    { _id: id },
    { $set: { status: 'cancelled', cancelledAt: new Date().toISOString() } },
  );
  await releaseSlots(doc.day, 1);
  await discardAttachments(doc.attachments);

  return getScheduled(id);
}

/**
 * Moves a scheduled send to a new time.
 *
 * Crossing midnight UTC moves the slot between two days' budgets, so the new day
 * is claimed before the old one is released — releasing first would let a
 * concurrent compose take the slot we are about to need.
 *
 * Once Resend has it this is an update, never a cancel followed by a new send:
 * their cancel is terminal, so a failure between the two halves of that pair
 * would destroy the mail instead of moving it.
 */
export async function rescheduleMail(id, scheduledAt) {
  const { scheduled } = getCollections();
  const doc = await scheduled.findOne({ _id: id });
  if (!doc) throw new ApiError(404, 'Scheduled email not found', 'not_found');
  if (!LIVE.includes(doc.status)) {
    throw new ApiError(409, `This email is already ${doc.status}`, 'invalid_state');
  }

  const nextDay = utcDay(scheduledAt);
  const movesDay = nextDay !== doc.day;
  if (movesDay) await reserveSlots(nextDay, 1);

  try {
    if (doc.resendId) await rescheduleEmail(doc.resendId, scheduledAt);
  } catch (error) {
    if (movesDay) await releaseSlots(nextDay, 1);
    throw error;
  }

  if (movesDay) await releaseSlots(doc.day, 1);
  await scheduled.updateOne(
    { _id: id },
    // Moving a handed-over mail back to a future day leaves it with Resend; a
    // pending one stays pending for the dispatcher to pick up on the new day.
    { $set: { scheduledAt, day: nextDay, error: null } },
  );

  return getScheduled(id);
}

/**
 * Retires mail whose time has passed out of the folder.
 *
 * Only applies to mail Resend already holds: Resend gives no callback when a
 * scheduled mail goes out, and polling each one costs an API call apiece. Since
 * it appears in Sent the moment it sends, treating a passed time as sent is
 * accurate enough for a listing and costs nothing. The slot is deliberately NOT
 * returned: it was spent.
 *
 * Pending mail is left alone — it has not been sent, and the dispatcher is what
 * deals with it.
 */
export async function settleDueScheduled(now = new Date()) {
  const { scheduled } = getCollections();
  const result = await scheduled.updateMany(
    { status: 'scheduled', scheduledAt: { $lte: now.toISOString() } },
    { $set: { status: 'sent' } },
  );
  return result.modifiedCount;
}
