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

const MB = 1024 * 1024;

function parseMegabytes(value, fallback, name) {
  if (value === undefined || value === '') return fallback * MB;
  const megabytes = Number(value);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error(`${name} must be a positive number of megabytes (got "${value}")`);
  }
  return Math.round(megabytes * MB);
}

// Resend's hard ceiling is 40 MB per email measured AFTER base64 encoding, which
// is what our own limits below have to stay under once inflated by 4/3.
const RESEND_MAX_ENCODED_BYTES = 40 * MB;

const attachments = {
  maxCount: Number(process.env.MAX_ATTACHMENT_COUNT || 10),
  maxFileBytes: parseMegabytes(process.env.MAX_ATTACHMENT_MB, 10, 'MAX_ATTACHMENT_MB'),
  maxTotalBytes: parseMegabytes(process.env.MAX_ATTACHMENTS_TOTAL_MB, 20, 'MAX_ATTACHMENTS_TOTAL_MB'),
  /**
   * Extensions the big mailbox providers (Gmail, Outlook) reject outright.
   * Resend itself accepts them, so this is our policy, not the API's — but a mail
   * that is guaranteed to bounce is worth refusing before it costs an API call.
   */
  blockedExtensions: [
    'ade', 'adp', 'apk', 'appx', 'appxbundle', 'bat', 'cab', 'chm', 'cmd', 'com', 'cpl',
    'diagcab', 'diagcfg', 'diagpack', 'dll', 'dmg', 'ex', 'ex_', 'exe', 'gadget', 'hta',
    'img', 'ins', 'iso', 'isp', 'jar', 'jnlp', 'js', 'jse', 'lib', 'lnk', 'mde', 'msc',
    'msi', 'msix', 'msixbundle', 'msp', 'mst', 'nsh', 'pif', 'ps1', 'scr', 'sct', 'shb',
    'sys', 'vb', 'vbe', 'vbs', 'vhd', 'vxd', 'wsc', 'wsf', 'wsh', 'xll',
  ],
};

if (attachments.maxFileBytes > attachments.maxTotalBytes) {
  attachments.maxFileBytes = attachments.maxTotalBytes;
}
if (!Number.isInteger(attachments.maxCount) || attachments.maxCount < 1) {
  throw new Error(`MAX_ATTACHMENT_COUNT must be a positive integer (got "${process.env.MAX_ATTACHMENT_COUNT}")`);
}
// Base64 costs 4 bytes per 3, so the encoded payload is what has to fit in 40 MB.
if (Math.ceil(attachments.maxTotalBytes / 3) * 4 > RESEND_MAX_ENCODED_BYTES) {
  throw new Error(
    `MAX_ATTACHMENTS_TOTAL_MB is too large: ${(attachments.maxTotalBytes / MB).toFixed(1)} MB of files ` +
    'exceeds 40 MB once base64 encoded, which Resend rejects. Use 30 or less.',
  );
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
    // Renewed on activity (see refreshSessionIfStale), so this is the window of
    // inactivity you are allowed, not a hard cap on staying signed in.
    sessionMaxAgeMs: Number(process.env.SESSION_DAYS || 30) * 24 * 60 * 60 * 1000,
    cookieName: 'mb_session',
    cookieSameSite,
    // Browsers reject SameSite=None unless the cookie is also Secure, so a
    // cross-site deployment implies Secure whatever COOKIE_SECURE says.
    cookieSecure:
      cookieSameSite === 'none' ? true : parseBoolean(process.env.COOKIE_SECURE, isProduction),
  },

  attachments,
  // The JSON body has to hold every attachment base64 encoded plus the HTML body,
  // so it is derived from the attachment budget rather than set independently —
  // otherwise raising one silently leaves the other as the real limit.
  jsonBodyLimitBytes: Math.ceil(attachments.maxTotalBytes / 3) * 4 + 2 * MB,

  // Holds drafts and read/unread state — the two things Resend does not model.
  mongoUri: required('MONGO_URI'),
  mongoDbName: process.env.MONGO_DB || 'mailbox',

  isProduction,
};
