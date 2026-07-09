/* ============================================================
 *  Local / Render launcher — wraps the shared Express app with
 *  static file serving (the built Vite frontend) and app.listen.
 *  On Vercel the app is served by api/index.js instead (no listen).
 * ============================================================ */
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import app from "./app.js";
import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/* ---------- STATIC (production single-box deploy) ---------- */
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`\n  Marcus API → http://localhost:${PORT}`);
  try {
    const db = await getDb();
    const [u, p] = await Promise.all([
      db.collection("users").estimatedDocumentCount(),
      db.collection("projects").estimatedDocumentCount(),
    ]);
    console.log(`  MongoDB connected · ${u} users · ${p} projects`);
    if (!u) console.log("  → first signup becomes the ADMIN (auto-approved)\n");
  } catch (e) { console.log("  ⚠ MongoDB connection failed:", e.message, "\n"); }
});
