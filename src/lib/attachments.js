import { config } from '../config.js';
import { ApiError } from './ApiError.js';

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;
const MAX_FILENAME_LENGTH = 200;

function fail(message) {
  throw new ApiError(422, message, 'validation_error');
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Byte length of the data a base64 string decodes to, without decoding it —
 * every 4 characters carry 3 bytes, less one per '=' of padding.
 */
export function decodedByteLength(base64) {
  if (!base64.length) return 0;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** A browser File name can carry a path; keep the leaf and nothing that escapes it. */
function sanitizeFilename(value) {
  const name = String(value ?? '').split(/[\\/]/).pop().trim();
  if (!name || name === '.' || name === '..') fail('Each attachment needs a filename');
  if (name.length > MAX_FILENAME_LENGTH) {
    fail(`Attachment filename is too long: ${name.slice(0, 40)}…`);
  }
  return name;
}

export function extensionOf(filename) {
  const match = /\.([^.]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : '';
}

/** Strips a `data:…;base64,` prefix and any whitespace a client may have wrapped in. */
function normalizeContent(value, filename) {
  if (typeof value !== 'string' || !value) fail(`Attachment "${filename}" has no content`);
  const withoutPrefix = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value;
  const compact = withoutPrefix.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    fail(`Attachment "${filename}" is not valid base64`);
  }
  return compact;
}

/**
 * Validates the compose form's `attachments` and returns them ready for Resend.
 * The limits are `config.attachments`, the same numbers `GET /api/mail/limits`
 * hands the frontend, so client-side checks and these cannot drift apart.
 */
export function parseAttachments(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) fail('attachments must be an array');

  const { maxCount, maxFileBytes, maxTotalBytes, blockedExtensions } = config.attachments;
  if (value.length > maxCount) {
    fail(`Too many attachments: ${value.length}. The limit is ${maxCount}.`);
  }

  let total = 0;
  const attachments = value.map((entry) => {
    if (!entry || typeof entry !== 'object') fail('Each attachment must be an object');

    const filename = sanitizeFilename(entry.filename);
    const extension = extensionOf(filename);
    if (blockedExtensions.includes(extension)) {
      fail(`.${extension} files are blocked by most mail providers, so "${filename}" cannot be sent`);
    }

    const content = normalizeContent(entry.content, filename);
    const size = decodedByteLength(content);
    if (size === 0) fail(`Attachment "${filename}" is empty`);
    if (size > maxFileBytes) {
      fail(`"${filename}" is ${formatBytes(size)}. The limit is ${formatBytes(maxFileBytes)} per file.`);
    }

    total += size;
    if (total > maxTotalBytes) {
      fail(`Attachments total more than ${formatBytes(maxTotalBytes)}, which is the limit for one email.`);
    }

    const contentType = String(entry.contentType ?? entry.content_type ?? '').trim();
    return {
      filename,
      content,
      // Resend derives the type from the filename when it is absent, which beats
      // forwarding something malformed a browser handed us.
      ...(MIME_PATTERN.test(contentType) ? { contentType } : {}),
    };
  });

  return attachments;
}

/** The limits the frontend enforces before it spends time encoding a file. */
export function attachmentLimits() {
  const { maxCount, maxFileBytes, maxTotalBytes, blockedExtensions } = config.attachments;
  return { maxCount, maxFileBytes, maxTotalBytes, blockedExtensions };
}
