import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from './config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// On a PaaS the container filesystem is wiped on every deploy, so a database
// sitting inside the app directory silently loses drafts and read state. Loud
// warning rather than a hard failure: it is a valid choice for a throwaway
// instance, just never what you want by accident.
if (config.isProduction && !path.relative(projectRoot, config.databaseFile).startsWith('..')) {
  console.warn(
    `[warn] ${config.databaseFile} is inside the app directory. On Railway this is ephemeral — ` +
      'drafts and read/unread state will reset on each deploy. Attach a volume and point ' +
      'DATABASE_FILE at it (e.g. /data/mailbox.db).',
  );
}

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
