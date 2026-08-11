import { Router } from 'express';
import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';
import { attachmentLimits, parseAttachments } from '../lib/attachments.js';
import { parseScheduledAt } from '../lib/schedule.js';
import {
  assertSendable,
  htmlToText,
  normalizeComposePayload,
  parseBulkRecipients,
  parsePagination,
} from '../lib/validation.js';
import {
  createBulkJob,
  getBulkJob,
  listBulkJobs,
  retryFailedRecipients,
} from '../services/bulkJobs.js';
import { dailyQuota, noteSends } from '../services/quota.js';
import {
  getAttachment,
  getReceived,
  getSent,
  listReceived,
  listSent,
  sendMail,
} from '../services/resendClient.js';
import { isRead, markRead, markUnread, withReadState } from '../services/readState.js';
import {
  cancelScheduledMail,
  getScheduled,
  listScheduled,
  rescheduleMail,
  scheduleMail,
  settleDueScheduled,
} from '../services/scheduled.js';
import { slotUsage } from '../services/slots.js';

export const mailRouter = Router();

const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

mailRouter.get('/inbox', asyncRoute(async (req, res) => {
  const { messages, hasMore } = await listReceived(parsePagination(req.query));
  res.json({ messages: await withReadState(messages), hasMore });
}));

mailRouter.get('/inbox/:id', asyncRoute(async (req, res) => {
  const message = await getReceived(req.params.id);
  // Opening a message marks it read, the same as any mail client.
  await markRead(message.id);
  res.json({ message: { ...message, read: true } });
}));

/**
 * Downloads an attachment. Resend's signed URL is handed to the browser as a
 * redirect rather than streamed through here: it saves this service the bandwidth
 * of every file, and the URL expires on its own. Requesting it is behind the
 * session, so the redirect is only ever issued to a signed-in user.
 *
 * The URL is resolved per request, never baked into the page — it is short-lived,
 * and a link rendered minutes ago would already be dead.
 */
const downloadRoute = (folder) => asyncRoute(async (req, res) => {
  const attachment = await getAttachment(folder, req.params.id, req.params.attachmentId);
  // Nothing may cache a URL that stops working, least of all a shared proxy.
  res.set('Cache-Control', 'no-store, private');
  res.redirect(302, attachment.downloadUrl);
});

mailRouter.get('/inbox/:id/attachments/:attachmentId', downloadRoute('inbox'));
mailRouter.get('/sent/:id/attachments/:attachmentId', downloadRoute('sent'));

mailRouter.patch('/inbox/:id/read', asyncRoute(async (req, res) => {
  const read = req.body?.read !== false;
  if (read) await markRead(req.params.id);
  else await markUnread(req.params.id);
  res.json({ id: req.params.id, read: await isRead(req.params.id) });
}));

mailRouter.get('/sent', asyncRoute(async (req, res) => {
  const { messages, hasMore } = await listSent(parsePagination(req.query));
  res.json({ messages, hasMore });
}));

mailRouter.get('/sent/:id', asyncRoute(async (req, res) => {
  res.json({ message: await getSent(req.params.id) });
}));

/**
 * Everything the compose form needs to stop a send it already knows will fail:
 * the attachment numbers this API enforces, how many scheduled slots the day has
 * left, and how much of the Resend plan's allowance is gone.
 *
 * The quota figure is read from cache here. It is the meter, not the gate — the
 * gate re-reads it fresh at the moment mail would actually go out.
 */
mailRouter.get('/limits', asyncRoute(async (_req, res) => {
  const [slots, quota] = await Promise.all([slotUsage(), dailyQuota()]);
  res.json({
    attachments: attachmentLimits(),
    scheduling: {
      ...slots,
      maxHorizonDays: config.scheduling.maxHorizonDays,
    },
    quota,
    bulk: { maxRecipients: config.bulk.maxRecipients },
  });
}));

mailRouter.get('/scheduled', asyncRoute(async (_req, res) => {
  // Resend never tells us a scheduled mail went out, so anything past its time is
  // retired from the folder on the way to listing it.
  await settleDueScheduled();
  res.json({ messages: await listScheduled(), hasMore: false });
}));

mailRouter.get('/scheduled/:id', asyncRoute(async (req, res) => {
  res.json({ message: await getScheduled(req.params.id) });
}));

mailRouter.delete('/scheduled/:id', asyncRoute(async (req, res) => {
  res.json({ message: await cancelScheduledMail(req.params.id) });
}));

mailRouter.patch('/scheduled/:id', asyncRoute(async (req, res) => {
  const scheduledAt = parseScheduledAt(req.body?.scheduledAt);
  if (!scheduledAt) {
    throw new ApiError(422, 'scheduledAt is required to reschedule', 'validation_error');
  }
  res.json({ message: await rescheduleMail(req.params.id, scheduledAt) });
}));

/*
 * Bulk sends: one separate, personalized mail per recipient.
 *
 * Answers 202 with a job id rather than waiting — sixty recipients take about
 * thirty seconds at Resend's rate limit, which no browser should sit through.
 * Progress is polled from the job endpoints below.
 */
mailRouter.post('/bulk', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const job = await createBulkJob({
    subject: String(body.subject ?? '').trim(),
    html: String(body.html ?? ''),
    text: body.text ? String(body.text) : htmlToText(String(body.html ?? '')),
    columns: Array.isArray(body.columns) ? body.columns.map((name) => String(name).trim()) : [],
    recipients: parseBulkRecipients(body.recipients),
    attachments: parseAttachments(body.attachments),
    scheduledAt: parseScheduledAt(body.scheduledAt),
  });
  res.status(202).json({ job });
}));

mailRouter.get('/bulk', asyncRoute(async (_req, res) => {
  res.json({ jobs: await listBulkJobs() });
}));

mailRouter.get('/bulk/:id', asyncRoute(async (req, res) => {
  // The recipient rows are what make a partial failure legible, so the detail
  // view always carries them.
  res.json({ job: await getBulkJob(req.params.id, { withRecipients: true }) });
}));

mailRouter.post('/bulk/:id/retry', asyncRoute(async (req, res) => {
  res.json({ job: await retryFailedRecipients(req.params.id) });
}));

mailRouter.post('/send', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const payload = {
    ...normalizeComposePayload(body),
    attachments: parseAttachments(body.attachments),
    scheduledAt: parseScheduledAt(body.scheduledAt),
  };
  assertSendable(payload);

  // A scheduled send spends a slot from the daily ledger and is recorded so the
  // Scheduled folder and the cap both know about it. An immediate send is
  // uncapped and goes straight out, exactly as it did before.
  if (payload.scheduledAt) {
    const { scheduled, usage } = await scheduleMail(payload);
    res.status(202).json({ id: scheduled.id, scheduledAt: scheduled.scheduledAt, usage });
    return;
  }

  const { id } = await sendMail(payload);
  noteSends(1);
  res.status(202).json({ id });
}));
