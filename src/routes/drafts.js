import { Router } from 'express';
import { assertSendable, normalizeComposePayload } from '../lib/validation.js';
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from '../services/drafts.js';
import { sendMail } from '../services/resendClient.js';

export const draftsRouter = Router();

const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

draftsRouter.get('/', (req, res, next) => {
  try {
    res.json({ drafts: listDrafts() });
  } catch (error) {
    next(error);
  }
});

draftsRouter.get('/:id', (req, res, next) => {
  try {
    res.json({ draft: getDraft(req.params.id) });
  } catch (error) {
    next(error);
  }
});

// Drafts are saved as-is: an incomplete draft is the whole point, so only the
// address format is validated here, never presence of a recipient or subject.
draftsRouter.post('/', (req, res, next) => {
  try {
    res.status(201).json({ draft: createDraft(normalizeComposePayload(req.body ?? {})) });
  } catch (error) {
    next(error);
  }
});

draftsRouter.put('/:id', (req, res, next) => {
  try {
    res.json({ draft: updateDraft(req.params.id, normalizeComposePayload(req.body ?? {})) });
  } catch (error) {
    next(error);
  }
});

draftsRouter.delete('/:id', (req, res, next) => {
  try {
    deleteDraft(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/** Send a stored draft, then drop it — it now lives in Sent. */
draftsRouter.post('/:id/send', asyncRoute(async (req, res) => {
  const draft = getDraft(req.params.id);
  const payload = normalizeComposePayload(draft);
  assertSendable(payload);
  const { id } = await sendMail(payload);
  deleteDraft(draft.id);
  res.status(202).json({ id });
}));
