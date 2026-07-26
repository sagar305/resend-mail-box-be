import { db } from '../db.js';

const markReadStmt = db.prepare(
  'INSERT INTO read_receipts (email_id, read_at) VALUES (?, ?) ON CONFLICT(email_id) DO NOTHING',
);
const markUnreadStmt = db.prepare('DELETE FROM read_receipts WHERE email_id = ?');
const isReadStmt = db.prepare('SELECT 1 FROM read_receipts WHERE email_id = ?');

export function markRead(emailId) {
  markReadStmt.run(emailId, new Date().toISOString());
}

export function markUnread(emailId) {
  markUnreadStmt.run(emailId);
}

export function isRead(emailId) {
  return Boolean(isReadStmt.get(emailId));
}

/** Attach a `read` flag to a page of inbox messages in one query. */
export function withReadState(messages) {
  if (!messages.length) return messages;

  const placeholders = messages.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT email_id FROM read_receipts WHERE email_id IN (${placeholders})`)
    .all(...messages.map((message) => message.id));
  const readIds = new Set(rows.map((row) => row.email_id));

  return messages.map((message) => ({ ...message, read: readIds.has(message.id) }));
}
