import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import './db.js';
import { requireAuth } from './middleware/auth.js';
import { corsMiddleware } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { draftsRouter } from './routes/drafts.js';
import { mailRouter } from './routes/mail.js';

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

// Railway's healthcheck target. Deliberately unauthenticated.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/mail', requireAuth, mailRouter);
app.use('/api/drafts', requireAuth, draftsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// 0.0.0.0 so the container is reachable from outside itself.
app.listen(config.port, '0.0.0.0', () => {
  console.log(`Mailbox API listening on port ${config.port}`);
  console.log(`Sending as: ${config.mailboxAddress}`);
  console.log(`Allowed origins: ${config.corsOrigins.join(', ')}`);
  console.log(
    `Session cookie: SameSite=${config.auth.cookieSameSite}; Secure=${config.auth.cookieSecure}`,
  );
  console.log(`Database: ${config.databaseFile}`);
});
