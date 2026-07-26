import { Router } from 'express';
import { assertSendable, normalizeComposePayload, parsePagination } from '../lib/validation.js';
import { getReceived, getSent, listReceived, listSent, sendMail } from '../services/resendClient.js';
import { isRead, markRead, markUnread, withReadState } from '../services/readState.js';

export const mailRouter = Router();

const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

mailRouter.get('/inbox', asyncRoute(async (req, res) => {
  const { messages, hasMore } = await listReceived(parsePagination(req.query));
  res.json({ messages: withReadState(messages), hasMore });
}));

mailRouter.get('/inbox/:id', asyncRoute(async (req, res) => {
  const message = await getReceived(req.params.id);
  // Opening a message marks it read, the same as any mail client.
  markRead(message.id);
  res.json({ message: { ...message, read: true } });
}));

mailRouter.patch('/inbox/:id/read', asyncRoute(async (req, res) => {
  const read = req.body?.read !== false;
  if (read) markRead(req.params.id);
  else markUnread(req.params.id);
  res.json({ id: req.params.id, read: isRead(req.params.id) });
}));

mailRouter.get('/sent', asyncRoute(async (req, res) => {
  const { messages, hasMore } = await listSent(parsePagination(req.query));
  res.json({ messages, hasMore });
}));

mailRouter.get('/sent/:id', asyncRoute(async (req, res) => {
  res.json({ message: await getSent(req.params.id) });
}));

mailRouter.post('/send', asyncRoute(async (req, res) => {
  const payload = normalizeComposePayload(req.body ?? {});
  assertSendable(payload);
  const { id } = await sendMail(payload);
  res.status(202).json({ id });
}));
