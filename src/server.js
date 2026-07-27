import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, connectDbWithRetry } from './db.js';

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

connectDbWithRetry();

// Railway sends SIGTERM on redeploy; close cleanly so in-flight writes finish.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
  });
}
