# resend-mail-box-be

Backend for the Resend mailbox portal. It wraps the Resend API so a single
logged-in user can read received mail, browse sent mail, compose and send, and
keep drafts.

Frontend lives in [`resend-mail-box`](https://github.com/sagar305/resend-mail-box).

## Stack

Node 20+ · Express 5 · plain JavaScript (ESM) · SQLite (`better-sqlite3`) · `resend` SDK

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
npm run dev             # http://localhost:4000
```

### Environment variables

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | API key from <https://resend.com/api-keys>. |
| `MAILBOX_ADDRESS` | The single address all mail is sent from. Bare (`you@d.com`) or with a display name (`You <you@d.com>`). Must be on a domain verified in Resend, or `onboarding@resend.dev` for testing. |
| `MAILBOX_USER` | The one username that can sign in. |
| `MAILBOX_PASSWORD` | That user's password. |
| `SESSION_SECRET` | Signs the session JWT. Generate with `openssl rand -hex 32`. |
| `PORT` | Defaults to `4000`. |
| `CORS_ORIGIN` | Allowed browser origin. Defaults to `http://localhost:5173`. |
| `DATABASE_FILE` | SQLite path, relative to the repo root. Defaults to `data/mailbox.db`. |

## What is stored locally, and why

Resend is an email API, not a mail host, so two things it does not model are kept
in SQLite:

- **Drafts** — Resend has no draft concept at all.
- **Read/unread state** — Resend does not track whether you have read an inbound
  message.

Everything else (sent mail, received mail, bodies, attachment metadata) is read
live from Resend and never mirrored.

## Auth

`POST /api/auth/login` compares the submitted credentials against
`MAILBOX_USER` / `MAILBOX_PASSWORD` using a constant-time comparison, then sets a
signed JWT in an **httpOnly** cookie (`mb_session`, `SameSite=Lax`, 24-hour
expiry; `Secure` when `NODE_ENV=production`). Every `/api/mail/*` and
`/api/drafts/*` route requires that cookie and answers `401` without it.

## API

All routes are prefixed `/api`. Every route except `/health` and `/auth/*`
requires the session cookie.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness check. |
| `POST` | `/auth/login` | `{ username, password }` → sets the session cookie. |
| `POST` | `/auth/logout` | Clears the cookie. |
| `GET` | `/auth/me` | Current session, or `401`. |
| `GET` | `/mail/inbox` | Received mail. `?limit=1..100` (default 20), `?after=<id>` / `?before=<id>`. Each item carries a `read` flag. |
| `GET` | `/mail/inbox/:id` | Full received message, including body and attachment metadata. Opening it marks it read. |
| `PATCH` | `/mail/inbox/:id/read` | `{ read: false }` to mark unread again. |
| `GET` | `/mail/sent` | Sent mail, same pagination options. |
| `GET` | `/mail/sent/:id` | Full sent message with body and delivery status. |
| `POST` | `/mail/send` | `{ to, cc, bcc, subject, html, text? }`. Recipients accept an array or a comma-separated string. `202` on accept. |
| `GET` | `/drafts` | All drafts, most recently updated first. |
| `POST` | `/drafts` | Create. Incomplete drafts are allowed — only address *format* is validated. |
| `GET` | `/drafts/:id` | One draft. |
| `PUT` | `/drafts/:id` | Replace a draft's contents. |
| `DELETE` | `/drafts/:id` | Delete. |
| `POST` | `/drafts/:id/send` | Send the draft, then delete it. |

Errors come back as `{ "error": { "message": string, "code": string \| null } }`.
Resend's own error names are mapped onto sensible HTTP statuses (`validation_error`
→ 422, `not_found` → 404, `rate_limit_exceeded` → 429, key/API problems → 502).

Pagination is Resend's cursor scheme: pass `after=<last id on the page>` for the
next page or `before=<first id>` for the previous one — never both.

### One caveat on `/mail/sent`

Resend's list-sent-emails endpoint returns everything sent by the **API key's
account**, and takes no `from` filter. It is passed through unfiltered here: if
the same Resend account sends mail from other addresses or other apps, that mail
shows up under Sent too. Filtering client-side was deliberately avoided because
it breaks cursor pagination — a 20-item page can filter down to zero while
`has_more` is still true. Use a dedicated Resend account or API key per mailbox
if you need Sent to show only this address.

## Receiving mail

Inbound mail is **pulled** from Resend's received-emails API when the frontend
asks for it (and on a 60-second poll while the inbox is open). There is no
webhook endpoint, so nothing needs to be publicly reachable.

For inbound mail to exist at all, a domain in your Resend account needs the
inbound **MX record**, and it must be the lowest-priority MX record for that
domain. If the domain already handles real mail, put the record on a subdomain
instead. Until that is configured, the inbox is simply empty — the app still
runs and sending still works. See
[Resend's receiving docs](https://resend.com/docs/dashboard/receiving/introduction).

## Not included

Scoped out of this version: attachments on outgoing mail (received attachment
metadata is shown but not downloadable), deleting sent or received mail (Resend
has no delete API), server-side search (Resend's list endpoints don't support
it), scheduled send, and conversation threading.
