import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config.js';
import './db.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { authRouter } from './routes/auth.js';
import { draftsRouter } from './routes/drafts.js';
import { mailRouter } from './routes/mail.js';

const app = express();

app.use(cors({ origin: config.corsOrigin, credentials: true }));
// Generous limit: an HTML body with inline images is easily over the 100kb default.
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/mail', requireAuth, mailRouter);
app.use('/api/drafts', requireAuth, draftsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`Mailbox API listening on http://localhost:${config.port}`);
  console.log(`Sending as: ${config.mailboxAddress}`);
});
