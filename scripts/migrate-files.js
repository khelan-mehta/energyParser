/* ============================================================
 *  One-time file migration: server/uploads/<projectId>/<stored>
 *  → Vercel Blob, writing each file's public `url` back onto the
 *  project document in MongoDB. Idempotent (skips files already
 *  carrying a `url`). Requires BLOB_READ_WRITE_TOKEN + MONGODB_URI.
 *    node scripts/migrate-files.js
 * ============================================================ */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import { put } from "@vercel/blob";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "server", "uploads");
const URI = process.env.MONGODB_URI;
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

if (!URI) { console.error("✗ MONGODB_URI not set"); process.exit(1); }
if (!TOKEN) { console.error("✗ BLOB_READ_WRITE_TOKEN not set — create a Vercel Blob store first, then paste its token into .env"); process.exit(1); }

const client = new MongoClient(URI);
await client.connect();
const projects = client.db().collection("projects");
const all = await projects.find().toArray();
console.log(`→ ${all.length} projects`);

let uploaded = 0, skipped = 0, missing = 0;
for (const p of all) {
  const files = p.files || [];
  let changed = false;
  for (const f of files) {
    if (f.url) { skipped++; continue; }                 // already migrated
    if (!f.stored) { missing++; continue; }
    const disk = path.join(UPLOAD_DIR, p.id, f.stored);
    if (!fs.existsSync(disk)) { console.log(`  ⚠ missing on disk: ${p.id}/${f.stored}`); missing++; continue; }
    const buf = fs.readFileSync(disk);
    const res = await put(`projects/${p.id}/${f.name}`, buf, { access: "public", token: TOKEN, addRandomSuffix: true });
    f.url = res.url;
    delete f.stored;
    changed = true; uploaded++;
    console.log(`  ✓ ${p.name} · ${f.name} → ${res.url}`);
  }
  if (changed) await projects.updateOne({ id: p.id }, { $set: { files } });
}

console.log(`✓ files migration: uploaded ${uploaded}, skipped ${skipped}, missing ${missing}`);
await client.close();
