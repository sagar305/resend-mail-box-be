import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { ApiError } from '../lib/ApiError.js';

function rowToDraft(row) {
  return {
    id: row.id,
    folder: 'drafts',
    to: JSON.parse(row.to_addrs),
    cc: JSON.parse(row.cc_addrs),
    bcc: JSON.parse(row.bcc_addrs),
    subject: row.subject,
    html: row.html,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const insertStmt = db.prepare(`
  INSERT INTO drafts (id, to_addrs, cc_addrs, bcc_addrs, subject, html, text, created_at, updated_at)
  VALUES (@id, @to_addrs, @cc_addrs, @bcc_addrs, @subject, @html, @text, @created_at, @updated_at)
`);
const updateStmt = db.prepare(`
  UPDATE drafts
     SET to_addrs = @to_addrs, cc_addrs = @cc_addrs, bcc_addrs = @bcc_addrs,
         subject = @subject, html = @html, text = @text, updated_at = @updated_at
   WHERE id = @id
`);
const listStmt = db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC');
const getStmt = db.prepare('SELECT * FROM drafts WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM drafts WHERE id = ?');

export function listDrafts() {
  return listStmt.all().map(rowToDraft);
}

export function getDraft(id) {
  const row = getStmt.get(id);
  if (!row) throw new ApiError(404, 'Draft not found', 'not_found');
  return rowToDraft(row);
}

export function createDraft(payload) {
  const now = new Date().toISOString();
  const draft = {
    id: randomUUID(),
    to_addrs: JSON.stringify(payload.to),
    cc_addrs: JSON.stringify(payload.cc),
    bcc_addrs: JSON.stringify(payload.bcc),
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    created_at: now,
    updated_at: now,
  };
  insertStmt.run(draft);
  return rowToDraft(draft);
}

export function updateDraft(id, payload) {
  getDraft(id); // 404s if it's gone
  updateStmt.run({
    id,
    to_addrs: JSON.stringify(payload.to),
    cc_addrs: JSON.stringify(payload.cc),
    bcc_addrs: JSON.stringify(payload.bcc),
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    updated_at: new Date().toISOString(),
  });
  return getDraft(id);
}

export function deleteDraft(id) {
  const result = deleteStmt.run(id);
  if (result.changes === 0) throw new ApiError(404, 'Draft not found', 'not_found');
}
