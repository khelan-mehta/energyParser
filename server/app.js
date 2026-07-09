/* ============================================================
 *  Marcus backend — Express API (MongoDB + Vercel Blob)
 *  Exported as an app (no listen) so it runs both as a local server
 *  (server/index.js) and as a Vercel serverless function (api/index.js).
 *    • Data  → MongoDB Atlas (users / projects / rateSets / rateHistory)
 *    • Files → Vercel Blob (browser direct-upload; metadata in project.files)
 * ============================================================ */
import "./env.js";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import path from "path";
import { handleUpload } from "@vercel/blob/client";
import { del } from "@vercel/blob";
import { col, uid, ensureIndexes } from "./db.js";
import { signToken, authMiddleware, adminOnly, publicUser, verifyToken } from "./auth.js";

ensureIndexes(); // fire-and-forget on cold start

export const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

const clean = (d) => { if (d) delete d._id; return d; };
const noId = { projection: { _id: 0 } };

/* ---------- AUTH ---------- */
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "email & password required" });
    const users = await col.users();
    if (await users.findOne({ email: String(email).toLowerCase() }))
      return res.status(409).json({ error: "email already registered" });
    const first = (await users.countDocuments()) === 0; // first user becomes admin
    const user = {
      id: uid(), email: String(email).toLowerCase(), name: name || email.split("@")[0],
      passwordHash: await bcrypt.hash(password, 10),
      role: first ? "admin" : "user",
      status: first ? "approved" : "pending",
      createdAt: Date.now(),
    };
    await users.insertOne(user);
    if (user.status === "approved") return res.json({ token: signToken(user), user: publicUser(user) });
    res.json({ pending: true, message: "Account created — waiting for admin approval." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const users = await col.users();
    const user = await users.findOne({ email: String(email || "").toLowerCase() });
    if (!user || !(await bcrypt.compare(password || "", user.passwordHash)))
      return res.status(401).json({ error: "invalid email or password" });
    if (user.status !== "approved") return res.status(403).json({ pending: true, error: "account awaiting admin approval" });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  const users = await col.users();
  const user = await users.findOne({ id: req.user.id });
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({ user: publicUser(user) });
});

/* ---------- USERS (admin) ---------- */
app.get("/api/users", authMiddleware, adminOnly, async (_req, res) => {
  const users = await (await col.users()).find().toArray();
  res.json({ users: users.map(publicUser) });
});
app.post("/api/users/:id/:action", authMiddleware, adminOnly, async (req, res) => {
  const users = await col.users();
  const u = await users.findOne({ id: req.params.id });
  if (!u) return res.status(404).json({ error: "not found" });
  const a = req.params.action;
  const patch = {};
  if (a === "approve") patch.status = "approved";
  else if (a === "reject") patch.status = "rejected";
  else if (a === "make-admin") patch.role = "admin";
  else if (a === "make-user") patch.role = "user";
  else return res.status(400).json({ error: "bad action" });
  await users.updateOne({ id: u.id }, { $set: patch });
  res.json({ user: publicUser({ ...u, ...patch }) });
});

/* ---------- PROJECTS ---------- */
async function findProject(id, user) {
  const p = await (await col.projects()).findOne({ id }, noId);
  if (!p) return null;
  if (user.role !== "admin" && p.ownerId !== user.id) return null;
  return p;
}
function stripHeavy(p) {
  const { parsed, ...rest } = p;
  return { ...rest, hasParsed: !!parsed, summary: parsed?.summary || null };
}

app.get("/api/projects", authMiddleware, async (req, res) => {
  const q = req.user.role === "admin" ? {} : { ownerId: req.user.id };
  const projects = await (await col.projects()).find(q, noId).toArray();
  res.json({ projects: projects.map(stripHeavy) });
});
app.get("/api/projects/:id", authMiddleware, async (req, res) => {
  const p = await findProject(req.params.id, req.user);
  if (!p) return res.status(404).json({ error: "not found" });
  res.json({ project: p });
});
app.post("/api/projects", authMiddleware, async (req, res) => {
  const { name, address, modelType } = req.body || {};
  const p = {
    id: uid(), ownerId: req.user.id, ownerName: req.user.name,
    name: name || "Untitled Project", address: address || "", modelType: modelType || "equest",
    files: [], parsed: null, rates: null, ratesName: "", projectInfo: null, setupDraft: false, mepcDraft: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  await (await col.projects()).insertOne(p);
  res.json({ project: clean(p) });
});
app.put("/api/projects/:id", authMiddleware, async (req, res) => {
  const projects = await col.projects();
  const p = await findProject(req.params.id, req.user);
  if (!p) return res.status(404).json({ error: "not found" });
  const patch = {};
  for (const k of ["name", "address", "modelType", "parsed", "rates", "ratesName", "projectInfo", "setupDraft", "mepcDraft"])
    if (k in (req.body || {})) patch[k] = req.body[k];
  patch.updatedAt = Date.now();
  await projects.updateOne({ id: p.id }, { $set: patch });
  res.json({ project: { ...p, ...patch } });
});
app.delete("/api/projects/:id", authMiddleware, async (req, res) => {
  const projects = await col.projects();
  const p = await findProject(req.params.id, req.user);
  if (!p) return res.status(404).json({ error: "not found" });
  // best-effort delete the project's blobs
  for (const f of p.files || []) { if (f.url) { try { await del(f.url); } catch { /* ignore */ } } }
  await projects.deleteOne({ id: p.id });
  res.json({ ok: true });
});

/* ---------- FILES (Vercel Blob direct-upload) ----------
   1) Browser asks /api/blob/upload for a one-time client token (auth-gated),
      then uploads the bytes DIRECTLY to Blob storage (bypasses the function's
      request-size limit). 2) Browser registers the returned URL + metadata here. */
app.post("/api/blob/upload", async (req, res) => {
  try {
    const json = await handleUpload({
      body: req.body,
      request: { headers: new Headers(req.headers) },
      // The browser can't attach our Bearer header to this token request, so the
      // JWT rides in clientPayload — verify it here before issuing a Blob token.
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        try { verifyToken(clientPayload); } catch { throw new Error("unauthorized"); }
        return { addRandomSuffix: true, maximumSizeInBytes: 80 * 1024 * 1024 };
      },
      onUploadCompleted: async () => { /* registration happens via the files route */ },
    });
    res.json(json);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/projects/:id/files", authMiddleware, async (req, res) => {
  const projects = await col.projects();
  const p = await findProject(req.params.id, req.user);
  if (!p) return res.status(404).json({ error: "not found" });
  const role = req.body.role || "baseline"; // baseline | proposed | model
  const incoming = Array.isArray(req.body.files) ? req.body.files : [];
  const added = incoming.filter((f) => f && f.url && f.name).map((f) => ({
    id: uid(), name: f.name, url: f.url, role: f.role || role,
    size: f.size || 0, ext: (f.ext || path.extname(f.name)).toLowerCase(),
  }));
  const files = [...(p.files || []), ...added];
  const updatedAt = Date.now();
  await projects.updateOne({ id: p.id }, { $set: { files, updatedAt } });
  res.json({ project: { ...p, files, updatedAt } });
});

app.get("/api/projects/:id/files/:fileId", authMiddleware, async (req, res) => {
  const p = await findProject(req.params.id, req.user);
  if (!p) return res.status(404).json({ error: "not found" });
  const f = (p.files || []).find((x) => x.id === req.params.fileId);
  if (!f || !f.url) return res.status(404).json({ error: "file not found" });
  res.redirect(f.url); // public blob URL; fetch() follows the redirect to the bytes
});

app.delete("/api/projects/:id/files/:fileId", authMiddleware, async (req, res) => {
  const projects = await col.projects();
  const p = await findProject(req.params.id, req.user);
  if (!p) return res.status(404).json({ error: "not found" });
  const f = (p.files || []).find((x) => x.id === req.params.fileId);
  if (!f) return res.status(404).json({ error: "file not found" });
  if (f.url) { try { await del(f.url); } catch { /* ignore */ } }
  const files = (p.files || []).filter((x) => x.id !== req.params.fileId);
  const updatedAt = Date.now();
  await projects.updateOne({ id: p.id }, { $set: { files, updatedAt } });
  res.json({ project: { ...p, files, updatedAt } });
});

/* ---------- SAVED RATE SETS ---------- */
app.get("/api/rates", authMiddleware, async (req, res) => {
  const rs = await (await col.rateSets()).find({ $or: [{ ownerId: req.user.id }, { shared: true }] }, noId).toArray();
  res.json({ rateSets: rs });
});
app.post("/api/rates", authMiddleware, async (req, res) => {
  const { name, config, shared } = req.body || {};
  const now = Date.now();
  const rs = { id: uid(), ownerId: req.user.id, ownerName: req.user.name, name: name || "Rate set", config: config || {}, shared: !!shared, createdAt: now, updatedAt: now };
  await (await col.rateSets()).insertOne(rs);
  res.json({ rateSet: clean(rs) });
});
app.put("/api/rates/:id", authMiddleware, async (req, res) => {
  const rates = await col.rateSets();
  const rs = await rates.findOne({ id: req.params.id }, noId);
  if (!rs || (rs.ownerId !== req.user.id && req.user.role !== "admin")) return res.status(404).json({ error: "not found" });
  const { name, config, shared } = req.body || {};
  const patch = { updatedAt: Date.now() };
  if (name != null) patch.name = String(name);
  if (config != null) patch.config = config;
  if (shared != null) patch.shared = !!shared;
  await rates.updateOne({ id: rs.id }, { $set: patch });
  res.json({ rateSet: { ...rs, ...patch } });
});
app.delete("/api/rates/:id", authMiddleware, async (req, res) => {
  const rates = await col.rateSets();
  const rs = await rates.findOne({ id: req.params.id });
  if (!rs || (rs.ownerId !== req.user.id && req.user.role !== "admin")) return res.status(404).json({ error: "not found" });
  await rates.deleteOne({ id: rs.id });
  res.json({ ok: true });
});

/* ---------- UTILITY-RATE HISTORY (per-user audit trail) ---------- */
app.get("/api/rate-history", authMiddleware, async (req, res) => {
  const items = await (await col.rateHistory()).find({ ownerId: req.user.id }, noId).sort({ ts: -1 }).toArray();
  res.json({ history: items });
});
app.post("/api/rate-history", authMiddleware, async (req, res) => {
  const s = req.body || {};
  const snap = {
    id: uid(), ownerId: req.user.id, ts: Date.now(),
    location: s.location || "", state: s.state || "",
    elec: s.elec ?? null, elecSrc: s.elecSrc || "",
    gas: s.gas ?? null, gasSrc: s.gasSrc || "",
    carbon: s.carbon ?? null, carbonSrc: s.carbonSrc || "",
    water: s.water ?? null, waterSrc: s.waterSrc || "",
  };
  await (await col.rateHistory()).insertOne(snap);
  res.json({ snapshot: clean(snap) });
});
app.delete("/api/rate-history/:id", authMiddleware, async (req, res) => {
  const hist = await col.rateHistory();
  const r = await hist.findOne({ id: req.params.id, ownerId: req.user.id });
  if (!r) return res.status(404).json({ error: "not found" });
  await hist.deleteOne({ id: r.id });
  res.json({ ok: true });
});
app.delete("/api/rate-history", authMiddleware, async (req, res) => {
  await (await col.rateHistory()).deleteMany({ ownerId: req.user.id });
  res.json({ ok: true });
});

/* ---------- OPENAI PROXY ---------- */
app.post("/api/openai/chat", authMiddleware, async (req, res) => {
  const key = req.headers["x-openai-key"] || process.env.OPENAI_API_KEY || "";
  if (!key) return res.status(400).json({ error: "no OpenAI key" });
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(req.body || {}),
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) { res.status(502).json({ error: "OpenAI proxy failed: " + e.message }); }
});

/* ---------- ZERO TOOL PROXY ---------- */
app.post("/api/zerotool/baseline", authMiddleware, async (req, res) => {
  try {
    const r = await fetch("https://tool.zerotool.org/baseline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body || []),
    });
    const text = await r.text();
    res.status(r.status).type("application/json").send(text);
  } catch (e) { res.status(502).json({ error: "Zero Tool proxy failed: " + e.message }); }
});

app.get("/api/health", async (_req, res) => {
  try { const u = await col.users(); await u.estimatedDocumentCount(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

export default app;
