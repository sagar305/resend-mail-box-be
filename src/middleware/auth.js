import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';

const { cookieName, sessionSecret, sessionMaxAgeMs } = config.auth;

export function issueSession(res, username) {
  const token = jwt.sign({ sub: username }, sessionSecret, {
    expiresIn: Math.floor(sessionMaxAgeMs / 1000),
  });

  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: sessionMaxAgeMs,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
  });
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

export function requireAuth(req, _res, next) {
  const session = readSession(req);
  if (!session) {
    next(new ApiError(401, 'Not signed in', 'unauthorized'));
    return;
  }
  req.user = { username: session.sub };
  next();
}
