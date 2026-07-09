# Deploying Marcus (Vercel + MongoDB Atlas + Vercel Blob)

The app is now cloud-ready:

- **Frontend** — Vite SPA, served as static files by Vercel.
- **Backend** — the Express app (`server/app.js`) runs as a Vercel serverless
  function via `api/index.js` (and still runs locally / on Render via
  `server/index.js`).
- **Data** — MongoDB Atlas (`cannonMarcus` DB). Collections: `users`,
  `projects`, `rateSets`, `rateHistory`. **Already migrated.**
- **Files** — Vercel Blob, uploaded **directly from the browser** (bypasses the
  4.5 MB serverless body limit), with the URL + metadata stored on the project.

---

## 1. MongoDB Atlas
Already done — data is migrated. Just confirm:
- **Network Access** → allow `0.0.0.0/0` (Vercel's serverless IPs are dynamic).
- ⚠️ **Rotate the database password** — the old one was shared in plaintext.
  Update `MONGODB_URI` everywhere (`.env` + Vercel env) after rotating.

## 2. Create the Vercel project + Blob store
```bash
npm i -g vercel           # if needed
vercel login              # run as:  ! vercel login   (interactive)
vercel link               # link this folder to a (new) Vercel project
```
In the Vercel dashboard → **Storage → Create → Blob** → connect it to this
project. That auto-adds `BLOB_READ_WRITE_TOKEN` to the project's env vars.

## 3. Set environment variables (Vercel → Settings → Environment Variables)
| Name | Value |
|---|---|
| `MONGODB_URI` | your Atlas SRV string (DB `cannonMarcus`) |
| `JWT_SECRET` | a long random string |
| `BLOB_READ_WRITE_TOKEN` | added automatically by the Blob store |
| `OPENAI_API_KEY` | *(optional)* server-side fallback for the AI proxy |

## 4. Migrate the existing uploaded files (one time)
The 330 MB under `server/uploads/` aren't in the cloud yet. Once the Blob store
exists, paste its token into `.env` locally and run:
```bash
# .env → BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
npm run migrate:files
```
This uploads each file to Blob and writes its public `url` onto the project doc
in Mongo. Idempotent — safe to re-run.

## 5. Deploy
```bash
vercel --prod
```
(or push to a Git repo connected to the project — Vercel builds with
`npm run build` and serves `dist/` + the `/api` function automatically.)

---

## Local development
```bash
# .env must have MONGODB_URI, JWT_SECRET, BLOB_READ_WRITE_TOKEN
npm run dev:all        # Express (:3001, Mongo) + Vite (:5173, proxied)
```
File upload locally also uses Vercel Blob, so a `BLOB_READ_WRITE_TOKEN` is
required even in dev.

## Notes
- `server/data/` and `server/uploads/` are now legacy (kept only as the
  migration source). They can be deleted after `migrate:files` succeeds.
- Existing users keep their passwords (hashes were migrated); everyone must log
  in again once because `JWT_SECRET` changed.
