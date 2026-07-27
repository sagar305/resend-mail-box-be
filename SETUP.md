# Resend Mailbox — Complete Setup Guide

A single-user webmail portal built on [Resend](https://resend.com): read received
mail, browse sent mail, compose with a rich-text editor, and keep drafts.

This guide covers **both repositories** and every external service. It is
identical in both repos, so whichever one you landed in, you have the whole
picture.

| Repository | Role |
| --- | --- |
| [`resend-mail-box`](https://github.com/sagar305/resend-mail-box) | React frontend, deploys to Vercel |
| [`resend-mail-box-be`](https://github.com/sagar305/resend-mail-box-be) | Express API, deploys to Railway |

---

## Table of contents

1. [How the pieces fit together](#1-how-the-pieces-fit-together)
2. [Prerequisites](#2-prerequisites)
3. [Step 1 — Set up Resend](#3-step-1--set-up-resend)
4. [Step 2 — Set up MongoDB](#4-step-2--set-up-mongodb)
5. [Step 3 — Run locally](#5-step-3--run-locally)
6. [Step 4 — Deploy the backend to Railway](#6-step-4--deploy-the-backend-to-railway)
7. [Step 5 — Deploy the frontend to Vercel](#7-step-5--deploy-the-frontend-to-vercel)
8. [Environment variable reference](#8-environment-variable-reference)
9. [How the frontend reaches the backend, and why there is no CORS](#9-how-the-frontend-reaches-the-backend-and-why-there-is-no-cors)
10. [Libraries used](#10-libraries-used)
11. [Troubleshooting](#11-troubleshooting)
12. [What is not included](#12-what-is-not-included)

---

## 1. How the pieces fit together

```
                    ┌──────────────────────────────────────┐
                    │  Vercel — your-app.vercel.app        │
   your browser ───►│  • serves the React app              │
                    │  • rewrites /api/* ────────┐         │
                    └────────────────────────────┼─────────┘
                                                 ▼
                    ┌──────────────────────────────────────┐
                    │  Railway — your-api.up.railway.app   │
                    │  • Express API                       │
                    │  • holds every secret                │
                    │  • the only thing that talks to      │
                    │    Resend and MongoDB                │
                    └──────┬────────────────────┬──────────┘
                           ▼                    ▼
        ┌────────────────────────┐  ┌──────────────────────────┐
        │  MongoDB Atlas         │  │  Resend                  │
        │  • drafts              │  │  • sends mail            │
        │  • read/unread state   │  │  • sent-mail log         │
        └────────────────────────┘  │  • received mail         │
                                    └──────────────────────────┘
```

**Four services, and each has exactly one job.** The browser only ever talks to
Vercel. Your Resend key, mailbox password and Mongo credentials live only on
Railway and are never sent to the browser.

### What lives where, and why

Resend is an **email API, not a mail host** — there is no IMAP mailbox sitting on
a server somewhere. That shapes the whole design:

| Data | Source | Why |
| --- | --- | --- |
| Sent mail | Read live from Resend | Resend logs everything it sends |
| Received mail | Read live from Resend | Requires an inbound MX record (see step 1) |
| Message bodies | Read live from Resend | Never mirrored locally |
| **Drafts** | **MongoDB** | Resend has no concept of a draft |
| **Read/unread** | **MongoDB** | Resend does not track whether you read something |

---

## 2. Prerequisites

| Requirement | Notes |
| --- | --- |
| [Node.js](https://nodejs.org) 20 or newer | Pinned to 22 for deploys via `.nvmrc` |
| A domain you control DNS for | Needed to send from your own address, and required to receive at all |
| Accounts | [Resend](https://resend.com), [MongoDB Atlas](https://www.mongodb.com/cloud/atlas), [Railway](https://railway.com), [Vercel](https://vercel.com) — all have free tiers sufficient for this |

Local development also needs a MongoDB — either a Docker container or the same
Atlas cluster you use in production. Both are covered in step 2.

---

## 3. Step 1 — Set up Resend

### 1.1 Create an account and API key

1. Sign up at <https://resend.com>.
2. Go to **[API Keys](https://resend.com/api-keys)** → **Create API Key**.
3. Give it **Full access** (the app both sends and reads mail).
4. Copy the key — it starts with `re_` and is shown only once.

→ This becomes `RESEND_API_KEY`.

### 1.2 Verify a domain, so you can send

You can skip this to start: Resend gives you `onboarding@resend.dev` for testing.
**But that test address can only send to the email address you registered your
Resend account with** — fine for a first smoke test, useless for real mail.

To send from your own address:

1. Go to **[Domains](https://resend.com/domains)** → **Add Domain**.
2. Enter your domain, e.g. `yourdomain.com`.
3. Resend shows DNS records to add — an **SPF** (TXT) record and **DKIM** records.
   Add them at your DNS provider.
4. Click **Verify**. Propagation is usually minutes but can take up to 72 hours.
5. Once it shows **Verified**, you can send from any address on that domain.

→ Your chosen address becomes `MAILBOX_ADDRESS`, e.g. `me@yourdomain.com`.
A display name is optional: `Sagar <me@yourdomain.com>`.

Docs: [Domain setup](https://resend.com/docs/dashboard/domains/introduction)

### 1.3 Add the MX record, so you can receive

**Without this step the Inbox will be permanently empty.** Everything else —
login, compose, send, Sent, drafts — works fine, but no mail can arrive.

1. Go to **[Domains](https://resend.com/domains)** and open your domain.
2. Find the **inbound MX record** Resend gives you.
3. Add it at your DNS provider. **It must be the lowest-priority MX record for
   that domain** — mail is delivered to the lowest-priority MX, so if another
   record outranks it, Resend never sees your mail.
4. If the domain already handles real email (Google Workspace, etc.), **do not
   replace those records.** Use a subdomain instead — e.g. put the MX record on
   `mail.yourdomain.com` and receive at `anything@mail.yourdomain.com`.

Once the MX record is live, **every address at that domain or subdomain** is
received — `hello@`, `support@`, anything.

Docs: [Receiving email](https://resend.com/docs/dashboard/receiving/introduction) ·
[Custom receiving domains](https://resend.com/docs/dashboard/receiving/custom-domains) ·
[Avoiding MX conflicts](https://resend.com/docs/knowledge-base/how-do-i-avoid-conflicting-with-my-mx-records)

### 1.4 What you should have after step 1

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
MAILBOX_ADDRESS=you@yourdomain.com
```

There is **nothing to configure in Resend for webhooks.** This app *pulls*
received mail from Resend's API when you open the Inbox (and every 60 seconds
while it's open), so nothing needs to be publicly reachable and there is no
webhook endpoint to register.

---

## 4. Step 2 — Set up MongoDB

MongoDB stores drafts and read/unread state. Everything else comes from Resend.

### 4.1 For production: MongoDB Atlas

1. Sign up at <https://www.mongodb.com/cloud/atlas> and **create a free M0
   cluster**.
2. **Database Access** → **Add New Database User**. Use a long random password.
   If it contains `@ : / ? #`, you must percent-encode it in the URI later, so
   generating one without those characters saves pain.
3. **Network Access** → **Add IP Address** → **Allow Access From Anywhere**
   (`0.0.0.0/0`).

   > **Do not skip this.** Railway does not give you a static outbound IP on
   > standard plans, so there is no single address to allowlist. Atlas rejects
   > non-allowlisted IPs by **failing the TLS handshake**, which produces a
   > confusing `tlsv1 alert internal error` that looks like a certificate
   > problem. Your protection is the strong database password.

4. **Database** → **Connect** → **Drivers** → **Node.js**. Copy the connection
   string.

→ This becomes `MONGO_URI`, e.g.
`mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`

> Free M0 clusters **auto-pause after inactivity**, and a paused cluster produces
> the same TLS error. If connections suddenly fail, check the cluster is running.

### 4.2 For local development

Either point at the same Atlas cluster, or run one locally:

```bash
docker run -d -p 27017:27017 --name mailbox-mongo mongo:7
# then use: MONGO_URI=mongodb://localhost:27017
```

### 4.3 No schema setup needed

Both collections (`drafts` and `readReceipts`) are created on first write, and
the index is created at startup. There is no migration step.

| Collection | Shape |
| --- | --- |
| `drafts` | One document per draft. `_id` is a UUID string, not an ObjectId. Indexed `updatedAt: -1`. |
| `readReceipts` | One document per message that has been **read**, keyed by Resend's email id. Absence means unread. |

---

## 5. Step 3 — Run locally

### 5.1 Backend

```bash
git clone https://github.com/sagar305/resend-mail-box-be
cd resend-mail-box-be
npm install
cp .env.example .env
```

Edit `.env`:

```env
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
MAILBOX_ADDRESS=you@yourdomain.com
MAILBOX_USER=admin
MAILBOX_PASSWORD=pick-something
SESSION_SECRET=<paste output of: openssl rand -hex 32>
MONGO_URI=mongodb://localhost:27017
```

Generate the session secret with:

```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```bash
npm run dev        # http://localhost:4000
```

You should see:

```
MongoDB connected (database: mailbox)
Mailbox API listening on port 4000
```

The server starts listening straight away and connects to MongoDB in the
background, retrying every 10 seconds. So a database problem never takes the
process down — `curl http://localhost:4000/api/status` tells you what is wrong,
and it recovers by itself once the database is reachable.

### 5.2 Frontend

In a second terminal:

```bash
git clone https://github.com/sagar305/resend-mail-box
cd resend-mail-box
npm install
npm run dev        # http://localhost:5173
```

**No `.env` needed.** Vite proxies `/api` to `http://localhost:4000`
automatically.

### 5.3 Check it

Open <http://localhost:5173> and sign in with the `MAILBOX_USER` /
`MAILBOX_PASSWORD` you chose.

```bash
curl http://localhost:4000/api/health    # {"ok":true}
curl http://localhost:5173/api/health    # {"ok":true} → the proxy is working
```

---

## 6. Step 4 — Deploy the backend to Railway

`railway.json` already sets the start command and points the healthcheck at
`/api/health`; `.nvmrc` pins Node 22. **No volume is needed** — state lives in
MongoDB, so the service is stateless and survives redeploys.

1. Go to <https://railway.com> → **New Project** → **Deploy from GitHub repo**.
2. Pick `resend-mail-box-be` and the branch you want.
3. **Variables** → add:

   ```env
   RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
   MAILBOX_ADDRESS=you@yourdomain.com
   MAILBOX_USER=admin
   MAILBOX_PASSWORD=<something long>
   SESSION_SECRET=<openssl rand -hex 32>
   MONGO_URI=mongodb+srv://user:password@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   NODE_ENV=production
   ```

   **Leave `PORT` unset** — Railway injects it. `MONGO_DB` is optional and
   defaults to `mailbox`.

   Generate a *fresh* `SESSION_SECRET` for production. Don't reuse your local one.

4. **Settings → Networking → Generate Domain.** Copy the
   `*.up.railway.app` URL — the frontend needs it in step 5.
5. Confirm it's alive:

   ```bash
   curl https://your-api.up.railway.app/api/health    # {"ok":true}  process is up
   curl https://your-api.up.railway.app/api/status    # {"ok":true}  MongoDB is connected too
   ```

   `/api/health` reports only that the process is alive — it is Railway's
   healthcheck target, so it deliberately stays `200` even when MongoDB is
   unreachable, because a failing healthcheck makes Railway tear the container
   down precisely when you need it up to diagnose. **`/api/status` is the one that
   tells you the truth**, returning `503` with a `mongo.reason` you can act on.
   The backend keeps retrying the database every 10 seconds, so once you fix
   Atlas it recovers on its own with no redeploy.

> Prefer to keep everything on Railway? Deploy their MongoDB template as a
> second service in the same project and use its **private network** connection
> string as `MONGO_URI`. Then there is no IP allowlist and Mongo is never
> publicly exposed.

---

## 7. Step 5 — Deploy the frontend to Vercel

### 7.1 Put your Railway URL in `vercel.json`

This is **the only manual code edit in either repo.** `vercel.json` already
points at this project's own Railway service; change the host on line 9 only if
you are deploying your own backend:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://your-api.up.railway.app/api/:path*"
    }
  ]
}
```

Keep the `/api/:path*` on the destination — the backend mounts its routes under
`/api`, so dropping it sends requests to the wrong paths.

It has to be a literal string here because **Vercel does not interpolate
environment variables into rewrite destinations.** A backend URL is not a secret,
so committing it is fine.

Commit and push.

> **Do not also set `VITE_API_BASE_URL`.** It is inlined at build time and takes
> precedence over this rewrite, so setting both means the rewrite is ignored and
> every request goes cross-origin — which makes the session a third-party cookie
> that iOS blocks outright. Use one or the other, and the rewrite is the one that
> works everywhere. If you have both, fix this file first, confirm
> `curl https://your-app.vercel.app/api/health` returns `{"ok":true}`, and only
> then remove the variable.

### 7.2 Import on Vercel

1. Go to <https://vercel.com> → **Add New** → **Project** → import
   `resend-mail-box`.
2. Change nothing. Framework, build command and output directory all come from
   `vercel.json`.
3. **No environment variables are needed.**
4. Deploy.

### 7.3 Check it

```bash
curl https://your-app.vercel.app/api/health
```

| Result | Meaning |
| --- | --- |
| `{"ok":true}` | The rewrite is live and reaching Railway. You're done. |
| `404` | `vercel.json` wasn't applied, or the destination is wrong. |
| `502` / timeout | The rewrite works but Railway is unhealthy — check its logs. |

Then open the Vercel URL and sign in.

---

## 8. Environment variable reference

### Backend — required (6)

The server exits immediately with
`Missing required environment variable: X` if any is absent.

| Variable | Value |
| --- | --- |
| `RESEND_API_KEY` | From <https://resend.com/api-keys> |
| `MAILBOX_ADDRESS` | The address all mail sends from. `you@d.com` or `You <you@d.com>` |
| `MAILBOX_USER` | The single login username |
| `MAILBOX_PASSWORD` | Its password |
| `SESSION_SECRET` | Signs the session JWT. `openssl rand -hex 32` |
| `MONGO_URI` | `mongodb+srv://…` (Atlas) or `mongodb://localhost:27017` |

### Backend — optional (7)

| Variable | Default | Set it when |
| --- | --- | --- |
| `MONGO_DB` | `mailbox` | You want a different database name |
| `SESSION_DAYS` | `30` | You want a shorter or longer login. This is an **inactivity** window — the expiry slides forward while you keep using the app, so active use never logs you out |
| `PORT` | `4000` | Never on Railway — it injects this |
| `NODE_ENV` | unset | **Set `production` on Railway.** Flips `COOKIE_SECURE` and `TRUST_PROXY` defaults to true |
| `CORS_ORIGIN` | `http://localhost:5173` | Only for the cross-origin setup. Comma-separated; `*.vercel.app` matches preview deploys |
| `COOKIE_SAMESITE` | `lax` | `none` for the cross-origin setup. Only `lax`/`strict`/`none` — anything else fails the boot |
| `COOKIE_SECURE` | true when `NODE_ENV=production` | Rarely. Forced true when SameSite is `none` |
| `TRUST_PROXY` | true when `NODE_ENV=production` | Rarely |

Booleans accept `1`, `true` or `yes`.

### Frontend — both optional, and **Vercel needs neither**

| Variable | Default | Set it when |
| --- | --- | --- |
| `VITE_API_PROXY_TARGET` | `http://localhost:4000` | Local dev only, if your backend is on a different port |
| `VITE_API_BASE_URL` | empty (same-origin `/api`) | **Only** for the cross-origin setup — see section 9 |

Two Vite rules worth knowing: only `VITE_`-prefixed variables reach browser code
at all, and they are **inlined into the bundle at build time**, so anyone can
read them in DevTools. That is exactly why every secret lives on the backend and
the frontend never receives one.

---

## 9. How the frontend reaches the backend, and why there is no CORS

The frontend has **no hardcoded backend URL anywhere in `src/`.** One line in
`src/api/client.js` drives everything:

```js
const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';   // → '' by default
fetch(`${BASE_URL}/api${path}`)                             // → '/api/mail/inbox'
```

A **relative** URL means "same origin as the page I'm loaded from". The browser
fills in the host, and a proxy forwards it:

| Environment | Browser requests | Forwarded by | To |
| --- | --- | --- | --- |
| Local dev | `localhost:5173/api/…` | `vite.config.js` proxy | `localhost:4000/api/…` |
| Production | `your-app.vercel.app/api/…` | `vercel.json` rewrite | `your-api.up.railway.app/api/…` |

Identical shape in both, which is why local testing genuinely reflects
production.

**There is no CORS to configure, because no cross-origin request happens.** The
Vercel rewrite is a server-side proxy, not a redirect — the browser is never told
about Railway. Consequently:

- No preflight `OPTIONS` request.
- No `Access-Control-Allow-Origin` headers needed. `CORS_ORIGIN` is unused.
- The session cookie is **first-party** to the Vercel domain, so `SameSite=Lax`
  is enough and Safari's third-party-cookie blocking never applies.

CORS is a browser policy; Vercel's edge is not a browser.

### The cross-origin alternative

Set `VITE_API_BASE_URL=https://your-api.up.railway.app` on Vercel and the same
line produces an absolute URL, so the browser calls Railway directly. **Then CORS
does matter**, and Railway needs:

```env
CORS_ORIGIN=https://your-app.vercel.app,*.vercel.app
COOKIE_SAMESITE=none
```

The trade-off: the session cookie becomes third-party. **Safari blocks those by
default**, so those users log in and are immediately logged out again; Chrome and
Firefox can be configured to do the same. Use the rewrite unless you have a
specific reason not to.

---

## 10. Libraries used

### Backend (`resend-mail-box-be`)

| Package | Version | Purpose | Docs |
| --- | --- | --- | --- |
| `express` | ^5.2.1 | HTTP server and routing | <https://expressjs.com> |
| `mongodb` | ^7.5.0 | Official MongoDB driver | <https://www.mongodb.com/docs/drivers/node/current/> |
| `resend` | ^6.18.0 | Resend API SDK | <https://resend.com/docs/api-reference/introduction> · [GitHub](https://github.com/resend/resend-node) |
| `jsonwebtoken` | ^9.0.3 | Signs and verifies the session JWT | <https://github.com/auth0/node-jsonwebtoken> |
| `cookie-parser` | ^1.4.7 | Reads the session cookie | <https://github.com/expressjs/cookie-parser> |
| `cors` | ^2.8.6 | CORS headers for the cross-origin setup | <https://github.com/expressjs/cors> |
| `dotenv` | ^17.4.2 | Loads `.env` in development | <https://github.com/motdotla/dotenv> |

### Frontend (`resend-mail-box`)

| Package | Version | Purpose | Docs |
| --- | --- | --- | --- |
| `react` / `react-dom` | ^19.2.7 | UI framework | <https://react.dev> |
| `vite` | ^8.1.1 | Dev server and bundler | <https://vite.dev> |
| `@vitejs/plugin-react` | ^6.0.3 | React support for Vite | <https://github.com/vitejs/vite-plugin-react> |
| `tailwindcss` | ^4.3.3 | Utility-first CSS | <https://tailwindcss.com> |
| `@tailwindcss/vite` | ^4.3.3 | Tailwind v4 Vite plugin | <https://tailwindcss.com/docs/installation/using-vite> |
| `@tiptap/react` | ^3.29.0 | Rich-text editor for the composer | <https://tiptap.dev/docs/editor/getting-started/install/react> |
| `@tiptap/starter-kit` | ^3.29.0 | Bundles bold, italic, underline, headings, lists, quote, code, link | <https://tiptap.dev/docs/editor/extensions/functionality/starterkit> |
| `@tiptap/extensions` | ^3.29.0 | Provides the editor placeholder | <https://tiptap.dev/docs/editor/extensions/functionality/placeholder> |
| `oxlint` | ^1.71.0 | Linter | <https://oxc.rs> |

No icon library and no component library — the icons are hand-written inline
SVGs in `src/components/Icons.jsx`.

### Services

| Service | Role | URL |
| --- | --- | --- |
| Resend | Sends and receives the actual email | <https://resend.com> · [Docs](https://resend.com/docs) |
| MongoDB Atlas | Stores drafts and read/unread state | <https://www.mongodb.com/cloud/atlas> |
| Railway | Hosts the backend | <https://railway.com> · [Docs](https://docs.railway.com) |
| Vercel | Hosts the frontend | <https://vercel.com> · [Docs](https://vercel.com/docs) |

---

## 11. Troubleshooting

### Backend won't start

Check the Railway deploy logs. The failure is reported in one readable line.

| Log message | Cause and fix |
| --- | --- |
| `tlsv1 alert internal error` / `SSL alert number 80` | **Not a certificate problem.** Atlas is rejecting this server's IP. Add `0.0.0.0/0` under Atlas → Network Access. A paused M0 cluster gives the identical error, so check the cluster is running. |
| `MongoServerSelectionError … timed out` | Atlas unreachable — usually the same allowlist issue. |
| `MongoParseError` | Malformed `MONGO_URI`. Percent-encode `@ : / ? #` in the password. |
| `bad auth` / `Authentication failed` | Wrong database username or password. |
| `Missing required environment variable: X` | Exactly what it says. |
| `COOKIE_SAMESITE must be lax, strict or none` | Typo in that variable. |

### The app loads but nothing works

```bash
curl https://your-app.vercel.app/api/health
```

A `404` means the `vercel.json` rewrite isn't in effect — check you replaced the
placeholder host and pushed.

### It logs me out by itself — especially on iPhone or iPad

There is exactly one involuntary logout path in the app: **any API response of
`401` signs you out**, including the inbox's 60-second poll. So this always means
the session cookie stopped being accepted. Two causes:

0. **The backend is simply down.** Check this first — until the fix below shipped,
   a server outage made the app render the *login screen*, which is
   indistinguishable from having been logged out. It now shows "Can't reach the
   mailbox server" instead. Confirm with
   `curl https://your-app.vercel.app/api/status`.

1. **Safari is blocking the cookie.** If you deployed with `VITE_API_BASE_URL`
   instead of the `vercel.json` rewrite, the browser calls Railway directly and
   `mb_session` becomes a **third-party** cookie. iOS Safari has *Prevent
   Cross-Site Tracking* on by default and blocks those outright — which is why it
   works on desktop Chrome and fails on an iPad.

   **The rewrite existing is NOT the same as the app using it.**
   `VITE_API_BASE_URL` is inlined into the bundle at *build* time, so
   `curl https://your-app.vercel.app/api/health` can return `{"ok":true}` — proving
   the rewrite works — while the app still calls Railway directly. Check both:

   1. **Vercel → Settings → Environment Variables.** If `VITE_API_BASE_URL` is
      there, that is the bug. Delete it and redeploy.
   2. **DevTools → Network**, then sign in. Look at the request URL for
      `auth/login`. If it points at `*.up.railway.app` instead of your own domain,
      the app is going cross-origin.

   As of the cookie check added to login, the app now detects this itself and says
   so on screen rather than bouncing you back to an empty login form.

   **Fix:** remove `VITE_API_BASE_URL` from Vercel, put your real Railway host in
   `vercel.json`, redeploy.

2. **The session genuinely expired.** `SESSION_DAYS` (default 30) is the allowed
   window of *inactivity*; the expiry slides forward on use, so this only fires
   if you truly haven't opened the app in that long.

Also worth ruling out on the device: **Settings → Safari → Block All Cookies**
must be off, and a **Private Browsing** tab discards storage far more
aggressively. A site added to your Home Screen is a separate storage context from
Safari, so it needs its own one-time login.

### The Inbox is empty

Expected until the inbound **MX record** is live and is the lowest-priority MX
for your domain (step 1.3). The app says so on screen rather than pretending to
be broken. Sending works regardless.

### Sent shows mail I didn't send from this app

Resend's list-sent-emails endpoint returns everything sent by **the API key's
account** and takes no sender filter. If the same Resend account sends from other
addresses or other apps, that mail appears here too. Use a dedicated Resend
account or key per mailbox if you need Sent scoped to one address.

### Sending fails with a recipient error

If `MAILBOX_ADDRESS` is `onboarding@resend.dev`, Resend only allows sending to
the email you registered your Resend account with. Verify your own domain
(step 1.2).

---

## 12. What is not included

Deliberately out of scope in this version:

- **Attachments on outgoing mail.** Received attachments are listed with name and
  size but are not downloadable.
- **Deleting sent or received mail.** Resend has no delete API, so this could
  only ever be a local hide.
- **Search.** Resend's list endpoints offer cursor pagination but no search, so
  the folders have "Load more" instead.
- **Scheduled send.** Resend supports `scheduledAt`; the UI does not expose it.
- **Conversation threading.** Messages are listed flat. Reply and Forward prefill
  a compose window and quote the original, but nothing is grouped into threads.
- **Multiple users or mailboxes.** One username and one from-address, both from
  environment variables.
- **Mobile layout.** Desktop-oriented three-pane UI, light theme only.

---

## Security notes

- Every secret lives **only** on the backend. The frontend bundle contains none.
- The session is an **httpOnly** cookie, so JavaScript cannot read it — including
  any XSS that might land on the page.
- Credentials are compared in **constant time**, so a wrong guess can't be timed
  against a right one.
- **Message bodies render in a sandboxed `<iframe>` without `allow-scripts`.**
  Inbound mail is HTML written by strangers; nothing in a message can execute.
- Rotating `SESSION_SECRET` invalidates every active session at once — that's
  your kill switch. Drafts in MongoDB are unaffected.
