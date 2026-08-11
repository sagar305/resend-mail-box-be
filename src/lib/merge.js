import { ApiError } from './ApiError.js';

/*
 * Merge tokens for bulk sends: `{{first name}}` in a subject or body, filled per
 * recipient from that row's columns.
 *
 * Two rules shape this file.
 *
 * A missing value blocks the whole job rather than sending a blank. "Hi ," is
 * worse than a send that never left, and it cannot be recalled.
 *
 * Values are escaped when they land in HTML and left alone everywhere else. A
 * column can hold an ampersand or an angle bracket — it arrives from a pasted
 * spreadsheet — and dropping that into the body raw would break the markup at
 * best and inject into it at worst.
 */

const TOKEN_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Column names are matched loosely — trimmed and case-insensitive — because the
 * tokens are typed by hand and the columns usually come from a CSV header row.
 * "First Name" and "first name" being different keys is a papercut nobody wants.
 */
export function normalizeKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Every distinct token used across the given templates, in normalized form. */
export function extractTokens(...templates) {
  const found = new Set();
  for (const template of templates) {
    for (const match of String(template ?? '').matchAll(TOKEN_PATTERN)) {
      found.add(normalizeKey(match[1]));
    }
  }
  return [...found];
}

/** Turn a recipient's columns into the lookup the renderer uses. */
export function toValueMap(vars) {
  const map = new Map();
  for (const [key, value] of Object.entries(vars ?? {})) {
    map.set(normalizeKey(key), value);
  }
  return map;
}

/**
 * Fill a template for one recipient. `html: true` escapes each value on the way
 * in; subjects and plain-text bodies take the raw value.
 *
 * Substitution is single-pass, so a value that itself contains `{{...}}` is left
 * as literal text rather than being resolved again — data cannot reach back into
 * the template.
 */
export function renderTemplate(template, values, { html = false } = {}) {
  return String(template ?? '').replace(TOKEN_PATTERN, (whole, rawKey) => {
    const value = values.get(normalizeKey(rawKey));
    // Unreachable for a validated job — assertRecipientsResolvable has already
    // refused anything missing — so leaving the token visible is the honest
    // failure if this is ever called on unvalidated input.
    if (value === undefined || value === null || String(value).trim() === '') return whole;
    return html ? escapeHtml(value) : String(value);
  });
}

/**
 * Refuses the job unless every recipient can fill every token.
 *
 * Reports up to a handful of offending rows by address rather than just a count,
 * since the point is to go and fix them.
 */
export function assertRecipientsResolvable(recipients, tokens) {
  if (!tokens.length) return;

  const problems = [];
  for (const recipient of recipients) {
    const values = toValueMap(recipient.vars);
    const missing = tokens.filter((token) => {
      const value = values.get(token);
      return value === undefined || value === null || String(value).trim() === '';
    });
    if (missing.length) problems.push({ email: recipient.email, missing });
  }

  if (!problems.length) return;

  const shown = problems.slice(0, 5)
    .map(({ email, missing }) => `${email} (${missing.join(', ')})`)
    .join('; ');
  const more = problems.length > 5 ? ` and ${problems.length - 5} more` : '';

  throw new ApiError(
    422,
    `${problems.length} recipient${problems.length === 1 ? '' : 's'} ` +
    `${problems.length === 1 ? 'is' : 'are'} missing values: ${shown}${more}. ` +
    'Fill them in, or remove those rows, and send again.',
    'merge_values_missing',
  );
}

/** The finished subject, html and text for one recipient. */
export function renderForRecipient({ subject, html, text }, vars) {
  const values = toValueMap(vars);
  return {
    subject: renderTemplate(subject, values),
    html: renderTemplate(html, values, { html: true }),
    text: renderTemplate(text, values),
  };
}
