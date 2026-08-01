import { Resend } from 'resend';
import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';

const resend = new Resend(config.resendApiKey);

// Resend returns { data, error } rather than throwing. Map its error names onto
// HTTP statuses so the frontend can react to them.
const STATUS_BY_ERROR_NAME = {
  validation_error: 422,
  invalid_parameter: 422,
  missing_required_field: 422,
  not_found: 404,
  invalid_api_key: 502,
  missing_api_key: 502,
  restricted_api_key: 502,
  rate_limit_exceeded: 429,
  daily_quota_exceeded: 429,
  application_error: 502,
  internal_server_error: 502,
};

function unwrap({ data, error }) {
  if (error) {
    const status = STATUS_BY_ERROR_NAME[error.name] ?? 502;
    throw new ApiError(status, error.message || 'Resend request failed', error.name);
  }
  return data;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/** Trim an HTML/text body down to a one-line preview for the message list. */
function buildPreview(html, text) {
  const source = text || html || '';
  return source
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function normalizeSent(email) {
  return {
    id: email.id,
    folder: 'sent',
    from: email.from,
    to: toArray(email.to),
    cc: toArray(email.cc),
    bcc: toArray(email.bcc),
    replyTo: toArray(email.reply_to),
    subject: email.subject || '(no subject)',
    createdAt: email.created_at,
    scheduledAt: email.scheduled_at ?? null,
    lastEvent: email.last_event ?? null,
    messageId: email.message_id ?? null,
  };
}

/**
 * An inline part carrying a Content-ID is body content — a signature logo, an
 * embedded screenshot — and we fetch bodies with `html_format: 'data_uri'`, so it
 * is already rendered inside the HTML. Listing it as a file too would show the
 * same image twice and put a paperclip on mail that has no real attachment.
 */
function isInlineBodyPart(attachment) {
  return attachment.content_disposition === 'inline' && Boolean(attachment.content_id);
}

function fileAttachments(email) {
  return toArray(email.attachments).filter((attachment) => !isInlineBodyPart(attachment));
}

function normalizeAttachment(attachment) {
  return {
    id: attachment.id ?? null,
    filename: attachment.filename ?? null,
    contentType: attachment.content_type ?? null,
    size: attachment.size ?? null,
  };
}

function normalizeReceived(email) {
  return {
    id: email.id,
    folder: 'inbox',
    from: email.from,
    to: toArray(email.to),
    cc: toArray(email.cc),
    bcc: toArray(email.bcc),
    replyTo: toArray(email.reply_to),
    receivedFor: toArray(email.received_for),
    subject: email.subject || '(no subject)',
    createdAt: email.created_at,
    attachmentCount: fileAttachments(email).length,
    messageId: email.message_id ?? null,
  };
}

/**
 * Resend's cursor pagination takes `before` OR `after`, never both, and rejects
 * the pair being present together — so only ever pass the one we were given.
 */
function paginationOptions({ limit, before, after }) {
  const options = { limit };
  if (after) options.after = after;
  else if (before) options.before = before;
  return options;
}

export async function listSent(pagination) {
  const result = unwrap(await resend.emails.list(paginationOptions(pagination)));
  return {
    messages: (result.data || []).map(normalizeSent),
    hasMore: Boolean(result.has_more),
  };
}

/**
 * Sent mail carries no attachment metadata on the email object itself — Resend
 * keeps it behind a separate endpoint — so it has to be asked for on the side.
 * A failure there must not take the message with it: the body is what was asked
 * for, and losing the whole view because a file list would not load is worse
 * than showing the mail without it.
 */
async function listSentAttachments(emailId) {
  const { data, error } = await resend.emails.attachments.list({ emailId });
  if (error) {
    console.error(`Could not list attachments for sent email ${emailId}: ${error.message}`);
    return [];
  }
  return (data?.data || [])
    .filter((attachment) => !isInlineBodyPart(attachment))
    .map(normalizeAttachment);
}

export async function getSent(id) {
  const [email, attachments] = await Promise.all([
    resend.emails.get(id).then(unwrap),
    listSentAttachments(id),
  ]);
  return {
    ...normalizeSent(email),
    html: email.html ?? null,
    text: email.text ?? null,
    preview: buildPreview(email.html, email.text),
    attachments,
  };
}

export async function listReceived(pagination) {
  const result = unwrap(await resend.emails.receiving.list(paginationOptions(pagination)));
  return {
    messages: (result.data || []).map(normalizeReceived),
    hasMore: Boolean(result.has_more),
  };
}

export async function getReceived(id) {
  // data_uri keeps inline images renderable without a second attachment fetch.
  const email = unwrap(await resend.emails.receiving.get(id, { html_format: 'data_uri' }));
  return {
    ...normalizeReceived(email),
    html: email.html ?? null,
    text: email.text ?? null,
    preview: buildPreview(email.html, email.text),
    attachments: fileAttachments(email).map(normalizeAttachment),
  };
}

/**
 * Resend keeps attachments behind a short-lived signed URL rather than serving
 * the bytes from the API, so this is metadata plus that URL — see the download
 * routes in routes/mail.js for why it is handed out rather than proxied.
 *
 * Received and sent mail have separate endpoints for it; `folder` picks one.
 */
export async function getAttachment(folder, emailId, attachmentId) {
  const endpoint =
    folder === 'inbox' ? resend.emails.receiving.attachments : resend.emails.attachments;
  const attachment = unwrap(await endpoint.get({ emailId, id: attachmentId }));
  return {
    id: attachment.id,
    filename: attachment.filename ?? 'attachment',
    contentType: attachment.content_type ?? null,
    size: attachment.size ?? null,
    downloadUrl: attachment.download_url,
    expiresAt: attachment.expires_at ?? null,
  };
}

export async function sendMail({ to, cc, bcc, subject, html, text, attachments }) {
  const payload = {
    from: config.mailboxAddress,
    to,
    subject,
    html,
    text,
  };
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  if (attachments?.length) {
    // Rebuilt field by field: our attachments carry validation leftovers Resend
    // has no use for, and `content` must be the bare base64 string.
    payload.attachments = attachments.map(({ filename, content, contentType }) => ({
      filename,
      content,
      ...(contentType ? { contentType } : {}),
    }));
  }

  const result = unwrap(await resend.emails.send(payload));
  return { id: result.id };
}
