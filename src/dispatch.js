import { closeDb, connectDb, describeConnectionError } from './db.js';
import { dispatchDue } from './services/dispatcher.js';

/*
 * The daily hand-over, as a one-shot process.
 *
 * `npm run dispatch` — what a platform scheduler runs at 00:00 UTC. It connects,
 * hands over everything due, and exits.
 *
 * This exists because the server cannot be relied on to be awake. A free Render
 * web service spins down after fifteen minutes without traffic, so a single-user
 * mailbox is almost certainly asleep at 00:00 UTC and an in-process timer would
 * never fire. A scheduled job is started by the platform, so it runs whether or
 * not anyone has opened the app.
 *
 * The server still sweeps on boot and still arms its own midnight timer. Both are
 * harmless alongside this — the hand-over is conditional on a mail still being
 * pending, so whichever runs first simply finds nothing left for the other.
 *
 * Bulk jobs are awaited rather than left in the background: this process exits
 * when the work is done, and anything still draining would be killed with it.
 */

async function main() {
  try {
    await connectDb();
  } catch (error) {
    const hint = describeConnectionError(error);
    console.error('Dispatch could not reach MongoDB.');
    if (hint) console.error(`  ${hint}`);
    console.error(`  Driver error: ${String(error?.message ?? error).split('\n')[0]}`);
    // Non-zero so the platform records the run as failed rather than silently
    // reporting a success that sent nothing.
    process.exitCode = 1;
    return;
  }

  try {
    const summary = await dispatchDue({ awaitJobs: true });
    console.log(
      `Dispatch complete: ${summary.handedOver} handed to Resend` +
      `${summary.late ? ` (${summary.late} late)` : ''}` +
      `${summary.failed ? `, ${summary.failed} left to retry` : ''}` +
      `${summary.jobsStarted ? `, ${summary.jobsStarted} bulk send(s) run` : ''}`,
    );
    // Mail left pending after a sweep is a real problem worth surfacing: the next
    // run will retry it, but a run that could not place its sends should not look
    // like a clean one.
    if (summary.failed) process.exitCode = 1;
  } catch (error) {
    console.error(`Dispatch failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

await main();
