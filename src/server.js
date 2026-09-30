import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, connectDbWithRetry } from './db.js';
import { resumeInterruptedJobs, stopBulkSending } from './services/bulkJobs.js';

// Listen first, then connect in the background and keep retrying. Exiting on a
// failed database connection hides the reason behind a platform error page and
// requires a redeploy to recover; this way GET /api/status reports the problem
// and the app heals itself once the database is reachable. Data routes answer
// 503 in the meantime.
const server = createApp().listen(config.port, '0.0.0.0', () => {
  console.log(`Mailbox API listening on port ${config.port}`);
  console.log(`Sending as: ${config.mailboxAddress}`);
  console.log(`Allowed origins: ${config.corsOrigins.join(', ')}`);
  console.log(
    `Session cookie: SameSite=${config.auth.cookieSameSite}; Secure=${config.auth.cookieSecure}`,
  );
});

// A bulk send outlives the request that started it, so a restart can land in the
// middle of one. Every recipient's state is in the database, so the moment there
// is a connection, anything left mid-flight is picked back up.
connectDbWithRetry({
  onConnected: () => resumeInterruptedJobs().catch((error) => {
    console.error(`Could not resume interrupted bulk sends: ${error.message}`);
  }),
});

// Railway sends SIGTERM on redeploy; close cleanly so in-flight writes finish.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    // Stop claiming new recipients first. A job interrupted between sends resumes
    // from its last recorded position; one interrupted mid-send would leave a
    // recipient claimed by a process that no longer exists.
    stopBulkSending();
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  });
}
