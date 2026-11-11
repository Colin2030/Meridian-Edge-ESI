# Remontoire Field Mapping Reference

This reference maps each Remontoire delivery feature to its **batch manifest field**
(used by `POST /api/v1/cases/{caseId}/batches/{batchId}/items`) and the equivalent
**load-file column** (used by the DAT/OPT load-file import path), together with the
required value format and a concrete example.

All values use UK English conventions in prose. Machine values follow the formats
below exactly.

> Scope note. Meridian Edge is a view-only review platform. All text, natives and
> review images described here are **pre-processed by the integration pipeline** and
> supplied ready to display. The platform never extracts, OCRs or renders text from
> source evidence itself.

---

## 1. Value formats (normative)

| Format | Rule | Example |
| --- | --- | --- |
| Language code | BCP 47, lower-cased on ingest. Unknown/absent defaults to `und`. | `en`, `fr`, `de`, `und` |
| Date/time | ISO 8601, normalised to UTC (`isoDateUtc`). Unparseable values are stored as `null` while the original is preserved in metadata. | `2021-03-04T09:30:00Z` |
| Content hash | SHA-256, lower-case hex, 64 chars. Used for dedup and integrity. | `9f86d0818...` (64 hex) |
| MIME type | IANA media type. Natives are content-confirmed; a declared hint never forces an image type. | `message/rfc822`, `application/pdf` |
| Control number | Non-empty string, trimmed. Unique per case (upsert key). | `POD-00001` |

---

## 2. Text and translations (requests 2 & 5)

Each item carries a `text[]` array. The **first** entry with `kind: "extracted"`
becomes the original (`isOriginal = true`); all entries are full-text indexed per
language.

### Batch manifest (`text[]` entry)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` / `inline` / `content` / `text` | string | one of these | `part` references a multipart file part; the others carry text inline. |
| `language` | string (BCP 47) | no | Lower-cased; defaults to `und`. |
| `kind` | `extracted` \| `translation` \| `ocr` | no | Defaults to `extracted`. |
| `translatedFrom` | string (BCP 47) | no | Source language for a translation. |
| `method` | `machine` \| `human` | no | Translation method. |

Text parts are decoded as UTF-8 (with or without BOM) or UTF-16 LE/BE (by BOM);
newlines are normalised to `\n`. Empty text is skipped; an item with no usable text
raises a non-fatal `text_missing` failure.

### Load-file column equivalents

| Feature | Load-file column | Maps to |
| --- | --- | --- |
| Extracted text | `TEXTPATH` | `text[]` entry, `kind: extracted` |
| Translated text | `TRANSLATEDTEXTPATH` | `text[]` entry, `kind: translation` |
| Translation source | `TRANSLATEDFROM` | `translatedFrom` |

### Example (manifest)

```json
"text": [
  { "part": "t1", "language": "en", "kind": "extracted" },
  { "part": "t2", "language": "fr", "kind": "translation",
    "translatedFrom": "en", "method": "machine" }
]
```

Indexed result: `document_text` rows `(en, extracted)` and `(fr, translation)`,
each FTS-indexed with `to_tsvector('simple', …)`; the case-level
`documents.search_tsv` combines English metadata (weight A) with all text (weight B).

---

## 3. Natives (request 3)

A single native file per item, declared with its intended type. The stored MIME is
resolved from the declared hint, confirmed against content, and is **never** coerced
to an image format.

### Batch manifest (`native`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` | string | yes | Multipart file part name. Missing → `missing_part`. |
| `fileName` | string | no | Original file name. |
| `mimeType` | string (MIME) | no | Declared hint; content-confirmed on store. |
| `sha256` | string (hex-64) | no | Expected hash; mismatch → `hash_mismatch` (nothing stored). |

### Load-file column equivalents

| Feature | Load-file column | Maps to |
| --- | --- | --- |
| Native path | `NATIVEPATH` | `native.part` |
| File/MIME type | `FILETYPE` / `MIMETYPE` | `native.mimeType` |

### Example (manifest)

```json
"native": { "part": "n1", "fileName": "message.eml",
            "mimeType": "message/rfc822" }
```

Stored fields: `native_filename`, `native_storage_name`, `native_mime`,
`native_sha256`. The content-addressed blob is deduplicated by SHA-256.

---

## 4. Review images — PDF / TIFF (request 4)

Each item may carry one review image (a produced PDF or TIFF) that the platform
renders to page PNGs **on commit**. Only `pdf` and `tiff` are accepted; any other
value raises `unsupported_image_format`.

### Batch manifest (`image`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `part` | string | yes | Multipart file part name. |
| `format` | `pdf` \| `tiff` | yes | Any other value → `unsupported_image_format`. |
| `pageCount` | integer | no | Expected pages. |
| `sha256` | string (hex-64) | no | Expected hash. |

### Load-file column equivalents

| Feature | Load-file column | Maps to |
| --- | --- | --- |
| Image path | `PDFPATH` / `IMAGEPATH` | `image.part` |
| Image format | `FILETYPE` (pdf/tiff) | `image.format` |

### Example (manifest)

```json
"image": { "part": "i1", "format": "pdf", "pageCount": 3 }
```

Stored fields: `image_sha256`, `image_format`, `image_page_count`. On commit the
`rendering` phase produces page PNGs (`pdftoppm -png -r 120` for PDF,
`convert -density 120` for TIFF). The item's `native_type` (viewer render kind)
becomes `pdf` or `tiff` when an image is present.

---

## 5. Conversation threading (request 6)

### Batch manifest (`thread`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `threadId` | string | no | Present value increments `threads_populated`. |
| `position` | integer | no | Position within the thread. |
| `size` | integer | no | Total messages in the thread. |
| `subject` | string | no | Thread subject. |

### Load-file column equivalents

| Feature | Load-file column | Maps to |
| --- | --- | --- |
| Thread id | `THREADID` | `thread.threadId` |
| Position | `THREADPOSITION` | `thread.position` |
| Size | `THREADSIZE` | `thread.size` |

### Example (manifest)

```json
"thread": { "threadId": "TH-42", "position": 2, "size": 3,
            "subject": "Joel's Memo" }
```

Stored fields: `thread_id`, `thread_position`, `thread_size`, `thread_subject`.

---

## 6. Families by parent ID (request 7)

Family relationships are declared by referencing the **parent's control number**.
Parents are resolved on commit (`linking` phase) by `(case_id, control_number)`; an
unresolved reference raises a non-fatal `parent_not_found` failure and an
`import_failures` row.

### Batch manifest (item-level)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `parentControlNumber` | string | no | Control number of the family parent. |

Also available at item level: `messageId`, `inReplyTo` (email threading hints),
`processedBy`.

### Load-file column equivalents

| Feature | Load-file column | Maps to |
| --- | --- | --- |
| Parent id | `PARENTID` | `parentControlNumber` |
| Family range | `BEGATTACH` / `ENDATTACH` | derived family grouping |
| Message id | `MESSAGEID` | `messageId` |
| In-reply-to | `INREPLYTO` | `inReplyTo` |

### Example (manifest)

```json
{ "controlNumber": "POD-00002", "parentControlNumber": "POD-00001" }
```

On commit, `families_linked` counts successfully linked children.

---

## 7. Metadata and the field-mapping option (request 1 / 9)

Arbitrary item metadata is supplied as a JSON object under `metadata`. For the
load-file path, a `field_mapping` object renames incoming columns to canonical
field names.

### Batch manifest (`metadata`)

```json
"metadata": {
  "FROM": "joel@example.com",
  "TO": "team@example.com",
  "SUBJECT": "Joel's Memo",
  "DATESENT": "2021-03-04T09:30:00Z"
}
```

### Load-file field mapping

A `field_mapping` maps load-file column names to canonical fields:

```json
{ "DATESENT": "date", "THREADID": "thread_id" }
```

> For structured batch items, `unmapped_columns` is always `[]` in the verification
> block — a JSON manifest has no stray columns. The field is present for parity with
> the load-file path, where unmapped columns are reported.

---

## 8. Audit entries and attached reports (request 8)

Case audit entries record pipeline events and may carry attached reports. Entries
are **append-only** (no update or delete).

### Request body fields (`POST /cases/{caseId}/audit-entries`)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `eventType` | string | yes | e.g. `remontoire.pipeline.completed`. Missing → `bad_request`. |
| `occurredAt` | string (ISO 8601 UTC) | no | When the event occurred. |
| `summary` | string | no | Human-readable summary. |
| `source` | object `{system, version, runId}` | no | Originating system. |
| `importId` | string | no | Related import. |
| `batchId` | string | no | Related batch. |

Attachments (multipart): allowed extensions `.pdf`, `.html`, `.htm`, `.json`, `.csv`
(validated by both extension and declared MIME). Limits: 50 files, 512 MiB each. A
disallowed type raises `unsupported_attachment_type` and rejects the whole entry.

### Example event types

- `remontoire.scan.completed`
- `remontoire.extraction.completed`
- `remontoire.pipeline.completed`

---

## 9. Integrity and dedup summary

| Mechanism | Field | Behaviour |
| --- | --- | --- |
| Content addressing | `sha256` | Blobs stored at `<blobsDir>/aa/bb/<sha256>`; identical content deduplicated (ref-counted). |
| Pre-check | `HEAD /api/v1/blobs/{sha256}` | `200` if already held, `404` if not — skip re-upload. |
| Hash verification | `sha256` on `native`/`image` | Mismatch → `hash_mismatch`; nothing is stored. |
| Idempotency | `controlNumber` | Documents upsert `ON CONFLICT (case_id, control_number)`. |
