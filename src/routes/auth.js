import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';
import { clearSession, issueSession, readSession, refreshSessionIfStale } from '../middleware/auth.js';

export const authRouter = Router();

/** Constant-time compare so a wrong guess can't be timed against a right one. */
function matches(candidate, expected) {
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

authRouter.post('/login', (req, res, next) => {
  try {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      throw new ApiError(422, 'Username and password are required', 'validation_error');
    }

    const ok = matches(username, config.auth.user) && matches(password, config.auth.password);
    if (!ok) {
      throw new ApiError(401, 'Incorrect username or password', 'invalid_credentials');
    }

    issueSession(res, config.auth.user);
    res.json({ user: { username: config.auth.user }, mailboxAddress: config.mailboxAddress });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/logout', (req, res) => {
  clearSession(res);
  res.status(204).end();
});

authRouter.get('/me', (req, res) => {
  const session = readSession(req);
  if (!session) {
    res.status(401).json({ error: { message: 'Not signed in', code: 'unauthorized' } });
    return;
  }
  // Every page load hits this, so it is the main place a session gets extended.
  refreshSessionIfStale(res, session);
  res.json({ user: { username: session.sub }, mailboxAddress: config.mailboxAddress });
});
