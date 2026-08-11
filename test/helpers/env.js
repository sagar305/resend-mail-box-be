/*
 * config.js reads its required variables at import time and throws when they are
 * missing, so this has to be imported before anything that pulls config in.
 * ES module imports evaluate in source order, so listing this import first in a
 * test file is enough.
 *
 * The values are deliberately fake. Nothing in the suite reaches Resend or Mongo:
 * the ledger runs against the in-memory database and the senders are injected.
 */

process.env.RESEND_API_KEY ??= 're_test_key';
process.env.MAILBOX_ADDRESS ??= 'mailbox@example.test';
process.env.MAILBOX_USER ??= 'tester';
process.env.MAILBOX_PASSWORD ??= 'test-password';
process.env.SESSION_SECRET ??= 'test-session-secret-long-enough-to-look-real';
process.env.MONGO_URI ??= 'mongodb://localhost:27017';
process.env.MAX_SCHEDULED_PER_DAY ??= '60';
process.env.RESEND_DAILY_QUOTA ??= '100';
// config reads this once at import, so it has to be set before it loads rather
// than per test. The real pace is two a second; the suite has no rate limit to
// respect and should not spend half a second between stubbed sends.
process.env.RESEND_SENDS_PER_SECOND ??= '1000';
// Likewise the 429 backoff: the suite verifies that a rate-limited recipient is
// re-offered rather than failed, not that the wait is five seconds long.
process.env.RATE_LIMIT_BACKOFF_MS ??= '1';
