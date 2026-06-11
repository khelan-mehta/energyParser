/* JWT auth helpers + middleware. */
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "marcus-dev-secret-change-me";

export function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, email: user.email, name: user.name }, SECRET, { expiresIn: "30d" });
}

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: "unauthorized" }); }
}

export function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "admin only" });
  next();
}

export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}
