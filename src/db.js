import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { ApiError } from './lib/ApiError.js';

let client = null;
let database = null;
let lastError = null;

/**
 * Point the app at a database instance. `connectDb` calls this after dialing
 * MongoDB; tests call it directly with an in-memory stand-in.
 */
export function useDatabase(db) {
  database = db;
  lastError = null;
}

/** Whether the database is usable, and if not, why — for GET /api/status. */
export function getDbStatus() {
  if (database) return { connected: true, state: 'connected', reason: null };
  // No error yet means the first attempt is still in flight, which is different
  // from having tried and failed.
  if (!lastError) return { connected: false, state: 'connecting', reason: null };
  return {
    connected: false,
    state: 'error',
    reason: describeConnectionError(lastError) ?? lastError.message,
  };
}

export function getCollections() {
  if (!database) {
    // 503, not 500: the app is fine, its database is not — and that is temporary.
    throw new ApiError(503, 'Database unavailable. See GET /api/status.', 'database_unavailable');
  }
  return {
    drafts: database.collection('drafts'),
    readReceipts: database.collection('readReceipts'),
  };
}

/**
 * Turn a driver connection failure into one actionable line. The raw errors are
 * a hundred lines of topology dump, and the most common cause — Atlas refusing
 * a non-allowlisted IP — surfaces as a TLS alert that reads like a cert problem.
 */
export function describeConnectionError(error) {
  const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`;

  if (/tlsv1 alert internal error|TLSV1_ALERT_INTERNAL_ERROR/i.test(text)) {
    return [
      'MongoDB refused the TLS handshake.',
      "On Atlas this almost always means this server's IP is not in the cluster's",
      'IP Access List (Atlas → Network Access). Railway egress IPs are not static,',
      'so add 0.0.0.0/0 and rely on a strong database password.',
      'A paused M0 cluster gives the same error — check the cluster is running.',
    ].join('\n  ');
  }
  if (/bad auth|Authentication failed/i.test(text)) {
    return [
      'MongoDB rejected the credentials.',
      'Check the username and password in MONGO_URI. Percent-encode any',
      '@ : / ? or # in the password, or the URI parses wrongly.',
    ].join('\n  ');
  }
  if (/querySrv|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return 'MongoDB hostname could not be resolved. Check the cluster host in MONGO_URI.';
  }
  if (/timed out|MongoServerSelectionError/i.test(text)) {
    return [
      'MongoDB was unreachable before the timeout.',
      'Check the cluster is running and that the IP Access List allows this server.',
    ].join('\n  ');
  }
  return null;
}

export async function connectDb() {
  try {
    client = new MongoClient(config.mongoUri, {
      // Fail fast on a bad URI or blocked IP rather than hanging the boot.
      serverSelectionTimeoutMS: 10_000,
    });
    await client.connect();
    useDatabase(client.db(config.mongoDbName));

    // Drafts are always listed most-recently-edited first.
    await getCollections().drafts.createIndex({ updatedAt: -1 });

    return database;
  } catch (error) {
    lastError = error;
    // Drop the failed client so the next attempt starts from a clean socket pool.
    await client?.close().catch(() => {});
    client = null;
    database = null;
    throw error;
  }
}

/**
 * Keep trying to connect, forever, logging the diagnosis on each failure.
 * The alternative — exiting on a failed connection — takes the whole process
 * down, so the reason is only visible in platform logs and a fix needs a
 * redeploy. This way /api/status can report the problem over HTTP and the app
 * recovers on its own once the database is reachable.
 */
export function connectDbWithRetry({ intervalMs = 10_000 } = {}) {
  const attempt = async () => {
    try {
      await connectDb();
      console.log(`MongoDB connected (database: ${config.mongoDbName})`);
    } catch (error) {
      const hint = describeConnectionError(error);
      console.error('\nMongoDB connection failed. Serving 503s until it recovers.\n');
      if (hint) console.error(`  ${hint}\n`);
      console.error(`  Driver error: ${String(error?.message ?? error).split('\n')[0]}`);
      console.error(`  Retrying in ${intervalMs / 1000}s. Check GET /api/status.\n`);
      setTimeout(attempt, intervalMs);
    }
  };
  return attempt();
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
  }
  database = null;
}
