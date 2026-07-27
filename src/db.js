import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client = null;
let database = null;

/**
 * Point the app at a database instance. `connectDb` calls this after dialing
 * MongoDB; tests call it directly with an in-memory stand-in.
 */
export function useDatabase(db) {
  database = db;
}

export function getCollections() {
  if (!database) {
    throw new Error('Database not connected. Call connectDb() before handling requests.');
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
  client = new MongoClient(config.mongoUri, {
    // Fail fast on a bad URI or blocked IP rather than hanging the boot.
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  useDatabase(client.db(config.mongoDbName));

  // Drafts are always listed most-recently-edited first.
  await getCollections().drafts.createIndex({ updatedAt: -1 });

  return database;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
  }
  database = null;
}
