/* ============================================================
 *  MongoDB data layer (Atlas). Replaces the old JSON-file store.
 *  A single cached client is reused across serverless invocations
 *  (Vercel) and across requests (local/Render).
 * ============================================================ */
import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "cannonMarcus";

if (!URI) console.warn("⚠ MONGODB_URI is not set — the API cannot reach the database.");

// Reuse the connection promise across hot invocations (avoids exhausting Atlas
// connection limits on serverless). Stored on globalThis so module re-eval reuses it.
let cached = globalThis.__marcusMongo;
if (!cached) cached = globalThis.__marcusMongo = { client: null, promise: null };

export async function getDb() {
  if (cached.db) return cached.db;
  if (!cached.promise) {
    const client = new MongoClient(URI, { maxPoolSize: 10 });
    cached.promise = client.connect().then((c) => {
      cached.client = c;
      cached.db = c.db(DB_NAME);
      return cached.db;
    });
  }
  await cached.promise;
  return cached.db;
}

/** Convenience collection accessors. */
export const col = {
  users: async () => (await getDb()).collection("users"),
  projects: async () => (await getDb()).collection("projects"),
  rateSets: async () => (await getDb()).collection("rateSets"),
  rateHistory: async () => (await getDb()).collection("rateHistory"),
};

/** Ensure indexes once (idempotent). Safe to call on cold start. */
let indexed = false;
export async function ensureIndexes() {
  if (indexed) return;
  indexed = true;
  try {
    const db = await getDb();
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("users").createIndex({ id: 1 }, { unique: true });
    await db.collection("projects").createIndex({ id: 1 }, { unique: true });
    await db.collection("projects").createIndex({ ownerId: 1 });
    await db.collection("rateSets").createIndex({ id: 1 }, { unique: true });
    await db.collection("rateHistory").createIndex({ id: 1 }, { unique: true });
    await db.collection("rateHistory").createIndex({ ownerId: 1 });
  } catch (e) { console.warn("index setup:", e.message); }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
