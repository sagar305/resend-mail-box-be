# resend-mail-box-be

Backend for the Resend mailbox portal. It wraps the Resend API so a single
logged-in user can read received mail, browse sent mail, compose and send, and
keep drafts.

Frontend lives in [`resend-mail-box`](https://github.com/sagar305/resend-mail-box).

> **📖 New here? Read [SETUP.md](./SETUP.md).** It is the complete stepwise guide
> for both repositories — Resend, MongoDB, Railway and Vercel setup, every
> environment variable, and links to every library used. This README covers the
> backend's API and internals specifically.

## Stack

Node 20+ · Express 5 · plain JavaScript (ESM) · MongoDB · `resend` SDK

## Setup

```bash
npm install
cp .env.example .env    # then fill it in
npm run dev             # http://localhost:4000
```

You need a MongoDB to point `MONGO_URI` at. Either a free
[Atlas](https://www.mongodb.com/cloud/atlas) M0 cluster (same one you can use in
production), or a local instance:

```bash
docker run -d -p 27017:27017 --name mailbox-mongo mongo:7
# then MONGO_URI=mongodb://localhost:27017
```

The server starts listening immediately and connects to MongoDB in the
background, retrying every 10 seconds. A database problem therefore does not take
the process down: `GET /api/status` reports what is wrong, data routes answer
`503`, and the app recovers on its own once the database is reachable.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` | API key from <https://resend.com/api-keys>. |
| `MAILBOX_ADDRESS` | The single address all mail is sent from. Bare (`you@d.com`) or with a display name (`You <you@d.com>`). Must be on a domain verified in Resend, or `onboarding@resend.dev` for testing. |
| `MAILBOX_USER` | The one username that can sign in. |
| `MAILBOX_PASSWORD` | That user's password. |
| `SESSION_SECRET` | Signs the session JWT. Generate with `openssl rand -hex 32`. |
| `PORT` | Defaults to `4000`. Railway injects this. |
| `CORS_ORIGIN` | Allowed browser origins, comma separated. Entries may be exact (`https://app.vercel.app`), a wildcard host (`*.vercel.app`, which covers preview deploys), or `*`. Defaults to `http://localhost:5173`. Irrelevant when the frontend proxies `/api`. |
| `MONGO_URI` | **Required.** Connection string, e.g. `mongodb+srv://…` from Atlas or `mongodb://localhost:27017`. |
| `MONGO_DB` | Database name. Defaults to `mailbox`. |
| `SESSION_DAYS` | How long a login survives *without activity*. Defaults to `30`. |
| `COOKIE_SAMESITE` | `lax` (default) when the browser reaches the API on its own origin; `none` when the frontend calls this API cross-site. |
| `COOKIE_SECURE` | Defaults to true when `NODE_ENV=production`. Forced true when `COOKIE_SAMESITE=none`. |
| `TRUST_PROXY` | Trust `X-Forwarded-*`. Defaults to true in production. |
| `MAX_ATTACHMENT_COUNT` | Files allowed on one outgoing email. Defaults to `10`. |
| `MAX_ATTACHMENT_MB` | Largest single attachment. Defaults to `10`. Clamped to the total below. |
| `MAX_ATTACHMENTS_TOTAL_MB` | All attachments on one email combined. Defaults to `20`. Cannot exceed `30` — Resend's ceiling is 40 MB *after* base64. |

## What is stored in MongoDB, and why

Resend is an email API, not a mail host, so two things it does not model are kept
in Mongo:

| Collection | Contents |
| --- | --- |
| `drafts` | One document per draft. `_id` is a UUID string, not an ObjectId, so the id the API returns is the id stored. Indexed on `updatedAt` descending, which is the order they are listed in. |
| `readReceipts` | One document per message that has been **read**, with the Resend email id as `_id`. Absence means unread, so marking read is an upsert and marking unread is a delete. |

Everything else (sent mail, received mail, bodies, attachment metadata) is read
live from Resend and never mirrored. Both collections are created on first write
— there is no migration step.

## Auth

`POST /api/auth/login` compares the submitted credentials against
`MAILBOX_USER` / `MAILBOX_PASSWORD` using a constant-time comparison, then sets a
signed JWT in an **httpOnly** cookie (`mb_session`, `SameSite=Lax`, 30-day
expiry; `Secure` when `NODE_ENV=production`). Every `/api/mail/*` and
`/api/drafts/*` route requires that cookie and answers `401` without it.

The expiry **slides**: once a session passes the halfway point of its life, the
next authenticated request re-issues the cookie for a fresh 30 days. So the
window is 30 days of *inactivity*, not a hard cap — continued use never logs you
out mid-session. Renewal is skipped while a session is still fresh, because the
inbox polls every 60 seconds and signing a JWT that often would be waste. Change
the window with `SESSION_DAYS`.

## API

All routes are prefixed `/api`. Every route except `/health`, `/status` and `/auth/*`
requires the session cookie.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness only — is the process up. Railway's healthcheck target, so it stays `200` even when MongoDB is down. |
| `GET` | `/status` | Readiness — `200` when MongoDB is connected, `503` with a `mongo.reason` explaining why when it is not. Start here when something is broken. |
| `POST` | `/auth/login` | `{ username, password }` → sets the session cookie. |
| `POST` | `/auth/logout` | Clears the cookie. |
| `GET` | `/auth/me` | Current session, or `401`. |
| `GET` | `/mail/inbox` | Received mail. `?limit=1..100` (default 20), `?after=<id>` / `?before=<id>`. Each item carries a `read` flag. |
| `GET` | `/mail/inbox/:id` | Full received message, including body and attachment metadata. Opening it marks it read. |
| `GET` | `/mail/inbox/:id/attachments/:attachmentId` | Download a received attachment. Answers `302` to Resend's signed URL — follow redirects. |
| `PATCH` | `/mail/inbox/:id/read` | `{ read: false }` to mark unread again. |
| `GET` | `/mail/sent` | Sent mail, same pagination options. |
| `GET` | `/mail/sent/:id` | Full sent message with body and delivery status. |
| `GET` | `/mail/limits` | The attachment limits below, so the compose form can enforce the same ones before uploading: `{ attachments: { maxCount, maxFileBytes, maxTotalBytes, blockedExtensions } }`. |
| `POST` | `/mail/send` | `{ to, cc, bcc, subject, html, text?, attachments? }`. Recipients accept an array or a comma-separated string. `202` on accept. |
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

### Attachments on `/mail/send`

Each entry is `{ filename, content, contentType? }`, where `content` is the file
**base64 encoded** (a `data:…;base64,` prefix is tolerated and stripped).
`contentType` is optional — Resend infers it from the filename — and is dropped
unless it looks like a MIME type.

```json
{
  "to": "someone@example.com",
  "subject": "Invoice",
  "html": "<p>Attached.</p>",
  "attachments": [{ "filename": "invoice.pdf", "content": "JVBERi0xLjQK…" }]
}
```

Everything is validated before Resend is called, and every rejection is a `422`
with a message written to be shown to the user as-is:

| Rule | Default | Env |
| --- | --- | --- |
| Files per email | 10 | `MAX_ATTACHMENT_COUNT` |
| Size of one file | 10 MB | `MAX_ATTACHMENT_MB` |
| Size of all files in one email | 20 MB | `MAX_ATTACHMENTS_TOTAL_MB` |
| Blocked extensions | `.exe`, `.bat`, `.js`, `.jar`, … (54 in total) | — |

Filenames are reduced to their leaf (`../../etc/passwd` becomes `passwd`), and
content must be well-formed base64 and non-empty.

The blocklist is *our* policy, not Resend's: Resend would send a `.exe` happily,
but Gmail and Outlook reject it on arrival, so it is refused here rather than
bounced later. The list is `config.attachments.blockedExtensions` in
`src/config.js`.

Resend's own hard ceiling is **40 MB per email after base64 encoding**, which is
about 30 MB of actual files. `MAX_ATTACHMENTS_TOTAL_MB` is checked against that at
startup and the process refuses to boot if it is set higher. The
`express.json()` body limit is derived from the same number (total × 4/3 + 2 MB
of headroom for the HTML body) so the two can never drift apart, and a body over
it comes back as a `413` with a readable message rather than a bare 500.

Two things to know if you raise these limits: the whole file is buffered in
memory as a base64 string while the request is handled, and your proxies get a
vote — a Vercel `/api/*` rewrite and Railway both sit in front of this service and
will cut off an oversized body before Express ever sees it. Test a large send
against production, not just locally.

**Drafts do not carry attachments.** A Mongo document caps at 16 MB, which base64
files would blow through, so `POST /drafts` and `PUT /drafts/:id` ignore the
field — files have to be re-attached before sending. Storing them properly means
GridFS or object storage.

### Downloading a received attachment

Resend does not serve inbound attachment bytes from the API; it issues a
short-lived **signed URL**. `GET /mail/inbox/:id/attachments/:attachmentId` looks
that URL up and answers `302`, so any client just has to follow redirects
(`curl -L`, or a plain link in a browser).

Handing the URL over rather than streaming the file through this service saves it
the bandwidth of every download, and the URL expires on its own. Asking for it
still requires the session, so a redirect is only ever issued to a signed-in user
— but note that once issued, the URL itself is unauthenticated until it expires.
Swap `res.redirect` in `routes/mail.js` for a `fetch` and `pipe` if you would
rather the bytes never leave your origin. The response is `Cache-Control:
no-store` either way, since a cached redirect to an expired URL is a broken link.

**Inline images are filtered out of the attachment list.** An attachment with
`content_disposition: inline` *and* a `content_id` is a body part — a signature
logo, an embedded screenshot — and bodies are fetched with `html_format:
'data_uri'`, so it is already rendered inside the HTML. Listing it as a file too
would show the same image twice and put a paperclip on mail that has no real
attachment. `attachmentCount` counts the filtered list, so the badge agrees with
what the reading pane shows. Inline parts *without* a Content-ID are nothing to
do with the body and stay in the list.

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

## Deploying to Railway

`railway.json` sets the start command, and points Railway's healthcheck at
`/api/health`. Node is pinned to 22 via `.nvmrc`.

Because state lives in MongoDB rather than on disk, there is **no volume to
provision** — the service is stateless and survives redeploys on its own.

1. **Create a MongoDB Atlas cluster** (the free M0 tier is ample for one
   mailbox). Then, under Network Access, either allowlist Railway's egress IPs
   or use `0.0.0.0/0` with a strong database password — Atlas rejects
   connections from unlisted addresses, and this is the usual first thing to get
   wrong. Copy the connection string from Database → Connect → Drivers.
2. **New Project → Deploy from GitHub repo**, pick this repo and the branch.
3. **Set the variables** under Service → Variables:

   ```
   RESEND_API_KEY=re_...
   MAILBOX_ADDRESS=you@yourdomain.com
   MAILBOX_USER=admin
   MAILBOX_PASSWORD=<something long>
   SESSION_SECRET=<openssl rand -hex 32>
   MONGO_URI=mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   NODE_ENV=production
   ```

   Leave `PORT` alone — Railway injects it. `MONGO_DB` is optional and defaults
   to `mailbox`.
4. **Generate a domain** (Settings → Networking → Generate Domain) and note the
   `*.up.railway.app` URL. The frontend needs it.
5. Then pick one of the two ways to connect the frontend, below.

Prefer to keep everything on Railway? Deploy their MongoDB template as a second
service in the same project and use its private-network connection string as
`MONGO_URI` — then there is no IP allowlist and Mongo is never publicly exposed.

### Connecting the frontend: pick one

**A. Same-origin proxy — recommended.** The Vercel app rewrites `/api/*` to this
service, so the browser only ever talks to the Vercel domain. The session cookie
stays first-party, nothing extra is needed here:

```
COOKIE_SAMESITE=lax
```

**B. Direct cross-origin.** The browser calls Railway straight from the Vercel
page. This makes the session a *third-party* cookie:

```
COOKIE_SAMESITE=none
CORS_ORIGIN=https://your-app.vercel.app,*.vercel.app
```

Be aware that Safari blocks third-party cookies by default, and Chrome and
Firefox both offer settings that do the same — under option B those users cannot
stay signed in. That is why A is the default.

### If the deploy fails on startup

The process stays up even when MongoDB is unreachable, so check `GET /api/status`
first — it names the problem directly. The deploy logs carry the same diagnosis:

- `tlsv1 alert internal error` / `SSL alert number 80` — **not a certificate
  problem.** Atlas rejects connections from IPs that are not in the cluster's IP
  Access List by failing the TLS handshake. Add `0.0.0.0/0` under Network Access
  (Railway egress IPs are not static) and rely on a strong database password. A
  paused M0 cluster produces the identical error, so check it is running too.
- `MongoServerSelectionError … timed out` — Atlas unreachable. Also usually the
  Network Access allowlist.
- `MongoParseError` — the `MONGO_URI` is malformed. Watch for an unescaped `@`
  or `/` in the password; those need percent-encoding.
- `Missing required environment variable: X` — exactly what it says.

## Not included

Scoped out of this version: attachments on drafts (see above),
deleting sent or received mail (Resend
has no delete API), server-side search (Resend's list endpoints don't support
it), scheduled send, and conversation threading.
