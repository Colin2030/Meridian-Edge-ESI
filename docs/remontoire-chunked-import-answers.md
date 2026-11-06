# Meridian Edge — answers to the Remontoire chunked-import questions

Responses to the four "Questions for Meridian Edge" in the Remontoire chunked-import
design note (client-side chunking of a large Concordance package into sequential
`POST /api/v1/cases/:caseId/imports` calls into one case).

Scope note: the chunking is entirely a Remontoire delivery-plugin change and needs no
Meridian Edge change to begin using, as your note states. The points below confirm the
behaviour you asked about and describe one small platform-side change (version 1.1.0)
that makes sequential chunked imports into a single case **auditable** rather than
silently last-wins. Meridian Edge remains view-only: it imports the output of your
processing engine and performs no processing, OCR or forensic acquisition itself.

---

## Q1 — Is image-filename uniqueness and collision reporting enforced across multiple `imports` calls into one case, or only within a single call?

Two separate things, so taken in turn:

**Image basenames — reported per call.** `flattenImages()` in `src/routes/imports.ts`
detects duplicate image basenames **within a single request's** staging directory and
returns them in the `collisions` array on the `202` response; duplicates are skipped,
not overwritten. There is no cross-call basename check, and it is not needed: rendered
pages are stored **namespaced per document by control number** in a per-case store
(`<uploads>/case-<id>/rendered/<CONTROL_NUMBER>/…`), so an image basename that recurs in
a later chunk does not collide on disk or corrupt data, provided the control numbers are
distinct.

**Control number — the real cross-call integrity signal, now reported.** Document
identity within a case is the unique key `(case_id, control_number)`
(`migrations/001_init.sql`). Both ingest paths (`runImport` for DAT/OPT and
`runEdrmImport` for EDRM XML, in `src/lib/ingest.ts`) upsert with
`ON CONFLICT (case_id, control_number) DO UPDATE`. So when a later chunk re-uses a
control number already present in the case — or duplicates one within the same chunk —
that document row is updated in place.

As of version 1.1.0 this is **reported** rather than silent. Each upsert now returns
`(xmax <> 0) AS was_overwrite` to distinguish an in-place update from a fresh insert; the
affected control numbers are collected and surfaced on completion in three places:

- the import row's note — the `error` field returned by
  `GET /api/v1/cases/:caseId/imports/:importId` and by the import-history list;
- the audit log, in the `import.completed` entry;
- the ingest log callback (greppable `! overwrote control number for …`).

Example note on an overlapping chunk:

> `1 document(s) re-used a control number already present in this case and were updated
> in place (chunk/import overlap): DOC-0002`

**Net:** chunks that preserve the source package's existing global uniqueness of control
numbers are safe and are now additionally auditable — any accidental overlap between
chunks shows up on the import row, the status endpoint and the audit log instead of
passing unnoticed.

---

## Q2 — Appetite for a native multi-part / resumable upload (initiate / upload numbered parts / complete)?

There is **no native multi-part or resumable upload on this endpoint today.** The `file`
field may repeat **within a single request** (multer `upload.any()`), but there is no
cross-request session that stitches numbered parts together or resumes an interrupted
transfer.

It is a reasonable future enhancement and we have noted it, but we are **not building it
now**. For the immediate need, your sequential client-side chunking plus the existing
server-side path import (Q3) cover large matters without protocol changes. We will raise
a native resumable-upload design separately if there is sustained demand.

---

## Q3 — For multi-terabyte matters, preferred way to arrange a server-reachable path for `imports/path`, and is `INGEST_ALLOWED_ROOTS` the right lever on a customer's own install?

Yes — `INGEST_ALLOWED_ROOTS` is exactly the right lever, and `imports/path` is our
recommended route for multi-terabyte matters because it ingests with **no HTTP request
body at all** (no upload size, no file-count cap, no idle-connection window in play).

Mechanism (`validateIngestPath()` in `src/routes/imports.ts`):

- An administrator sets `INGEST_ALLOWED_ROOTS` (comma-separated absolute paths) to the
  customer's **own mounted ESI shares** — SMB, NFS, or BLOB storage mounted as a path.
  The default is `/home/ubuntu,/mnt,/media,/srv`.
- A request to `POST /api/v1/cases/:caseId/imports/path` supplies an absolute path. The
  server resolves the **real** path (`fs.realpathSync`, collapsing `..` and following
  symlinks) and requires it to sit inside one of the allowed roots; anything resolving
  outside is rejected. This prevents the server being steered into arbitrary reads.
- From there the path import reuses the identical walk / detect / ingest pipeline as the
  upload route.

So for a large matter, mount the customer's share, add its mount point to
`INGEST_ALLOWED_ROOTS`, and point `imports/path` at the staged package. No special
arrangement beyond that.

---

## Q4 — Is the 512 MB / 2,000-file per-request cap application-level, or purely nginx? Does it bind on-prem?

Split into the two figures, because they are different:

**The 512 MB byte figure is _not_ application-level.** The HTTP import path streams
uploads to disk (multer `diskStorage`). The application sets a per-file byte cap **only**
when `MAX_UPLOAD_BYTES > 0`; the default is `0`, meaning **no application byte cap** —
available disk space is the real limit (`src/config.ts`, `src/routes/imports.ts`). The
"512 MB" is therefore the **shared demo environment's nginx edge limit**, and it does
**not** bind on-prem: as your note observed, the 1.1.0 on-prem nginx template already
ships `client_max_body_size 64g` with 3600s timeouts. On a 1.1.0 on-prem install the
documented 512 MB cap does not apply.

**The 2,000-file figure _was_ application-level, and is now configurable.** The per-
request **file-count** cap is enforced by the application in both multer branches and so
applied everywhere, including on-prem. As of 1.1.0 it is driven by config:
`config.maxUploadFiles`, env var **`MAX_UPLOAD_FILES`**, default **2,000**. Raise it when
a single legitimate chunk carries more files than the default (e.g. a large `images/`
set). When the cap is exceeded the request is rejected cleanly with **HTTP 413** and a
machine-readable body (`code: "LIMIT_FILE_COUNT"`, `limit: <configured value>`) so a
chunking client can detect "chunk too large" and split further, rather than receiving an
opaque error.

**Consequence for your implementation note:** on a 1.1.0 on-prem install, a legitimately
large **single** chunk is bounded only by the file count (raise `MAX_UPLOAD_FILES`) and
by disk — the 512 MB cap is not in force. Chunking there is therefore **optional**,
exactly as your note anticipated: it remains valuable for the shared demo instance and
for any customer not yet on 1.1.0, and it is now safe and auditable (Q1) where you do
use it.

---

### Summary of the 1.1.0 platform-side change

- `MAX_UPLOAD_FILES` (default 2,000) makes the only application-level per-request cap
  configurable; over-cap requests return a clean `413` with `code`/`limit`.
- Cross-call / within-chunk control-number overlap is reported on the import row note,
  the status endpoint and the audit log, instead of silently overwriting.
- No schema change, no new processing capability — reporting and configuration only.
