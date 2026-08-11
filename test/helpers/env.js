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
