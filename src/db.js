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
