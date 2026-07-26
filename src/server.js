import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, connectDb } from './db.js';

// Connect before listening: a healthcheck that passes while the database is
// unreachable would just hand out 500s.
await connectDb();
console.log(`MongoDB connected (database: ${config.mongoDbName})`);

const server = createApp().listen(config.port, '0.0.0.0', () => {
  console.log(`Mailbox API listening on port ${config.port}`);
  console.log(`Sending as: ${config.mailboxAddress}`);
  console.log(`Allowed origins: ${config.corsOrigins.join(', ')}`);
  console.log(
    `Session cookie: SameSite=${config.auth.cookieSameSite}; Secure=${config.auth.cookieSecure}`,
  );
});

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
