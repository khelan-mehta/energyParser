/* ============================================================
 *  Marcus API client + auth state (frontend).
 * ============================================================ */
import { upload as blobUpload } from "@vercel/blob/client";

export interface User { id: string; email: string; name: string; role: "user" | "admin"; status: "pending" | "approved" | "rejected"; createdAt: number; }
export interface ProjectFile { id: string; name: string; url?: string; stored?: string; role: "baseline" | "proposed" | "model"; size: number; ext: string; }
export interface Project {
  id: string; ownerId: string; ownerName: string; name: string; address: string;
  modelType: "equest" | "trace" | "iesve";
  files: ProjectFile[]; parsed: any | null; rates: any | null; ratesName: string; projectInfo: any | null; setupDraft?: boolean; mepcDraft?: any | null;
  createdAt: number; updatedAt: number; hasParsed?: boolean; summary?: any;
}
export interface RateSet { id: string; ownerId: string; ownerName: string; name: string; config: any; shared: boolean; createdAt: number; updatedAt?: number; }
export interface RateSnapshot {
  id: string; ownerId: string; ts: number; location: string; state: string;
  elec: number | null; elecSrc: string; gas: number | null; gasSrc: string;
  carbon: number | null; carbonSrc: string; water: number | null; waterSrc: string;
}

const TOKEN_KEY = "marcus_token";
export let authUser: User | null = null;
export function setAuthUser(u: User | null) { authUser = u; }
export function getToken(): string { return localStorage.getItem(TOKEN_KEY) || ""; }
export function setToken(t: string | null) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

async function api(path: string, opts: RequestInit = {}): Promise<any> {
  const headers: any = { ...(opts.headers || {}) };
  if (!(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (getToken()) headers.Authorization = `Bearer ${getToken()}`;
  const r = await fetch("/api" + path, { ...opts, headers });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) { const e: any = new Error(data.error || `HTTP ${r.status}`); e.data = data; e.status = r.status; throw e; }
  return data;
}

/* auth */
export const Auth = {
  signup: (email: string, password: string, name: string) => api("/auth/signup", { method: "POST", body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) => api("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => api("/auth/me"),
};

/* users (admin) */
export const Users = {
  list: () => api("/users"),
  action: (id: string, action: "approve" | "reject" | "make-admin" | "make-user") => api(`/users/${id}/${action}`, { method: "POST" }),
};

/* projects */
export const Projects = {
  list: () => api("/projects"),
  get: (id: string) => api(`/projects/${id}`),
  create: (name: string, address: string, modelType: string) => api("/projects", { method: "POST", body: JSON.stringify({ name, address, modelType }) }),
  update: (id: string, patch: Partial<Project>) => api(`/projects/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  remove: (id: string) => api(`/projects/${id}`, { method: "DELETE" }),
  // Browser → Vercel Blob direct upload (bypasses the serverless 4.5MB body
  // limit), then register the returned URLs + metadata with the project. The
  // blob token route authorizes via the JWT passed in clientPayload.
  upload: async (id: string, files: File[], role: string) => {
    const ext = (n: string) => { const i = n.lastIndexOf("."); return i >= 0 ? n.slice(i).toLowerCase() : ""; };
    const metas: { name: string; url: string; size: number; ext: string; role: string }[] = [];
    for (const f of files) {
      const res = await blobUpload(`projects/${id}/${f.name}`, f, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        clientPayload: getToken(),
      });
      metas.push({ name: f.name, url: res.url, size: f.size, ext: ext(f.name), role });
    }
    return api(`/projects/${id}/files`, { method: "POST", body: JSON.stringify({ role, files: metas }) });
  },
  fileBlob: async (id: string, fileId: string): Promise<ArrayBuffer> => {
    const r = await fetch(`/api/projects/${id}/files/${fileId}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!r.ok) throw new Error(`file HTTP ${r.status}`);
    return r.arrayBuffer();
  },
  fileText: async (id: string, fileId: string): Promise<string> => {
    const r = await fetch(`/api/projects/${id}/files/${fileId}`, { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!r.ok) throw new Error(`file HTTP ${r.status}`);
    return r.text();
  },
  deleteFile: (id: string, fileId: string) => api(`/projects/${id}/files/${fileId}`, { method: "DELETE" }),
};

/* saved rate sets */
export const Rates = {
  list: () => api("/rates"),
  save: (name: string, config: any, shared = false) => api("/rates", { method: "POST", body: JSON.stringify({ name, config, shared }) }),
  update: (id: string, patch: { name?: string; config?: any; shared?: boolean }) => api(`/rates/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  remove: (id: string) => api(`/rates/${id}`, { method: "DELETE" }),
};

/* utility-rate history (per-user audit trail) */
export const RateHistory = {
  list: () => api("/rate-history"),
  add: (snapshot: Partial<RateSnapshot>) => api("/rate-history", { method: "POST", body: JSON.stringify(snapshot) }),
  remove: (id: string) => api(`/rate-history/${id}`, { method: "DELETE" }),
  clear: () => api("/rate-history", { method: "DELETE" }),
};

/* Zero Tool (AIA 2030) baseline calculator — proxied via the server (avoids CORS) */
export const ZeroTool = {
  baseline: (buildings: any[]) => api("/zerotool/baseline", { method: "POST", body: JSON.stringify(buildings) }),
};

export function logout() { setToken(null); authUser = null; location.reload(); }
