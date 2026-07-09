/* ============================================================
 *  Environment loader — resolves the project-root .env by absolute
 *  path so the server works regardless of the current working
 *  directory (e.g. launched from server/ or from the repo root).
 *  Imported FIRST (before db.js) so process.env is populated before
 *  any module reads MONGODB_URI at load time. On Vercel there is no
 *  .env file and dotenv is a harmless no-op (env comes from the host).
 * ============================================================ */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });
