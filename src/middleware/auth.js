import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';

const { cookieName, sessionSecret, sessionMaxAgeMs, cookieSameSite, cookieSecure } = config.auth;

// clearCookie only matches when these attributes match the cookie that was set.
const cookieOptions = {
  httpOnly: true,
  sameSite: cookieSameSite,
  secure: cookieSecure,
  path: '/',
};

export function issueSession(res, username) {
  const token = jwt.sign({ sub: username }, sessionSecret, {
    expiresIn: Math.floor(sessionMaxAgeMs / 1000),
  });

  res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionMaxAgeMs });
}

export function clearSession(res) {
  res.clearCookie(cookieName, cookieOptions);
}

export function readSession(req) {
  const token = req.cookies?.[cookieName];
  if (!token) return null;
  try {
    return jwt.verify(token, sessionSecret);
  } catch {
    return null;
  }
}

/**
 * Sliding expiry. Re-issues the cookie once a session is past the halfway point
 * of its life, so continued use never logs you out mid-session. Deliberately not
 * on every request: the inbox polls every 60 seconds, and signing a JWT plus
 * sending Set-Cookie that often is pure waste.
 */
export function refreshSessionIfStale(res, session) {
  if (!session?.exp) return;
  const remainingMs = session.exp * 1000 - Date.now();
  if (remainingMs < sessionMaxAgeMs / 2) {
    issueSession(res, session.sub);
  }
}

export function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    next(new ApiError(401, 'Not signed in', 'unauthorized'));
    return;
  }
  req.user = { username: session.sub };
  refreshSessionIfStale(res, session);
  next();
}
