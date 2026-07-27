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

export function requireAuth(req, _res, next) {
  const session = readSession(req);
  if (!session) {
    next(new ApiError(401, 'Not signed in', 'unauthorized'));
    return;
  }
  req.user = { username: session.sub };
  next();
}
