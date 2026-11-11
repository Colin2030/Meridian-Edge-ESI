# Changelog — Meridian Edge on-premise package

All notable changes to the on-premise deployment package are documented here.
Meridian Edge is a **view-only** ESI review platform; these releases change
packaging, limits and tooling only — they add no ESI processing/forensic
capability.

## v1.4.0 — 2026-11-11

Remontoire delivery: direct item ingestion, verification, audit trail and
lifecycle management. Meridian Edge remains a **view-only** ESI review platform;
this release adds ingestion, verification and management of *already-processed*
items — it adds no ESI processing, extraction, OCR or forensic capability.

New database migrations `011`–`017` (idempotent; applied automatically by
`install.sh`/`migrate.sh`, never dropping existing data). All eleven integration
requests from the delivery partner are addressed:

- **Item batch API, no load file** — `POST /api/v1/cases/:caseId/batches` opens a
  batch; `.../items` streams up to a few hundred items per request as a JSON
  manifest plus multipart file parts; `.../commit` closes it and indexing runs
  asynchronously. Items are upserted on `controlNumber`, so a retried request
  never duplicates. Several item requests may run in parallel (declared
  concurrency returned by the server).
- **Extracted-text indexing** — text supplied by part or inline string is indexed;
  UTF-8 with or without a byte-order mark is accepted; `text_indexed` /
  `text_missing` are reported per language. The load-file `TEXTPATH` resolution
  defect is fixed.
- **Natives with their declared type** — the native is stored as supplied and
  offered for download; its type is taken from a declared field (`mimeType` /
  `FILETYPE` / `MIMETYPE`) with content-detection fallback, never the image
  format; the original file name is kept beside the storage (hash) name.
- **PDF or TIFF review image per item** — one multi-page PDF per item with no
  `.OPT` file needed; single-page TIFF with `.OPT` still accepted; an item may
  carry a native (download) and an image (viewing) together.
- **Translated versions** — any number of text versions per item, each tagged
  with a BCP 47 language code, original/translation flag, source language and
  method; every version is indexed; the viewer switches versions (original by
  default). Load-file `TRANSLATEDTEXTPATH` / `TRANSLATEDFROM` accepted.
- **Conversation threading** — `thread_id`, position and size populated from
  `threadId`/`position`/`size` (batch) or `THREADID`/`THREADPOSITION`/`THREADSIZE`
  (load file); thread subject accepted or derived; the viewer shows the thread in
  order with a per-document count.
- **Family relationships by parent ID** — `parentControlNumber` / `PARENTID`
  builds families from explicit links; `BEGATTACH`/`ENDATTACH` still accepted;
  items whose parent is absent are reported, not loaded as unrelated documents.
- **Case audit entries with attached reports** — `POST /api/v1/cases/:caseId/
  audit-entries` records an append-only entry carrying one or more report files
  (PDF/HTML/JSON/CSV); the platform records the posting user and time and a
  SHA-256 of each attachment; entries list and attachments download via the API
  and show in the case history.
- **Per-import verification counts** — the batch/import status returns
  `items_received`/`items_created`/`items_updated`, `text_indexed`/`text_missing`,
  `natives_stored`/`images_stored`/`pages`, `threads_populated`/`families_linked`,
  `unmapped_columns` and per-item `failures` (control number + machine-readable
  `code`).
- **Delete and archive** — `DELETE` for a case, an import/batch, or a single
  document, and `PATCH {"status":"archived"}` to hide a case; restricted to a
  system administrator or the owning case manager; every delete is audited;
  case-level audit entries survive document removal; a 7-day retention window
  with a restore endpoint guards against mistakes; large deletes return
  `202 Accepted` with a job to poll.
- **Progress reporting** — `POST .../batches` accepts `expectedItems` /
  `expectedFiles` / `expectedBytes`; the status returns each phase (`receiving`,
  `storing`, `indexing_text`, `rendering`, `linking`, `finalising`) as
  `done`/`total`/`state`; counts only go up; `updatedAt` is refreshed at least
  every 30 seconds; the end state is explicit (`completed`,
  `completed_with_failures` or `failed`). Server-sent events on
  `GET .../batches/:batchId/events` carry the same fields.

Also added: `HEAD /api/v1/blobs/:sha256` so a client can skip files the server
already holds; a field-mapping option on import; content-addressed blob storage
with SHA-256 verification at the door; a manual retention purge utility
(`scripts/purge-expired.js`, operator-run, not scheduled).

Documentation for integrating agents is shipped under `docs/`: an OpenAPI 3.1
specification (`openapi.yaml`), a developer guide, a field-mapping reference, a
reference package with expected results, and a per-version API changelog.


## v1.3.2 — 2026-11-10

Fix blank/white page on plain-HTTP (non-TLS) deployments (view-only guarantee unchanged).

- The security middleware (helmet) was emitting a Content-Security-Policy
  "upgrade-insecure-requests" directive by default, which forced browsers to
  request all assets over HTTPS. On a plain-HTTP on-prem/LAN box this made every
  asset fail (requested over https on a port nothing listens on), rendering a
  blank white page even though the server was healthy. The directive is now
  emitted only when FORCE_HTTPS=true, so the app works out-of-the-box over HTTP.
- New optional .env setting FORCE_HTTPS (default false). Set it to true only when
  the site is served over TLS; it re-enables the HTTPS upgrade directive.
- No changes to the application features, database schema, or migrations (001–010
  as in v1.3.0/v1.3.1).

## v1.3.1 — 2026-11-10

Installer robustness (no application changes; view-only guarantee unchanged).

- install.sh, migrate.sh, run-local.sh and uninstall.sh now prepend the standard
  sbin directories (/usr/sbin, /sbin) to PATH at startup. On minimal Debian hosts
  — and under sudo's secure_path — these are frequently omitted, which made
  useradd, nginx and systemctl report "command not found" even when installed.
  The installer no longer depends on the caller's PATH.
- No changes to the application, database schema, or migrations (001–010 as in v1.3.0).

## 1.3.0

### Added
- **Durable, serialised, restart-safe import queue** (migration `010_import_queue.sql`).
  Loadfile imports are now processed by a single background worker, strictly one
  at a time, backed entirely by database state. A service restart no longer
  orphans an in-flight import: the worker detects a stale heartbeat on boot and
  automatically **resumes** the interrupted import from its staged source (ingest
  is idempotent — documents and pages upsert on their deterministic keys, so no
  duplication). The imports panel shows a live queue (processing item plus the
  ordered list of queued parts). Rendering runs in a forked child process so the
  API and heartbeats stay responsive during large conversions.
- **Self-service import retry / reset.** Case managers can retry a failed or
  interrupted import (re-enqueued through the same durable path when its source is
  still staged) or reset an orphaned one, from the imports panel — no database
  access required.
- **Email conversation threading** (migration `009_email_threading.sql`). A
  view-only Conversation panel groups messages into their thread, with a thread
  badge in the document list. No message content is altered.

### Changed
- **Robust loadfile field mapping.** Document names, types, dates and subjects in
  the file list, viewer, binder and file-type filter now resolve across common
  loadfile field-name variants (e.g. `SUBJECT`/`File Name`/`FILENAME`,
  `FILETYPE`/`DOCTYPE`/native type, `DATESENT`/`Date Sent`/`DATE`). Corpora that
  use a different Concordance/EDRM field naming now display real names and
  meaningful types (e.g. email subjects and an "Email" type) instead of raw
  control numbers and blank/"Unknown" types. Import/upload endpoints now return
  promptly (HTTP 202) and enqueue rather than rendering inline.

### Notes
- This package ships migrations **001–010**. Migrations are idempotent, so
  `install.sh` / `migrate.sh` remain both the clean-install and the upgrade path
  and never drop data.
- Meridian Edge remains a **view-only** ESI review platform. These changes
  sequence and make durable the import of pre-processed loadfiles and improve
  display; they add no ESI processing, collection or forensic capability.

## 1.2.0

### Added
- **Configurable per-request upload file-count limit.** The maximum number of
  files accepted in a single import request is now configurable via
  `MAX_UPLOAD_FILES` in `.env` (default `2000`), replacing the previous
  hard-coded limit of 2000. Raise it when a single Concordance/EDRM chunk
  legitimately contains more files than the default (for example a large
  `images/` set). This is a file **count**, distinct from the
  `MAX_UPLOAD_BYTES` byte-size cap.
- **Chunked-import control-number overlap reporting.** When a chunked import
  re-uses a control number that already exists, the document is updated **in
  place** rather than duplicated, and any such overlap is now surfaced to
  reviewers — recorded in the import's error/notes field and in the
  `import.completed` audit detail — so overlapping control numbers across chunks
  are visible after the run.

### Changed
- Exceeding the per-request file-count limit now returns a clean **HTTP 413**
  response carrying a machine-readable `code` and the effective `limit`, instead
  of an opaque HTTP 500.
- Corrected stale upload-limit wording in the bundled documentation and
  `.env.example`, and documented `MAX_UPLOAD_FILES` and the control-number
  overlap reporting behaviour.

### Notes
- The platform remains **view-only**: this release adjusts upload limits, import
  reporting and documentation only — it adds no ESI processing, collection or
  forensic capability. Meridian Edge continues to import pre-processed loadfile
  output produced by external engines.
- Rebuilt from current source (compiled `dist/`, built `web/dist/`, re-vendored
  production `node_modules/` via `npm ci --omit=dev`, pure-JS, air-gap ready);
  migrations unchanged at **001–008**.
- The package continues to embed **only** the Ed25519 licence **public** key
  (`dist/lib/licensePublicKey.js`); the private signing key is never distributed.

## 1.1.0

### Added
- **Large / multi-GB dataset uploads.** Upload size is configurable via
  `MAX_UPLOAD_BYTES` in `.env` (default `0` = unlimited). The bundled nginx
  template now streams request bodies straight through
  (`client_max_body_size 64g`, `proxy_request_buffering off`) with long
  (`3600s`) `proxy_read_timeout` / `proxy_send_timeout` / `client_body_timeout`
  for slow large transfers — applied in both the HTTP and the commented TLS
  server blocks.
- **EDRM XML import migration** `008_edrm_xml.sql`. This package now ships
  migrations **001–008**.
- **New local / developer run path** `run-local.sh` — runs the platform on a
  Linux or macOS workstation with **no root, no systemd and no nginx**. It checks
  Node 18+ and PostgreSQL reachability, creates a local `app/.env` (generated
  `SESSION_SECRET`, `NODE_ENV=development`, `PORT=4600`, `MAX_UPLOAD_BYTES=0`),
  runs migrations, optionally bootstraps the first admin, and starts the server
  in the foreground bound to `127.0.0.1`.
- Documentation for the **two supported install modes** (production
  `install.sh` vs local `run-local.sh`) in `README.md` and `docs/RUNBOOK.md`.

### Notes
- Rebuilt from current source (compiled `dist/`, built `web/dist/`, re-vendored
  production `node_modules/` via `npm ci --omit=dev`, pure-JS, air-gap ready).
- The package continues to embed **only** the Ed25519 licence **public** key
  (`dist/lib/licensePublicKey.js`); the private signing key is never distributed.

## 1.0.0

- Initial self-contained, air-gapped on-premise package: compiled server, built
  SPA, vendored production dependencies, migrations 001–007, `install.sh` /
  `uninstall.sh` / `migrate.sh`, systemd + nginx templates, and the
  administrator runbook.
