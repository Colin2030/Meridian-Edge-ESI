# Meridian Edge

**A lightweight, air-gap-ready ESI review & viewing platform for digital-forensics investigations.**

Meridian Edge Ltd — Head of Professional Services: Colin.

Meridian Edge is a web-based platform for **reviewing and viewing pre-processed electronically
stored information (ESI)**. Data arrives as industry-standard **Concordance-style loadfiles**
(a `.DAT` metadata file + an `.OPT`/Opticon image cross-reference file) together with the native
page images as **multi-page TIFFs and/or PDFs**. Meridian Edge loads, indexes, displays and lets
teams review that material — it is a far lighter, far cheaper alternative to heavyweight tools such
as Nuix Investigate.

> **Scope.** Meridian Edge is a **review/viewing** platform, not a forensic-processing engine. It
> does not acquire, process, de-duplicate or OCR-at-scale raw evidence — that work is done upstream
> by your processing tool, which produces the loadfiles Meridian Edge consumes.

This repository is the **PoC / UAT build** for deployment on the Abacus SuperComputer VM, designed
from the outset so it can later be installed into a **secure / air-gapped** network with **no
external runtime dependencies**.

---

## Table of contents

1. [Key features](#key-features)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [How to run](#how-to-run)
5. [npm scripts](#npm-scripts)
6. [Demo credentials](#demo-credentials)
7. [Roles & permissions (RBAC)](#roles--permissions-rbac)
8. [Loadfile formats supported](#loadfile-formats-supported)
9. [Importing your own data (CLI)](#importing-your-own-data)
10. [In-app "Add Case Data" import](#in-app-add-case-data-import)
11. [Air-gap / secure-network deployment](#air-gap--secure-network-deployment)
12. [Deploy templates](#deploy-templates)
13. [Security notes](#security-notes)
14. [PoC scope vs. production roadmap](#poc-scope-vs-production-roadmap)

---

## Key features

- **Case-based workspaces** with per-case role-based access control.
- **Concordance loadfile ingestion** — `.DAT` (metadata) + `.OPT` (image cross-reference), with
  native **multi-page TIFF** and **PDF** images.
- **In-app "Add Case Data" import** — system admins and case managers can import a loadfile
  deliverable straight from the browser (drag-and-drop a single `.zip`, or pick the `.DAT`/`.OPT` +
  TIFF/PDF files), with a live progress view, an import-history list and plain-English errors. Uses
  the same ingest pipeline as the CLI. See [In-app "Add Case Data" import](#in-app-add-case-data-import).
- **Full-text search** over document body text and metadata (PostgreSQL `tsvector`, GIN-indexed),
  plus metadata/review-state filtering.
- **Document viewer** — page-by-page image rendering, PDF rendering via a **locally bundled**
  pdf.js (no CDN), metadata panel, keyboard navigation (`J`/`K`).
- **Review workflow** — per-document review states (unreviewed / responsive / not-responsive /
  privileged / needs-further-review), bookmarks, tags, folders and threaded comments.
- **User & case administration** (system admin) — create cases, edit case details, and **delete**
  a case with all its data; create users and **edit existing users**: change display name / username /
  email, **reset passwords** (set an explicit one, or generate a one-time temporary password),
  promote/demote **system administrator**, **activate/deactivate** accounts (inactive users are
  blocked from logging in and rejected on their next request), and manage each user's **per-case
  roles** from the user side. Lockout guards prevent self-demotion/self-deactivation and removing
  the last active system admin. See [User administration](#user-administration).
- **Audit logging** of significant actions (login, review changes, imports, admin changes — including
  `user.updated`, `user.password_reset`, `user.role_changed`, `user.activated`/`user.deactivated`).
- **Elegant, calm, non-technical-friendly UI** in the official **monochrome charcoal** Meridian
  Edge identity (charcoal `#202020` / white, with a restrained steel-blue accent), using the
  official logo marks and a locally-bundled favicon — all assets self-hosted (no hotlinking).
- **Air-gap-ready** — zero external runtime network calls; all fonts, JS and the pdf.js worker are
  self-hosted.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Browser (SPA)                                                  │
│  React + Vite + TypeScript + Tailwind                          │
│  pdf.js (worker bundled locally)   self-hosted Inter font      │
└───────────────┬───────────────────────────────────────────────┘
                │  HTTPS (via reverse proxy)  —  /api + static SPA
┌───────────────▼───────────────────────────────────────────────┐
│  Node.js + TypeScript  (Express)      binds 127.0.0.1:4100      │
│  • REST API under /api                                          │
│  • Serves the built SPA as static files (SPA fallback)         │
│  • helmet security headers, httpOnly JWT cookie auth           │
│  • Per-case RBAC enforced server-side                          │
│  • Loadfile parser + image/OCR ingest pipeline                │
└───────────────┬───────────────────────────────────────────────┘
                │  pg (small pool, max 8)
┌───────────────▼───────────────────────────────────────────────┐
│  PostgreSQL  — cases, documents (JSONB metadata + tsvector),   │
│  pages, review_states, memberships, tags, folders, comments,   │
│  audit_log, loadfile_imports                                   │
└───────────────────────────────────────────────────────────────┘

Page images (rendered PNG/TIFF/PDF) live on the local filesystem under uploads/,
served through an access-controlled /api/files/* route (never static-served directly).
```

**Why a single Node server serves both the API and the SPA:** it keeps the air-gapped footprint
minimal — one process, one port, one reverse-proxy rule — and removes any cross-origin concerns.

**Backend layout (`src/`)**

| Area | Files |
|---|---|
| App entry / config / DB | `index.ts`, `config.ts`, `db.ts` |
| Auth & middleware | `lib/auth.ts`, `middleware/auth.ts` |
| Loadfile parsing & ingest | `lib/loadfile.ts`, `lib/ingest.ts` |
| Audit | `lib/audit.ts` |
| Routes | `routes/auth.ts`, `routes/cases.ts`, `routes/documents.ts`, `routes/admin.ts`, `routes/files.ts`, `routes/imports.ts` (in-app upload) |

**Scripts (`scripts/`):** `migrate.ts`, `seed.ts`, `import.ts` (CLI importer), `gen_samples.ts` +
`sample_content.ts` + `pdf_render.py` (synthetic demo-data generator).

**Migrations (`migrations/`):** `001_init.sql` — full schema; `002_imports.sql` — extra
`loadfile_imports` columns (progress phase, doc/page counters, source kind, warnings) for the
in-app importer (idempotent `ADD COLUMN IF NOT EXISTS`).

---

## Prerequisites

Everything runs **fully offline** once these are present on the host:

| Requirement | Used for | Verified-with version on the PoC VM |
|---|---|---|
| **Node.js** ≥ 20 (22/24 fine) | API server, build tooling | v24.21.0 |
| **PostgreSQL** ≥ 14 (17 fine) | database | 17.x |
| **ImageMagick** (`convert`) | TIFF page rendering | 6.9.12 |
| **Poppler** (`pdftoppm`, `pdfinfo`) | PDF page rendering/metadata | 24.02.0 |
| **Tesseract** (`tesseract`) | *optional* OCR of page images | 5.3.4 |
| **Python 3 + reportlab** | *demo-data generation only* (not needed at runtime) | reportlab 5.0.1 |

> OCR (Tesseract) is **optional** and **off by default** (`ENABLE_OCR=false`). The demo dataset
> embeds extracted body text directly in the loadfile, so full-text search works without OCR. Turn
> OCR on only when importing image-only material that lacks an extracted-text field.

### Environment variables (`.env`)

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string. |
| `PORT` | `4100` | App listens on `127.0.0.1:$PORT`. |
| `SESSION_SECRET` | `dev-insecure-secret-change-me` | **Set a strong random value in production** — signs the JWT session cookie. |
| `NODE_ENV` | `development` | Use `production` for deployment. |
| `ENABLE_OCR` | `false` | `true` to OCR imported page images with Tesseract. |

---

## How to run

From the project root (`/home/ubuntu/meridian-edge`):

```bash
# 1. Install dependencies (also installs the web/ frontend via postinstall)
npm install

# 2. Ensure .env has DATABASE_URL (+ a strong SESSION_SECRET for real deployments)
#    On the Abacus VM the dedicated Postgres URL is already in .env.

# 3. Create the schema
npm run migrate

# 4. Load the synthetic demo data (generates sample TIFFs/PDFs + loadfiles,
#    then imports them through the real loadfile pipeline)
npm run seed

# 5. Build the frontend bundle + compile the backend to dist/
npm run build

# 6. Start the server
npm start
#    → listening on http://127.0.0.1:4100
```

Then browse to the server (through the reverse proxy / public hostname) and sign in with a demo
account below.

---

## npm scripts

| Script | What it does |
|---|---|
| `npm install` | Installs backend deps; `postinstall` installs the `web/` frontend deps. |
| `npm run build` | `build:web` (Vite bundle, assets self-hosted) **+** `build:server` (`tsc` → `dist/`). |
| `npm run build:web` | Build only the frontend. |
| `npm run build:server` | Compile only the backend TypeScript to `dist/`. |
| `npm run migrate` | Apply SQL migrations in `migrations/`. |
| `npm run seed` | Generate + import the "Operation Northwind (DEMO)" dataset and seed demo users/cases. |
| `npm run import -- --case <id> --dat <f.DAT> --opt <f.OPT> --images <dir> [--ocr]` | Import a real loadfile into an existing case. |
| `npm run gen-samples` | (Re)generate the synthetic sample files only. |
| `npm start` | Run the compiled server (`node dist/index.js`). |
| `npm run dev` | Dev mode with auto-reload (`ts-node-dev`). |

---

## Demo credentials

Seeded by `npm run seed` (also printed to the seed output). **Change or remove these before any
real deployment.**

| Username | Password | Access |
|---|---|---|
| `admin` | `Admin!Northwind2025` | **System admin** — full access to every case + user/case administration. |
| `manager` | `Manager!Northwind2025` | **Case manager** on *Operation Northwind* **and** *Operation Blackthorn*. |
| `reviewer` | `Reviewer!Northwind2025` | **Reviewer** on *Operation Northwind* **only**. |
| `readonly` | `ReadOnly!Northwind2025` | **Read-only** on *Operation Northwind*. |

**Demo cases**

- **Operation Northwind (DEMO)** — ~20 fictional documents (emails, memos, invoices, interview
  notes) across 37 pages, a mix of multi-page TIFFs and PDFs. All content is **clearly fictional**
  (a fabricated procurement-fraud scenario at the fictional "Harwick Logistics Ltd") with **no real
  personal data**.
- **Operation Blackthorn (DEMO)** — a second case that the `reviewer` account is **not** a member
  of, to demonstrate case isolation (reviewer receives **HTTP 403**).

---

## Roles & permissions (RBAC)

Enforced **server-side** on every request (never trusted from the client).

| Capability | system_admin | case_manager | reviewer | read_only |
|---|:---:|:---:|:---:|:---:|
| See / search / view documents in the case | ✓ (all cases) | ✓ | ✓ | ✓ |
| Bookmark documents | ✓ | ✓ | ✓ | ✓ |
| Change review state | ✓ | ✓ | ✓ | — |
| Add comments | ✓ | ✓ | ✓ | — |
| Apply tags | ✓ | ✓ | ✓ | — |
| Manage case members, tags, folders, imports | ✓ | ✓ | — | — |
| Create cases / manage users (global) | ✓ | — | — | — |
| Access a case they are **not** a member of | ✓ | — (403) | — (403) | — (403) |

Role hierarchy: `system_admin` (global) › `case_manager` › `reviewer` › `read_only`.

---

## User administration

System administrators manage accounts from **Administration → Users**. Each user row has an **Edit**
action (and a quick Activate/Deactivate toggle); Edit opens a panel to correct a record or manage
access. All of the endpoints below are **system-admin-only, enforced server-side**, and every change
is written to the audit log (password values are never logged).

| Action | Endpoint | Notes |
|---|---|---|
| List users | `GET /api/admin/users` | |
| Create user | `POST /api/admin/users` | |
| **Edit profile** | `PUT /api/admin/users/:id` | Update `displayName` / `username` / `email`. Display name & username must be non-empty; username must be unique (`409`); email format-checked. Audits each field old → new (`user.updated`). |
| **Reset password** | `POST /api/admin/users/:id/reset-password` | Mode (a) `{ newPassword }` (min 8 chars); mode (b) `{ generate: true }` returns a strong `temporaryPassword` **once** in the response. bcrypt-hashed; audits `user.password_reset` (no value). |
| **Change global role** | `PUT /api/admin/users/:id/role` | `{ isSystemAdmin }` — promote/demote system administrator. Audits `user.role_changed`. |
| **Activate / deactivate** | `PUT /api/admin/users/:id/active` | `{ active }`. Inactive users cannot log in (`403 "This account is inactive…"`) and existing sessions are rejected on the next request. Audits `user.activated` / `user.deactivated`. |
| **List a user's case access** | `GET /api/admin/users/:id/memberships` | Cases + role. |
| **Add / change per-case role** | `POST /api/admin/users/:id/memberships` | `{ caseId, role }` (`case_manager` / `reviewer` / `read_only`); upserts. Audits `member_assigned` / `member_role_changed`. |
| **Remove from a case** | `DELETE /api/admin/users/:id/memberships/:caseId` | Audits `member_removed`. |

**Lockout guards** (return `400` with a clear message): an admin cannot remove their own system-admin
access or deactivate their own account, and the **last active system administrator** cannot be demoted
or deactivated — so the platform can never be locked out. User **deletion is intentionally not
provided**; deactivation is the safe, reversible way to retire an account.

---

## Loadfile formats supported

Meridian Edge ingests the standard **Concordance / Opticon** pair.

### `.DAT` — metadata (delimited)

- **Concordance delimiters** (default, auto-detected): field separator `\u0014` (ASCII 20),
  text qualifier `\u00FE` (þ, ASCII 254), multi-value separator `;`.
- **CSV** and **TSV** are also auto-detected as a fallback.
- The **first row is the header**. Field names are matched case-insensitively against a built-in
  alias table, so common variants are understood automatically, e.g.:
  - control number / Bates begin → `DOCID` / `BEGDOC` / `Control Number` / `ControlNumber`
  - `BEGATTACH` / `ENDATTACH`, `CUSTODIAN`, `AUTHOR` / `FROM`, `TO`, `CC`, `BCC`,
    `SUBJECT` / `TITLE`, `DATESENT` / `DATE`, `FILENAME`, `FILEEXT`, `PAGES`, `MD5`/`HASH`
  - an extracted-text pointer / body field (`EXTRACTED_TEXT`, `OCRTEXT`, `TEXTPATH`, …)
- Unknown fields are preserved verbatim and shown in the document metadata panel (stored as JSONB).

### `.OPT` — Opticon image cross-reference

Standard Opticon CSV, one line per page image:

```
IMAGEKEY,VOLUME,PATH\IMAGEFILE,DOCBREAK(Y/empty),,,PAGECOUNT
```

- `IMAGEKEY` of the **first page of a document** must equal that document's control number
  (`DOCID`/`BEGDOC`) in the `.DAT` so pages can be grouped to their document.
- `DOCBREAK = Y` marks the first page of a new document; subsequent blank-flag lines are
  continuation pages of the same document.
- Image paths are resolved relative to the `--images` directory. **Multi-page TIFFs** (one file,
  many pages) and **PDFs** are both supported; pages are rendered to PNG for display.

---

## Importing your own data (CLI)

```bash
npm run import -- \
  --case 1 \
  --dat  /path/to/export.DAT \
  --opt  /path/to/export.OPT \
  --images /path/to/images_dir \
  [--ocr]          # run Tesseract OCR on page images (otherwise relies on .DAT text field)
```

The importer parses the loadfile, renders/links pages, (optionally) OCRs them, inserts documents
+ pages + initial review states, builds the search index, and records a row in `loadfile_imports`
and the audit log. The exact same pipeline is used by `npm run seed`.

---

## In-app "Add Case Data" import

Non-technical case teams don't need the CLI: a **system admin** or **case manager** can import a
loadfile deliverable straight from the browser.

**Where:** the **"Add case data"** button on a case workspace (visible only to admins/managers), or
the route `/cases/:caseId/import`. The page is hidden for reviewers/read-only users, **and the API
enforces the same rule** (see below) so UI hiding is never the only guard.

**What you upload — two clearly-labelled options:**

1. **A single `.zip`** containing the whole loadfile folder (the `.DAT`, the `.OPT` and the TIFF/PDF
   images, in any sub-folder layout). Drag-and-drop it onto the drop zone.
2. **Individual files** — pick the `.DAT`, the `.OPT` and the TIFF/PDF images with the file picker.

The page detects and labels which file looks like the `.DAT` and which the `.OPT`, lists every
selected file with its size, and lets you remove items before submitting. A short plain-English
explainer describes what a loadfile is, with the precise format on a secondary line.

**What happens on submit:**

1. The files upload with a **progress bar**.
2. The server stages them in a private per-case / per-import directory (never web-served), unzips a
   `.zip` if provided, locates the `.DAT` + `.OPT`, flattens the referenced TIFF/PDF images, and
   starts a **background import job**.
3. The page switches to a **live progress view** that polls a status endpoint
   (`pending → parsing → rendering pages X/Y → completed`), ending with a success summary
   ("Imported N documents / M pages") and a **link to review them** — or a clear, specific error.
4. Any image files referenced by the loadfile but missing from the upload are reported as a plain
   warning ("Completed with 3 missing image reference(s): …"); the import still completes for the
   documents whose images were present.

An **Import history** table on the page lists previous imports for the case (date, who, name,
doc/page counts, status) so managers can see exactly what has been loaded.

### API surface (`routes/imports.ts`, mounted under `/api/cases`)

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/cases/:caseId/imports` | `case_manager`+ (admin/manager) | Multipart upload (`files`: the `.zip` **or** the `.DAT`/`.OPT`/images). Stages, validates (≥1 `.DAT` required, else `400 "No .DAT loadfile found in the upload"`), creates the `loadfile_imports` row, audits `import.started`, kicks the background job, returns `202 { importId, status, datFile, optFile, imageCount }`. |
| `GET /api/cases/:caseId/imports/:importId` | case member | Live status for the progress view (phase, docs/pages done, warnings/error). |
| `GET /api/cases/:caseId/imports` | case member | Import history for the case. |

The write endpoint uses `requireCaseRole('case_manager')`, so **reviewers and read-only users
receive HTTP 403** (verified). The background job reuses `src/lib/ingest.ts` end-to-end — the in-app
path and the CLI path produce identical results.

> **Still view-only.** This feature imports **already-processed** loadfile deliverables for
> *viewing/review*. It does **not** process, de-duplicate or forensically acquire raw evidence —
> that remains an upstream responsibility.

**Notes & limits**

- Upload limits (set in both the nginx vhost and multer): **512 MB** per request, up to 2000 files.
  Keep `client_max_body_size` in `deploy/` in step with multer's `fileSize` if you change them.
- The background job runs **in-process** (single Node process) — fine for the PoC's import sizes; a
  dedicated job queue is on the production roadmap for very large deliverables.
- Images are matched to `.OPT` references by **basename**, so nested zip folder layouts are handled.
- Staged upload files are retained under `uploads/imports/<caseId>/<importId>/` as a record (not
  web-served; reachable only through the access-controlled file gate).

---

## Air-gap / secure-network deployment

Meridian Edge is built to run in a network with **no internet access**:

- **Zero external runtime network calls.** No CDN links, no Google Fonts, no telemetry, no
  outbound analytics. The **Inter** font (`@fontsource/inter`) and the **pdf.js worker** are
  bundled into the local build and served from the app's own static assets.
- **All configuration via environment variables** (`.env`) — no external config service.
- **Self-contained runtime.** Only Node, PostgreSQL and the image tools (ImageMagick / Poppler /
  optionally Tesseract) need to be present on the box.

**Installing on an air-gapped host**

1. On an internet-connected machine with the **same OS/arch**, run `npm install` and `npm run
   build` so `node_modules/`, `web/node_modules/` and the built `dist/` + `web/dist/` are fully
   populated.
2. Transfer the whole project directory (including `node_modules`) to the air-gapped host via your
   approved media, **or** pre-stage an npm offline cache / private registry mirror and run
   `npm ci` there.
3. Ensure Node, PostgreSQL and the image tools are installed from your internal package mirror.
4. Create `.env` with `DATABASE_URL`, a strong `SESSION_SECRET`, `NODE_ENV=production`.
5. `npm run migrate`, create cases/users (or `npm run seed` for a demo), `npm start`.
6. Front it with the nginx template in `deploy/` and add your own TLS certificate.

---

## Deploy templates

Ready-to-adapt templates live in **`deploy/`** (they are **not** installed by this build):

- **`deploy/meridian-edge.service`** — a hardened `systemd` unit. Reads all config from
  `.env` via `EnvironmentFile`, runs `node dist/index.js`, auto-restarts on failure.
- **`deploy/nginx-vhost.conf`** — a reverse-proxy vhost that forwards to `127.0.0.1:4100`,
  preserves `X-Original-Host` / `X-Forwarded-Proto`, is WebSocket-safe, and sets sensible cache
  headers. Includes notes on TLS and on the frame-ancestors/iframe behaviour.

Each file's header comments contain the exact install commands.

---

## Security notes

- **Passwords** are hashed with **bcrypt**; plaintext is never stored.
- **Sessions** use a signed **JWT in an httpOnly, SameSite cookie** (`Secure` behind HTTPS) — not
  readable by JavaScript.
- **helmet** sets security headers, including a Content-Security-Policy. The CSP uses
  `frame-ancestors 'self' https://*.abacus.ai` (and omits `X-Frame-Options`) so the app previews
  inside the Abacus console while remaining protected elsewhere — tighten this for your network.
- **RBAC** is enforced server-side on every route; the client UI merely reflects it.
- **Reverse-proxy aware** — trusts `X-Forwarded-Proto` and builds URLs from `X-Original-Host`.
- **File access is gated** — document images are served only through `/api/files/*` after a case-
  access check, with path-traversal protection; the `uploads/` directory is never static-served.
- **Audit log** records logins, review-state changes, imports and admin actions.

---

## PoC scope vs. production roadmap

**In this PoC / UAT build**

- Full Concordance `.DAT` + `.OPT` loadfile ingest with multi-page TIFF and PDF images, via the
  CLI **and** the in-browser "Add Case Data" importer (zip or individual files, live progress,
  import history) for admins/managers.
- Case workspaces, per-case RBAC (4 roles), server-side enforcement, case isolation.
- Full-text + metadata search, document viewer with local pdf.js, review states, bookmarks, tags,
  folders, comments.
- Optional Tesseract OCR, audit logging, helmet security headers, httpOnly JWT auth.
- Synthetic demo dataset + seeded users; systemd + nginx deploy templates; air-gap-ready build.

**Production roadmap (not in this PoC)**

- **AuthN/AuthZ:** SSO / SAML / OIDC, enterprise directory (LDAP/AD) integration, MFA, password
  policy & rotation, fine-grained per-folder/per-tag permissions.
- **Scale & performance:** background job queue for large imports, streaming/tiled image delivery,
  thumbnail generation, search sharding, pagination/virtualisation tuning for very large cases,
  connection-pool/HA Postgres.
- **Review power features:** saved searches, near-duplicate/email-threading views, bulk tagging &
  bulk review, production/export sets (loadfile + image export back out), redactions & burned-in
  annotations, privilege logs.
- **Operations:** structured central logging, metrics/health dashboards, automated backups &
  disaster recovery, data-retention/legal-hold policies, full chain-of-custody reporting.
- **Hardening:** per-deployment CSP, rate limiting, encryption-at-rest guidance, formal pen-test &
  accreditation pack for the target secure network.
- **Deployment:** containerised (Docker/OCI) and/or offline installer bundle, blue/green upgrades,
  configuration management.

---

*Meridian Edge — © Meridian Edge Ltd. Demo content is entirely fictional.*
