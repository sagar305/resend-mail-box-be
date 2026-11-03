import { ApiError } from './ApiError.js';

// Deliberately permissive: Resend does the authoritative validation, this only
// catches obvious typos before we spend an API call on them.
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * Accepts either an array of addresses or a single comma/semicolon separated
 * string (what the compose form sends) and returns a clean, de-duplicated list.
 */
export function parseRecipients(value, field) {
  const parts = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,;]/);

  const addresses = [...new Set(parts.map((part) => String(part).trim()).filter(Boolean))];

  const invalid = addresses.filter((address) => !EMAIL_PATTERN.test(address));
  if (invalid.length) {
    throw new ApiError(422, `Invalid ${field} address: ${invalid.join(', ')}`, 'validation_error');
  }
  return addresses;
}

/** Best-effort plain-text fallback so recipients without HTML still get a body. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** TipTap emits `<p></p>` for an untouched editor — treat that as empty. */
export function isBlankHtml(html) {
  return htmlToText(html).length === 0;
}

export function parsePagination(query) {
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(422, 'limit must be an integer between 1 and 100', 'validation_error');
  }
  if (query.before && query.after) {
    throw new ApiError(422, 'Pass either before or after, not both', 'validation_error');
  }
  return {
    limit,
    before: query.before ? String(query.before) : undefined,
    after: query.after ? String(query.after) : undefined,
  };
}

export function normalizeComposePayload(body) {
  const to = parseRecipients(body.to, 'to');
  const cc = parseRecipients(body.cc, 'cc');
  const bcc = parseRecipients(body.bcc, 'bcc');
  const subject = String(body.subject ?? '').trim();
  const html = String(body.html ?? '');

  return {
    to,
    cc,
    bcc,
    subject,
    html,
    text: body.text ? String(body.text) : htmlToText(html),
  };
}

/**
 * Normalizes the bulk composer's recipient table.
 *
 * Each row is one separate mail, so a duplicated address means someone gets the
 * same thing twice — dropped rather than sent, keeping the first occurrence so
 * the merge values a person expects are the ones nearest the top of their list.
 */
export function parseBulkRecipients(value) {
  if (!Array.isArray(value)) {
    throw new ApiError(422, 'recipients must be an array of rows', 'validation_error');
  }

  const seen = new Set();
  const recipients = [];

  value.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new ApiError(422, `Row ${index + 1} is not a recipient`, 'validation_error');
    }
    const email = String(row.email ?? '').trim();
    if (!email) {
      throw new ApiError(422, `Row ${index + 1} has no email address`, 'validation_error');
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw new ApiError(422, `Row ${index + 1} has an invalid address: ${email}`, 'validation_error');
    }

    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    // Values are kept as trimmed strings: they are pasted from a spreadsheet and
    // land in a subject line, where a stray newline or number type helps nobody.
    const vars = {};
    for (const [column, columnValue] of Object.entries(row.vars ?? {})) {
      vars[String(column).trim()] = String(columnValue ?? '').trim();
    }

    recipients.push({ email, vars });
  });

  if (!recipients.length) {
    throw new ApiError(422, 'A bulk send needs at least one recipient', 'validation_error');
  }
  return recipients;
}

/** Extra checks that only apply when actually sending (drafts may be blank). */
export function assertSendable(payload) {
  if (!payload.to.length) {
    throw new ApiError(422, 'At least one "to" recipient is required', 'validation_error');
  }
  if (!payload.subject) {
    throw new ApiError(422, 'A subject is required', 'validation_error');
  }
  // A file with nothing written above it is a normal thing to send, so an empty
  // body only counts as a mistake when there is no attachment either.
  if (isBlankHtml(payload.html) && !payload.attachments?.length) {
    throw new ApiError(422, 'The message body is empty', 'validation_error');
  }
}
