import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { ApiError } from '../lib/ApiError.js';
import { resumeInterruptedJobs } from '../services/bulkJobs.js';
import { dispatchDueExclusive } from '../services/dispatcher.js';

/*
 * Endpoints for Vercel Cron (see vercel.json). They replace what the long-lived
 * server does with timers: the 00:00 UTC hand-over of scheduled mail, and picking
 * bulk sends back up after an instance stopped mid-job.
 *
 * Vercel calls them with `Authorization: Bearer <CRON_SECRET>`. Without the
 * variable they refuse to run at all, rather than being open to anyone.
 */
export const cronRouter = Router();

function sameSecret(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

cronRouter.use((req, _res, next) => {
  if (!config.cronSecret) {
    throw new ApiError(503, 'CRON_SECRET is not set, so cron endpoints are disabled', 'cron_disabled');
  }
  const header = req.get('authorization') ?? '';
  if (!sameSecret(header, `Bearer ${config.cronSecret}`)) {
    throw new ApiError(401, 'Invalid cron secret', 'unauthorized');
  }
  next();
});

const asyncRoute = (handler) => (req, res, next) => handler(req, res, next).catch(next);

// 00:00 UTC: hand the day's scheduled mail to Resend and release parked bulk
// sends. Also resumes stalled ones, which is the only resume a Hobby plan gets
// from cron, since Hobby allows daily schedules only.
cronRouter.get('/dispatch', asyncRoute(async (_req, res) => {
  const dispatch = await dispatchDueExclusive();
  const resumed = await resumeInterruptedJobs();
  res.json({ ok: true, dispatch, resumedBulkJobs: resumed });
}));

// Every minute: restart any bulk send whose runner stopped (time limit reached
// or instance killed). The run continues after this response via waitUntil.
cronRouter.get('/resume-bulk', asyncRoute(async (_req, res) => {
  res.json({ ok: true, resumedBulkJobs: await resumeInterruptedJobs() });
}));
