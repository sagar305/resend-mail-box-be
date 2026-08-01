import { Router } from 'express';
import { attachmentLimits, parseAttachments } from '../lib/attachments.js';
import { assertSendable, normalizeComposePayload, parsePagination } from '../lib/validation.js';
import {
  getAttachment,
  getReceived,
  getSent,
  listReceived,
  listSent,
  sendMail,
} from '../services/resendClient.js';
import { isRead, markRead, markUnread, withReadState } from '../services/readState.js';

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

// Lets the compose form reject an oversized or blocked file before it spends time
// reading and encoding it, using the same numbers this API enforces on send.
mailRouter.get('/limits', (_req, res) => {
  res.json({ attachments: attachmentLimits() });
});

mailRouter.post('/send', asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const payload = {
    ...normalizeComposePayload(body),
    attachments: parseAttachments(body.attachments),
  };
  assertSendable(payload);
  const { id } = await sendMail(payload);
  res.status(202).json({ id });
}));
