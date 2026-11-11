# Remontoire integration — developer guide

This guide is written for the integrating agent that delivers processed ESI from
Remontoire into Meridian Edge. It describes the intended delivery sequence, which
field drives which platform feature, concurrency and batch-size guidance, retry and
resume rules, and how to read progress for each phase.

Meridian Edge is **view-only**: the API imports and views items that your pipeline
has **already processed** (text already extracted, natives and review images already
produced). The platform performs no extraction, OCR or forensic processing — a
supplied review image is rendered for display only. Deliver complete items.

- **Base path:** `/api/v1`
- **Authentication:** an API token sent as `Authorization: Bearer <token>`. Create
  one in the platform under **Admin → API tokens**. The request acts as the token's
  owner, and per-case role-based access control then applies.
- **Conventions:** dates ISO 8601 in UTC; hashes lowercase hex SHA-256; language
  codes BCP 47; UK English.
- The authoritative, machine-loadable contract is [`openapi.yaml`](./openapi.yaml).
  Load it directly rather than inferring behaviour from test uploads.

---

## 1. Delivery sequence for a full batch delivery

The batch API (requests 1–11) is the recommended path: it streams structured items
with no load-file conversion step.

```
1. Create (or choose) a case          POST /cases
2. Open a batch, declaring totals      POST /cases/:caseId/batches
3. Send items in parallel pages        POST /cases/:caseId/batches/:batchId/items   (xN, concurrent)
4. Commit the batch                     POST /cases/:caseId/batches/:batchId/commit
5. Watch progress to a terminal state  GET  /cases/:caseId/batches/:batchId   (or .../events SSE)
6. Verify counts (sent == loaded+failed)  read `verification` from the status
7. Attach run reports to the case      POST /cases/:caseId/audit-entries
```

### Step 1 — Create a case

`POST /cases` with `{ "name": "...", "caseNumber": "...", "description": "..." }`.
Requires the `can_create_cases` privilege (or system administrator). Returns the
numeric `id` used as `:caseId` everywhere below.

### Step 2 — Open a batch and declare totals

`POST /cases/:caseId/batches` with the totals you already know, so every progress
count has a denominator from the first byte:

```json
{ "expectedItems": 14, "expectedFiles": 9, "expectedBytes": 48210332 }
```

The response gives you the `batchId` and the server's accepted `concurrency`
(currently **4**). All three expected values are optional but strongly recommended;
the platform echoes them back under `expected`.

### Step 3 — Send items

`POST /cases/:caseId/batches/:batchId/items` as **multipart/form-data**:

- A field named **`items`** (or `manifest`) containing a JSON array of item manifests
  — or the same JSON sent as a file part of that name.
- One multipart **file part per referenced file**, whose field name matches the
  `part` value in the manifest (e.g. `t1`, `n1`, `i1`).

Up to a few hundred items per request; the per-file limit is 2 GiB and up to 5000
parts per request. Items are **upserted on `controlNumber`**, so a resend never
duplicates. The response returns a per-item result (`created` / `updated` / `failed`)
with each file's computed SHA-256 and a `deduplicated` flag, plus any per-item
`errors`. **A request returns HTTP 200 even when individual items failed** — always
read each item's `errors`.

### Step 4 — Commit

`POST /cases/:caseId/batches/:batchId/commit` marks the batch `committing` and runs
finalisation (image rendering, family linking, marking items visible) asynchronously,
returning 202. No further items can be sent after commit.

### Step 5 — Read progress

Poll `GET /cases/:caseId/batches/:batchId`, or subscribe to the SSE stream
`GET /cases/:caseId/batches/:batchId/events` (a `status` event ~every 1.5s, then an
`end` event at a terminal status). See §4 for the phase model.

### Step 6 — Verify

When the batch reaches a terminal status, read `verification` (see §5). Reconcile
`items_received == items_created + items_updated + (failed items)`.

### Step 7 — Attach reports

`POST /cases/:caseId/audit-entries` (multipart) with a JSON `body` and one or more
report file parts. The platform stores each attachment content-addressed, computes
its SHA-256 and returns it, so your report on the platform can be matched to the
original. Entries are **append-only** — a correction is a new entry. Typical usage:

| When a stage finishes | `eventType` | Attachments |
| --- | --- | --- |
| Scan finished | `remontoire.scan.completed` | Scan report |
| Extraction finished | `remontoire.extraction.completed` | Extraction report |
| Pipeline finished | `remontoire.pipeline.completed` | Full reconciliation report |

Set `occurredAt` to when the stage finished (it may differ from when you post), and
`source` to `{ "system": "...", "version": "...", "runId": "..." }`. Link the entry to
the delivery with `batchId` (or `importId`). Allowed attachment types: **PDF, HTML,
JSON, CSV** (up to 50 files, 512 MiB each). Any other type is rejected whole with
`unsupported_attachment_type`.

---

## 2. Which field drives which platform feature

| Platform feature | Manifest field(s) | Notes |
| --- | --- | --- |
| Item identity / upsert | `controlNumber` | Required; the idempotency key. Missing → `missing_control_number`. |
| Extracted text + full-text search | `text[]` with `kind: "extracted"` | First `extracted` version becomes the **original**. Supply via `part` (file) or `inline`/`content`/`text`. No text → counted under `text_missing` and a non-fatal `text_missing` failure is recorded (never loaded with empty text). |
| Translations | `text[]` with `kind: "translation"`, `language`, `translatedFrom`, `method` | Every version is independently indexed, so an English search finds a French original. Reviewer switches versions; original shown by default. |
| Native file + download | `native` `{ part, fileName, mimeType, sha256 }` | Stored content-addressed; `fileName` kept as metadata. Type taken from declared `mimeType`, confirmed against content, **never** defaulted to the image format. |
| Review image | `image` `{ part, format, pageCount, sha256 }` | `format` must be `pdf` or `tiff`; else `unsupported_image_format`. Rendered to page images on commit (display only). An item may carry both a native and an image. |
| Conversation threading | `thread` `{ threadId, position, size, subject }` | Populates `thread_id`, `thread_position`, `thread_size`, `thread_subject`; the viewer groups and orders the thread by position. |
| Family relationships | `parentControlNumber` | Resolved on commit against control numbers in the case. A parent not found is reported as `parent_not_found` (the child is still loaded, flagged), never silently unrelated. |
| Reply tree (optional) | `messageId`, `inReplyTo` | Stored for drawing the reply tree beyond grouping. |
| Metadata | `metadata` (object) | Preserved verbatim and folded into search. |
| Provenance | `processedBy` | Engine + version that produced the item. |

---

## 3. Concurrency, batch size and integrity

- **Concurrency.** The open-batch response states `concurrency` (currently **4**).
  Run up to that many `items` requests in parallel against one batch to tune your
  upload rate; the server applies each request's count deltas under a row lock so
  parallel pages never corrupt the totals.
- **Batch/page size.** A few hundred items per `items` request is the sweet spot.
  Files are held in memory per request, so keep very large natives to their own
  smaller pages. Per-file cap 2 GiB; up to 5000 parts per request.
- **Integrity at the door.** Supply `sha256` on `native`/`image` when you have it.
  The platform rejects the file with `hash_mismatch` if the content differs, and
  **nothing is stored**. The response always returns the computed SHA-256.
- **Deduplication.** Identical content is stored once (content-addressed blob store);
  `deduplicated: true` in the result means only a reference was added.

---

## 4. Reading progress per phase (request 11)

The status payload returns `phases` in this **fixed order**, each with `done`,
`total` and `state` (`pending` → `running` → `complete`):

| Phase | Counted in |
| --- | --- |
| `receiving` | Items received |
| `storing` | Files (natives + images) verified by hash and stored |
| `indexing_text` | Text versions indexed (summed across languages) |
| `rendering` | Review images rendered to page images (on commit) |
| `linking` | Threads and families built (on commit) |
| `finalising` | Items marked visible to reviewers (on commit) |

Rules you can rely on:

- **Counters only increase.** A retried item is counted once; a bar never jumps back.
- **Freshness.** `updatedAt` is refreshed at least every 30 seconds while work
  continues, so a slow job is distinguishable from a stalled one.
- **Explicit end state.** `status`/`endState` finishes at one of `completed`,
  `completed_with_failures` or `failed`, with per-item `failures` attached — the bar
  finishes at a stated result, not merely at 100%.
- **No server estimates.** The platform supplies true counts only; compute any time
  remaining yourself from the observed rate.

Totals during delivery: `receiving.total` and `finalising.total` come from
`expectedItems`; `storing.total` from `expectedFiles` (grown if more files arrive);
`rendering.total` is set from `images_stored` as items arrive.

---

## 5. Verification counts (request 9)

Read `verification` from the batch status (and the import status for load-file
imports):

| Count | Meaning |
| --- | --- |
| `items_received` / `items_created` / `items_updated` | What arrived and what it did |
| `text_indexed` (per language) / `text_missing` | Items with and without searchable text |
| `natives_stored` / `images_stored` / `pages` | Files and pages loaded |
| `threads_populated` / `families_linked` | Relationships built |
| `unmapped_columns` | Columns preserved as metadata only (always `[]` for batch items — structured JSON has no stray columns; populated for load-file imports) |
| `failures` | `{ controlNumber, code, reason, failedValue }` for each item/issue not fully loaded |

Reconcile **items sent == items loaded + items failed**, then attach the
reconciliation to the case as an audit entry (§1, step 7).

---

## 6. Retry and resume rules

Large loads are **idempotent and resumable**:

- **Idempotency on `controlNumber`.** Resend any failed or uncertain `items` request;
  items are upserted, never duplicated. The whole delivery can be driven to a correct
  end state by resending pages until no item reports a failure.
- **Blob pre-check.** Before re-sending a file, call
  `HEAD /api/v1/blobs/:sha256` — **200** means the server already holds that content
  and you can omit the file part (the manifest still references it by `part` only when
  you include it); **404** means send it. This matters for natives repeated across
  many emails.
- **Hash on resend.** Keep supplying `sha256`, so a truncated earlier upload is caught
  as `hash_mismatch` rather than stored corrupt.
- **Restart safety on the platform.** A batch interrupted mid-commit (service restart)
  is re-finalised automatically on boot; finalisation is idempotent (pages upsert,
  families recompute). You simply keep polling the status.
- **Commit is terminal for input.** Once committed, the batch no longer accepts items
  (`batch_not_open`). If you discover a missing item after commit, open a new batch for
  it in the same case.

---

## 7. Error codes

Every error carries a machine-readable `code` and, where applicable, the control
number or file it concerns. Batch/item codes:

`missing_control_number`, `missing_part`, `hash_mismatch`, `text_missing`,
`parent_not_found`, `unsupported_image_format`, `invalid_manifest`, `batch_not_open`,
`item_error`, `finalise_error`, `batch_not_found`.

Lifecycle/retention codes: `not_found`, `forbidden`, `invalid_status`,
`retention_expired`, `unsupported_attachment_type`, `nothing_to_restore`,
`bad_request`.

`text_missing`, `missing_part` and `parent_not_found` are **non-fatal**: the item is
still loaded (flagged), and the issue appears in `verification.failures`. `item_error`
and `hash_mismatch` mean the item/file was not stored.

---

## 8. Delete, archive, retention and restore (request 10)

Permitted for a **system administrator or the case manager who created the case or
import** (not any case manager).

| Action | Endpoint |
| --- | --- |
| Archive / un-archive a case (hides only) | `PATCH /cases/:caseId` `{ "status": "archived" \| "open" }` |
| Delete a whole case | `DELETE /cases/:caseId` |
| Delete an import's documents | `DELETE /cases/:caseId/imports/:importId` |
| Delete a batch's documents | `DELETE /cases/:caseId/batches/:batchId` |
| Delete one document | `DELETE /cases/:caseId/documents/:controlNumber` |
| Restore case / import / document | `POST .../restore` on the matching path |

- Deletes are **soft**, with a **7-day retention window**; restore within the window
  brings records back intact. After it expires, restore returns `retention_expired`
  (410).
- A delete affecting **more than 1000 live documents** returns **202** with
  `{ jobId, pollUrl }`; poll `GET /api/v1/jobs/:jobId` for `docsDone`/`docsTotal`.
- Every delete is written to the internal audit log (who, when, counts and control
  numbers). **Case-level audit entries (request 8) are kept even when documents are
  removed.**

---

## 9. Load-file imports (still supported)

The Concordance DAT/OPT and EDRM XML import path remains available
(`POST /cases/:caseId/imports`, `.../imports/path`, status `GET .../imports/:importId`).
Imports are enqueued (`status: queued`) and processed by the durable background worker
one at a time, surviving restarts. A **field-mapping option** binds your column names
to platform fields without renaming columns, e.g.:

```json
{ "DATESENT": "date", "THREADID": "thread_id" }
```

The batch API is preferred for new integrations (no conversion step, richer
verification, per-language indexing). See the field-mapping reference for the load-file
column equivalents of every batch field.

---

## 10. Operations note — retention purge

Soft-deleted records remain restorable for **7 days** (`retention_until` on `cases`,
`documents` and `loadfile_imports`). Permanent removal of expired records is performed
by `scripts/purge-expired.js`, which is **deliberately not wired to a scheduler** so an
operator stays in control of destructive cleanup on an air-gapped server.

Run it manually, or schedule it with cron:

```bash
# Dry run / manual
node scripts/purge-expired.js

# Example: daily at 02:30, logging to the app log
30 2 * * *  cd /opt/meridian-edge && /usr/bin/node scripts/purge-expired.js >> /var/log/meridian-edge/purge.log 2>&1
```

Until it runs, expired records occupy storage but are hidden from active lists and the
review workspace. Restoring is only possible before the purge removes a record.
