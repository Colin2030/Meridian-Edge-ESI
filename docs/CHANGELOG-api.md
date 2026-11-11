# API Changelog

This changelog records API changes that an integration must adapt to, per release.
It complements the machine-readable `docs/openapi.yaml` and the
`docs/remontoire-developer-guide.md`. Versions follow the repository's `package.json`
`version` field. All endpoints are under the `/api/v1` base and require a bearer API
token (`Authorization: Bearer <token>`) unless noted.

UK English throughout. Meridian Edge remains a view-only review platform: these
changes add import, indexing, retention and reporting surfaces — never any ESI
extraction or forensic processing.

---

## v1.4.0 — Remontoire delivery

The Remontoire delivery implements all 11 integration-partner feature requests.
Integrations should migrate from the load-file-only path to the structured batch API.

### New endpoints

**Item batch API (no load file) — request 1**
- `POST /api/v1/cases/{caseId}/batches` — open a batch. Body (all optional):
  `expectedItems`, `expectedFiles`, `expectedBytes`. Returns
  `{ batchId, concurrency: 4, expected, status: "open" }`.
- `POST /api/v1/cases/{caseId}/batches/{batchId}/items` — submit items. Multipart;
  manifest in form field `items`/`manifest` (JSON array, or object with `.items`),
  referenced parts sent by `part` name. Limits: **5000 files** and **2 GiB per file**
  per request; server-side **concurrency 4**. Returns per-item create/update/failed
  results.
- `POST /api/v1/cases/{caseId}/batches/{batchId}/commit` — finalise (`202`);
  rendering, linking and indexing run asynchronously.
- `GET /api/v1/cases/{caseId}/batches/{batchId}` — status, verification counts, per-
  phase progress, end state.
- `GET /api/v1/cases/{caseId}/batches/{batchId}/events` — Server-Sent Events stream
  (`status` ~every 1500 ms, `end` at terminal).

**Case audit entries with attached reports — request 8**
- `POST /api/v1/cases/{caseId}/audit-entries` — append-only event with optional
  attachments (`.pdf/.html/.htm/.json/.csv`; 50 files, 512 MiB each).
- `GET /api/v1/cases/{caseId}/audit-entries` — list (newest first).
- `GET /api/v1/cases/{caseId}/audit-entries/{entryId}/attachments/{attachmentId}` —
  download an attachment.

**Delete, archive, retention & restore — request 10**
- `PATCH /api/v1/cases/{caseId}` — set status `archived` | `open`.
- `DELETE /api/v1/cases/{caseId}` — soft-delete a case.
- `DELETE /api/v1/cases/{caseId}/imports/{importId}` — soft-delete an import.
- `DELETE /api/v1/cases/{caseId}/batches/{batchId}` — soft-delete a batch.
- `DELETE /api/v1/cases/{caseId}/documents/{controlNumber}` — soft-delete a document.
- `POST /api/v1/cases/{caseId}/restore`,
  `POST /api/v1/cases/{caseId}/imports/{importId}/restore`,
  `POST /api/v1/cases/{caseId}/documents/{controlNumber}/restore` — restore within
  the **7-day** retention window.
- Large deletes (> 1000 live documents) return `202` with a `jobId`; poll
  `GET /api/v1/jobs/{jobId}`.

**Content-addressed blob pre-check**
- `HEAD /api/v1/blobs/{sha256}` — `200` if the blob is already held, `404` otherwise.
  Use before re-uploading natives/images.

### New behaviours

- **Extracted-text indexing fix — request 2.** Each `text[]` entry is indexed per
  language into `document_text` (FTS `to_tsvector('simple', …)`); the case-level
  `documents.search_tsv` weights English metadata (A) and all text (B).
- **Natives with declared type — request 3.** `native.mimeType` is a hint;
  the stored MIME is content-confirmed and never coerced to an image format.
- **PDF/TIFF review image per item — request 4.** `image.format` must be `pdf` or
  `tiff`; rendered to page PNGs on commit (`pdftoppm`/`convert` at 120 dpi).
- **Translated versions — request 5.** `text[]` entries with `kind: translation`,
  `translatedFrom` and `method`.
- **Conversation threading — request 6.** `thread.{threadId,position,size,subject}`.
- **Family by parent ID — request 7.** `parentControlNumber` resolved on commit.
- **Per-import verification counts — request 9.** `items_received/created/updated`,
  `text_indexed` (per language), `text_missing`, `natives_stored`, `images_stored`,
  `pages`, `threads_populated`, `families_linked`, `unmapped_columns`, `failures`.
- **Progress reporting with phases + SSE — request 11.** Fixed phase order:
  `receiving → storing → indexing_text → rendering → linking → finalising`, each
  `{ done, total, state }`.

### Error codes

- Batch: `missing_control_number`, `missing_part`, `hash_mismatch`, `text_missing`,
  `parent_not_found`, `unsupported_image_format`, `invalid_manifest`,
  `batch_not_open`, `batch_not_found`, `item_error`, `finalise_error`.
- Retention/delete: `not_found`, `forbidden`, `invalid_status`, `retention_expired`,
  `unsupported_attachment_type`, `nothing_to_restore`, `bad_request`.

### Operational notes

- **Retention window: 7 days.** Soft-deleted cases/imports/documents are restorable
  for 7 days, after which restore returns `retention_expired` (`410`).
- **Purge script.** `scripts/purge-expired.js` permanently removes items past their
  retention window. It is intentionally **not** wired to a scheduler; run it manually
  or via cron, e.g. `0 2 * * * cd /path/to/meridian-edge && node scripts/purge-expired.js`.
- **Idempotency.** Documents upsert `ON CONFLICT (case_id, control_number)`; batch
  resubmission is safe. `reconcileBatchesOnBoot` re-runs any batch left in
  `committing` after a restart.

### Migration notes for integrations

- Prefer the batch API over load files for new deliveries; load-file DAT/OPT import
  remains supported.
- `unmapped_columns` is always `[]` for batch items (JSON manifests have no stray
  columns); it is populated only on the load-file path.
- The EDRM XML import path does not create an `extracted` `document_text` row; the
  DAT/OPT path is fully covered.

---

## v1.3.0

- Phase 4 web surface: session-authenticated endpoints mounted at `/api/cases` for
  the review UI (document viewer, case history/activity, verification and progress
  display, delete/archive controls). These are browser-session endpoints and are
  separate from the token-authed `/api/v1` integration API.

---

## v1.2.0

- Control-number overlap reporting for load-file imports (detects and reports
  control numbers that collide across imports within a case).

---

## v1.1.0

- Support for large uploads (chunked/resumable import handling).
- EDRM XML import path (migration 008) alongside the existing DAT/OPT load files.
- Run-local import mode for on-host load files.

---

## v1.0.0

- Initial view-only review platform: case creation, load-file (DAT/OPT) import,
  document listing and viewing, API-token authentication.
