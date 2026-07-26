import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  resendApiKey: required('RESEND_API_KEY'),

  // The address every outgoing mail is sent from. Accepts a bare address
  // ("me@example.com") or one with a display name ("Me <me@example.com>").
  mailboxAddress: required('MAILBOX_ADDRESS'),

  auth: {
    user: required('MAILBOX_USER'),
    password: required('MAILBOX_PASSWORD'),
    sessionSecret: required('SESSION_SECRET'),
    // 24h, matching the agreed session length.
    sessionMaxAgeMs: 24 * 60 * 60 * 1000,
    cookieName: 'mb_session',
  },

  databaseFile: path.resolve(rootDir, process.env.DATABASE_FILE || 'data/mailbox.db'),
  isProduction: process.env.NODE_ENV === 'production',
};
