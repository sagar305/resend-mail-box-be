import dotenv from 'dotenv';

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
}

const isProduction = process.env.NODE_ENV === 'production';

// Comma-separated. An entry may be an exact origin ("https://app.vercel.app"),
// a wildcard host ("*.vercel.app") to cover preview deploys, or "*".
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const cookieSameSite = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(cookieSameSite)) {
  throw new Error(`COOKIE_SAMESITE must be lax, strict or none (got "${cookieSameSite}")`);
}

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigins,
  // Railway (and most PaaS) terminate TLS at a proxy, so trust its headers.
  trustProxy: parseBoolean(process.env.TRUST_PROXY, isProduction),

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
    cookieSameSite,
    // Browsers reject SameSite=None unless the cookie is also Secure, so a
    // cross-site deployment implies Secure whatever COOKIE_SECURE says.
    cookieSecure:
      cookieSameSite === 'none' ? true : parseBoolean(process.env.COOKIE_SECURE, isProduction),
  },

  // Holds drafts and read/unread state — the two things Resend does not model.
  mongoUri: required('MONGO_URI'),
  mongoDbName: process.env.MONGO_DB || 'mailbox',

  isProduction,
};
