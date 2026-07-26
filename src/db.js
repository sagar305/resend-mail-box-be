import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

export const db = new Database(config.databaseFile);

db.pragma('journal_mode = WAL');

// Resend has no drafts concept and stores no read/unread state, so both live here.
db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id          TEXT PRIMARY KEY,
    to_addrs    TEXT NOT NULL DEFAULT '[]',
    cc_addrs    TEXT NOT NULL DEFAULT '[]',
    bcc_addrs   TEXT NOT NULL DEFAULT '[]',
    subject     TEXT NOT NULL DEFAULT '',
    html        TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS read_receipts (
    email_id  TEXT PRIMARY KEY,
    read_at   TEXT NOT NULL
  );
`);
