/* Tiny JSON-file database — no native deps, cross-platform.
   Stores users, projects, and saved utility-rate sets. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, "data");
export const UPLOAD_DIR = path.join(__dirname, "uploads");
const DBFILE = path.join(DATA_DIR, "db.json");

for (const d of [DATA_DIR, UPLOAD_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

const EMPTY = { users: [], projects: [], rateSets: [], rateHistory: [] };
export const db = load();

function load() {
  if (fs.existsSync(DBFILE)) {
    try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(DBFILE, "utf8")) }; }
    catch { return structuredClone(EMPTY); }
  }
  fs.writeFileSync(DBFILE, JSON.stringify(EMPTY, null, 2));
  return structuredClone(EMPTY);
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DBFILE, JSON.stringify(db, null, 2)), 50);
}
export function saveNow() { fs.writeFileSync(DBFILE, JSON.stringify(db, null, 2)); }

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
