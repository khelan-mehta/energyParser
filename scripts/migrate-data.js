/* ============================================================
 *  One-time data migration: server/data/db.json → MongoDB Atlas.
 *  Idempotent (upserts by our `id`). Safe to re-run.
 *    node scripts/migrate-data.js
 * ============================================================ */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DBFILE = path.join(__dirname, "..", "server", "data", "db.json");
const URI = process.env.MONGODB_URI;

if (!URI) { console.error("✗ MONGODB_URI not set (.env)"); process.exit(1); }
if (!fs.existsSync(DBFILE)) { console.error("✗ no db.json at", DBFILE); process.exit(1); }

const data = JSON.parse(fs.readFileSync(DBFILE, "utf8"));
const COLLS = ["users", "projects", "rateSets", "rateHistory"];

const client = new MongoClient(URI);
await client.connect();
const db = client.db();
console.log("→ connected to", db.databaseName);

for (const name of COLLS) {
  const docs = Array.isArray(data[name]) ? data[name] : [];
  if (!docs.length) { console.log(`  ${name}: 0 (skip)`); continue; }
  const coll = db.collection(name);
  const ops = docs.map((d) => ({ updateOne: { filter: { id: d.id }, update: { $set: d }, upsert: true } }));
  const r = await coll.bulkWrite(ops, { ordered: false });
  console.log(`  ${name}: upserted ${r.upsertedCount}, modified ${r.modifiedCount} (of ${docs.length})`);
}

console.log("✓ data migration complete");
await client.close();
