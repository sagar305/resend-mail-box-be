import { randomUUID } from 'node:crypto';
import { getCollections } from '../db.js';
import { ApiError } from '../lib/ApiError.js';

/**
 * Mongo's `_id` doubles as the draft id — a UUID string rather than an ObjectId,
 * so the id the API hands out is the id stored, with nothing to convert.
 */
function toDraft(doc) {
  return {
    id: doc._id,
    folder: 'drafts',
    to: doc.to ?? [],
    cc: doc.cc ?? [],
    bcc: doc.bcc ?? [],
    subject: doc.subject ?? '',
    html: doc.html ?? '',
    text: doc.text ?? '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toDocument(payload) {
  return {
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  };
}

export async function listDrafts() {
  const { drafts } = getCollections();
  const docs = await drafts.find({}).sort({ updatedAt: -1 }).toArray();
  return docs.map(toDraft);
}

export async function getDraft(id) {
  const { drafts } = getCollections();
  const doc = await drafts.findOne({ _id: id });
  if (!doc) throw new ApiError(404, 'Draft not found', 'not_found');
  return toDraft(doc);
}

export async function createDraft(payload) {
  const { drafts } = getCollections();
  const now = new Date().toISOString();
  const doc = { _id: randomUUID(), ...toDocument(payload), createdAt: now, updatedAt: now };
  await drafts.insertOne(doc);
  return toDraft(doc);
}

export async function updateDraft(id, payload) {
  const { drafts } = getCollections();
  const result = await drafts.updateOne(
    { _id: id },
    { $set: { ...toDocument(payload), updatedAt: new Date().toISOString() } },
  );
  if (result.matchedCount === 0) throw new ApiError(404, 'Draft not found', 'not_found');
  return getDraft(id);
}

export async function deleteDraft(id) {
  const { drafts } = getCollections();
  const result = await drafts.deleteOne({ _id: id });
  if (result.deletedCount === 0) throw new ApiError(404, 'Draft not found', 'not_found');
}
