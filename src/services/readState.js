import { getCollections } from '../db.js';

/*
 * Resend does not track whether an inbound message has been read, so it is
 * tracked here. A document exists only for messages that have been read, and
 * its `_id` is the Resend email id — that gives uniqueness for free and makes
 * "mark read" a plain upsert.
 */

export async function markRead(emailId) {
  const { readReceipts } = getCollections();
  await readReceipts.updateOne(
    { _id: emailId },
    { $setOnInsert: { readAt: new Date().toISOString() } },
    { upsert: true },
  );
}

export async function markUnread(emailId) {
  const { readReceipts } = getCollections();
  await readReceipts.deleteOne({ _id: emailId });
}

export async function isRead(emailId) {
  const { readReceipts } = getCollections();
  return Boolean(await readReceipts.findOne({ _id: emailId }));
}

/** Attach a `read` flag to a page of inbox messages in one query. */
export async function withReadState(messages) {
  if (!messages.length) return messages;

  const { readReceipts } = getCollections();
  const docs = await readReceipts
    .find({ _id: { $in: messages.map((message) => message.id) } })
    .toArray();
  const readIds = new Set(docs.map((doc) => doc._id));

  return messages.map((message) => ({ ...message, read: readIds.has(message.id) }));
}
