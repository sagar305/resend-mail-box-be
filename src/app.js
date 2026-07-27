import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { getDbStatus } from './db.js';
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
  // Generous limit: an HTML body with inline images is easily over the 100kb default.
  app.use(express.json({ limit: '10mb' }));
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
