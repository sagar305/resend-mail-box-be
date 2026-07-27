import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, connectDb, describeConnectionError } from './db.js';

// Connect before listening: a healthcheck that passes while the database is
// unreachable would just hand out 500s.
try {
  await connectDb();
} catch (error) {
  const hint = describeConnectionError(error);
  console.error('\nCould not connect to MongoDB.\n');
  if (hint) console.error(`  ${hint}\n`);
  console.error(`  Driver error: ${String(error?.message ?? error).split('\n')[0]}\n`);
  process.exit(1);
}
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
