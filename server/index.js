/* ============================================================
 *  Marcus backend — Express API
 *  Auth + admin approval · projects · file storage · rate sets.
 *  Serves the built Vite frontend from /dist in production.
 * ============================================================ */
import express from "express";
import cors from "cors";
import multer from "multer";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, save, uid, UPLOAD_DIR } from "./db.js";
import { signToken, authMiddleware, adminOnly, publicUser } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* ---------- AUTH ---------- */
app.post("/api/auth/signup", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email & password required" });
  if (db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()))
    return res.status(409).json({ error: "email already registered" });
  const first = db.users.length === 0; // first user becomes the admin
  const user = {
    id: uid(), email: String(email).toLowerCase(), name: name || email.split("@")[0],
    passwordHash: await bcrypt.hash(password, 10),
    role: first ? "admin" : "user",
    status: first ? "approved" : "pending",
    createdAt: Date.now(),
  };
  db.users.push(user); save();
  if (user.status === "approved") return res.json({ token: signToken(user), user: publicUser(user) });
  res.json({ pending: true, message: "Account created — waiting for admin approval." });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || "").toLowerCase());
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash)))
    return res.status(401).json({ error: "invalid email or password" });
  if (user.status !== "approved") return res.status(403).json({ pending: true, error: "account awaiting admin approval" });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({ user: publicUser(user) });
});

/* ---------- USERS (admin) ---------- */
app.get("/api/users", authMiddleware, adminOnly, (_req, res) => {
  res.json({ users: db.users.map(publicUser) });
});
app.post("/api/users/:id/:action", authMiddleware, adminOnly, (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "not found" });
  const a = req.params.action;
  if (a === "approve") u.status = "approved";
  else if (a === "reject") u.status = "rejected";
  else if (a === "make-admin") u.role = "admin";
  else if (a === "make-user") u.role = "user";
  else return res.status(400).json({ error: "bad action" });
  save(); res.json({ user: publicUser(u) });
});

/* ---------- PROJECTS ---------- */
function visibleProjects(user) {
  return user.role === "admin" ? db.projects : db.projects.filter((p) => p.ownerId === user.id);
}
app.get("/api/projects", authMiddleware, (req, res) => {
  res.json({ projects: visibleProjects(req.user).map(stripHeavy) });
});
app.get("/api/projects/:id", authMiddleware, (req, res) => {
  const p = db.projects.find((x) => x.id === req.params.id);
  if (!p || (req.user.role !== "admin" && p.ownerId !== req.user.id)) return res.status(404).json({ error: "not found" });
  res.json({ project: p });
});
app.post("/api/projects", authMiddleware, (req, res) => {
  const { name, address, modelType } = req.body || {};
  const p = {
    id: uid(), ownerId: req.user.id, ownerName: req.user.name,
    name: name || "Untitled Project", address: address || "", modelType: modelType || "equest",
    files: [], parsed: null, rates: null, ratesName: "",
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  db.projects.push(p); save();
  res.json({ project: p });
});
app.put("/api/projects/:id", authMiddleware, (req, res) => {
  const p = db.projects.find((x) => x.id === req.params.id);
  if (!p || (req.user.role !== "admin" && p.ownerId !== req.user.id)) return res.status(404).json({ error: "not found" });
  for (const k of ["name", "address", "modelType", "parsed", "rates", "ratesName"])
    if (k in (req.body || {})) p[k] = req.body[k];
  p.updatedAt = Date.now(); save();
  res.json({ project: p });
});
app.delete("/api/projects/:id", authMiddleware, (req, res) => {
  const i = db.projects.findIndex((x) => x.id === req.params.id);
  if (i < 0 || (req.user.role !== "admin" && db.projects[i].ownerId !== req.user.id)) return res.status(404).json({ error: "not found" });
  const dir = path.join(UPLOAD_DIR, req.params.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  db.projects.splice(i, 1); save();
  res.json({ ok: true });
});

/* ---------- FILES ---------- */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => cb(null, `${uid()}__${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 60 * 1024 * 1024 } });

app.post("/api/projects/:id/files", authMiddleware, upload.array("files"), (req, res) => {
  const p = db.projects.find((x) => x.id === req.params.id);
  if (!p || (req.user.role !== "admin" && p.ownerId !== req.user.id)) return res.status(404).json({ error: "not found" });
  const role = req.body.role || "baseline"; // baseline | proposed | model
  for (const f of req.files || []) {
    p.files.push({ id: uid(), name: f.originalname, stored: f.filename, role, size: f.size, ext: path.extname(f.originalname).toLowerCase() });
  }
  p.updatedAt = Date.now(); save();
  res.json({ project: p });
});
app.get("/api/projects/:id/files/:fileId", authMiddleware, (req, res) => {
  const p = db.projects.find((x) => x.id === req.params.id);
  if (!p || (req.user.role !== "admin" && p.ownerId !== req.user.id)) return res.status(404).json({ error: "not found" });
  const f = p.files.find((x) => x.id === req.params.fileId);
  if (!f) return res.status(404).json({ error: "file not found" });
  res.sendFile(path.join(UPLOAD_DIR, p.id, f.stored));
});
app.delete("/api/projects/:id/files/:fileId", authMiddleware, (req, res) => {
  const p = db.projects.find((x) => x.id === req.params.id);
  if (!p || (req.user.role !== "admin" && p.ownerId !== req.user.id)) return res.status(404).json({ error: "not found" });
  const i = p.files.findIndex((x) => x.id === req.params.fileId);
  if (i < 0) return res.status(404).json({ error: "file not found" });
  const f = p.files[i];
  const fp = path.join(UPLOAD_DIR, p.id, f.stored);
  if (fs.existsSync(fp)) fs.rmSync(fp, { force: true });
  p.files.splice(i, 1); p.updatedAt = Date.now(); save();
  res.json({ project: p });
});

/* ---------- SAVED RATE SETS ---------- */
app.get("/api/rates", authMiddleware, (req, res) => {
  res.json({ rateSets: db.rateSets.filter((r) => r.ownerId === req.user.id || r.shared) });
});
app.post("/api/rates", authMiddleware, (req, res) => {
  const { name, config, shared } = req.body || {};
  const now = Date.now();
  const rs = { id: uid(), ownerId: req.user.id, ownerName: req.user.name, name: name || "Rate set", config: config || {}, shared: !!shared, createdAt: now, updatedAt: now };
  db.rateSets.push(rs); save();
  res.json({ rateSet: rs });
});
app.put("/api/rates/:id", authMiddleware, (req, res) => {
  const rs = db.rateSets.find((x) => x.id === req.params.id && (x.ownerId === req.user.id || req.user.role === "admin"));
  if (!rs) return res.status(404).json({ error: "not found" });
  const { name, config, shared } = req.body || {};
  if (name != null) rs.name = String(name);
  if (config != null) rs.config = config;
  if (shared != null) rs.shared = !!shared;
  rs.updatedAt = Date.now(); save();
  res.json({ rateSet: rs });
});
app.delete("/api/rates/:id", authMiddleware, (req, res) => {
  const i = db.rateSets.findIndex((x) => x.id === req.params.id && (x.ownerId === req.user.id || req.user.role === "admin"));
  if (i < 0) return res.status(404).json({ error: "not found" });
  db.rateSets.splice(i, 1); save();
  res.json({ ok: true });
});

/* ---------- UTILITY-RATE HISTORY (per-user audit trail) ---------- */
app.get("/api/rate-history", authMiddleware, (req, res) => {
  const items = db.rateHistory.filter((r) => r.ownerId === req.user.id).sort((a, b) => b.ts - a.ts);
  res.json({ history: items });
});
app.post("/api/rate-history", authMiddleware, (req, res) => {
  const s = req.body || {};
  const snap = {
    id: uid(), ownerId: req.user.id, ts: Date.now(),
    location: s.location || "", state: s.state || "",
    elec: s.elec ?? null, elecSrc: s.elecSrc || "",
    gas: s.gas ?? null, gasSrc: s.gasSrc || "",
    carbon: s.carbon ?? null, carbonSrc: s.carbonSrc || "",
    water: s.water ?? null, waterSrc: s.waterSrc || "",
  };
  db.rateHistory.push(snap); save();
  res.json({ snapshot: snap });
});
app.delete("/api/rate-history/:id", authMiddleware, (req, res) => {
  const i = db.rateHistory.findIndex((x) => x.id === req.params.id && x.ownerId === req.user.id);
  if (i < 0) return res.status(404).json({ error: "not found" });
  db.rateHistory.splice(i, 1); save();
  res.json({ ok: true });
});
app.delete("/api/rate-history", authMiddleware, (req, res) => {
  db.rateHistory = db.rateHistory.filter((x) => x.ownerId !== req.user.id); save();
  res.json({ ok: true });
});

function stripHeavy(p) {
  // lighten the list payload (drop parsed blob, keep a small summary)
  const { parsed, ...rest } = p;
  return { ...rest, hasParsed: !!parsed, summary: parsed?.summary || null };
}

/* ---------- STATIC (production) ---------- */
const dist = path.join(ROOT, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  Marcus API → http://localhost:${PORT}`);
  console.log(`  ${db.users.length} users · ${db.projects.length} projects`);
  if (!db.users.length) console.log("  → first signup becomes the ADMIN (auto-approved)\n");
});
