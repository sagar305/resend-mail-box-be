import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { connectDb, getDbStatus } from './db.js';
import { requireAuth } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { draftsRouter } from './routes/drafts.js';
import { mailRouter } from './routes/mail.js';

/** Builds the app. Assumes the database is already connected. */
export function createApp() {
  const app = express();

  if (config.trustProxy) {
    // Railway and friends terminate TLS upstream; without this req.protocol and
    // req.ip report the internal hop instead of the client's.
    app.set('trust proxy', 1);
  }

  app.use(corsMiddleware);
  // Sized from the attachment budget (config.jsonBodyLimitBytes) rather than set
  // independently: base64 costs a third on top of every file, and an HTML body
  // with inline images is already well over the 100kb default on its own.
  app.use(express.json({ limit: config.jsonBodyLimitBytes }));
  app.use(cookieParser());

  // Liveness only — "the process is up". This is Railway's healthcheck target,
  // so it must not fail on a database problem: a failing healthcheck makes
  // Railway tear the container down, which is exactly when you need it up to
  // read /api/status. Both are unauthenticated by design.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Readiness — "is it actually working, and if not, why".
  app.get('/api/status', (_req, res) => {
    const mongo = getDbStatus();
    res.status(mongo.connected ? 200 : 503).json({
      ok: mongo.connected,
      mailboxAddress: config.mailboxAddress,
      mongo,
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/mail', requireAuth, mailRouter);
  app.use('/api/drafts', requireAuth, draftsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/*
 * Serverless entry point (Vercel).
 *
 * Vercel's Express preset imports this file and calls its default export once per
 * request; it never runs src/server.js, so nothing would ever dial MongoDB. This
 * handler builds the app on first use and connects lazily. The connection
 * promise is shared, so concurrent requests on a cold instance wait on one dial,
 * and it is dropped on failure so the next request tries again — meanwhile the
 * request still goes through, and data routes answer 503 as they do on Railway.
 *
 * Built lazily so importing this module (server.js, tests) has no side effects.
 */
let serverlessApp = null;
let connecting = null;

export default async function handler(req, res) {
  serverlessApp ??= createApp();
  if (!getDbStatus().connected) {
    connecting ??= connectDb().catch((error) => {
      connecting = null;
      console.error(`MongoDB connection failed: ${error.message}`);
    });
    await connecting;
  }
  return serverlessApp(req, res);
}
