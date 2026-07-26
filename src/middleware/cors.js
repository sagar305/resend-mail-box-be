import cors from 'cors';
import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';

/**
 * Matches an Origin header against one CORS_ORIGIN entry. A leading "*." makes
 * it a host-suffix match, which is what covers Vercel preview deployments
 * (their hostnames change on every push).
 */
function matchesPattern(origin, pattern) {
  if (pattern === '*') return true;
  if (pattern === origin) return true;
  if (!pattern.startsWith('*.')) return false;

  try {
    const { hostname } = new URL(origin);
    const suffix = pattern.slice(1); // "*.vercel.app" -> ".vercel.app"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  } catch {
    return false;
  }
}

export const corsMiddleware = cors({
  origin(origin, callback) {
    // No Origin header: same-origin navigation, a proxied request (the Vercel
    // rewrite setup), or a non-browser client like curl.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (config.corsOrigins.some((pattern) => matchesPattern(origin, pattern))) {
      callback(null, true);
      return;
    }
    callback(new ApiError(403, `Origin ${origin} is not allowed by CORS_ORIGIN`, 'cors_rejected'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86_400,
});
