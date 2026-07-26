import { Router } from 'express';
import { assertSendable, normalizeComposePayload } from '../lib/validation.js';
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from '../services/drafts.js';
import { sendMail } from '../services/resendClient.js';

export const draftsRouter = Router();

const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

draftsRouter.get('/', asyncRoute(async (_req, res) => {
  res.json({ drafts: await listDrafts() });
}));

draftsRouter.get('/:id', asyncRoute(async (req, res) => {
  res.json({ draft: await getDraft(req.params.id) });
}));

// Drafts are saved as-is: an incomplete draft is the whole point, so only the
// address format is validated here, never presence of a recipient or subject.
draftsRouter.post('/', asyncRoute(async (req, res) => {
  res.status(201).json({ draft: await createDraft(normalizeComposePayload(req.body ?? {})) });
}));

draftsRouter.put('/:id', asyncRoute(async (req, res) => {
  const draft = await updateDraft(req.params.id, normalizeComposePayload(req.body ?? {}));
  res.json({ draft });
}));

draftsRouter.delete('/:id', asyncRoute(async (req, res) => {
  await deleteDraft(req.params.id);
  res.status(204).end();
}));

/** Send a stored draft, then drop it — it now lives in Sent. */
draftsRouter.post('/:id/send', asyncRoute(async (req, res) => {
  const draft = await getDraft(req.params.id);
  const payload = normalizeComposePayload(draft);
  assertSendable(payload);
  const { id } = await sendMail(payload);
  await deleteDraft(draft.id);
  res.status(202).json({ id });
}));
