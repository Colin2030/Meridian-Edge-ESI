# Remontoire Reference Package & Expected Result

This reference package is a small, self-contained delivery that exercises every
Remontoire feature. An integrating agent can submit it against a fresh case and
assert the exact records and verification counts the platform should produce.

> View-only reminder. Every text, native and review image below is supplied
> pre-processed by the pipeline. The platform stores, indexes and renders what is
> delivered; it performs no extraction of its own.

---

## 1. What the package exercises

| Feature | Covered by |
| --- | --- |
| Plain extracted text | POD-00001, POD-00003, POD-00010 … |
| A translation (en→fr) | POD-00001 |
| A thread of three | POD-00004, POD-00005, POD-00006 (thread `TH-100`) |
| A family with an attachment | POD-00007 (parent) + POD-00008 (child) |
| A native file | POD-00001 (`message.eml`), POD-00007 |
| A PDF review image | POD-00001 (3 pages) |
| A TIFF review image | POD-00009 (2 pages) |

The package contains **12 items** (POD-00001 … POD-00012).

---

## 2. Delivery sequence

1. `POST /api/v1/cases` → obtain `caseId`.
2. `POST /api/v1/cases/{caseId}/batches` with the expected totals
   (`expectedItems: 12`).
3. (Optional) `HEAD /api/v1/blobs/{sha256}` for each native/image to skip
   already-held blobs.
4. `POST /api/v1/cases/{caseId}/batches/{batchId}/items` — one or more multipart
   requests carrying the manifest (field `items`) plus the referenced parts.
5. `POST /api/v1/cases/{caseId}/batches/{batchId}/commit` → `202`.
6. Poll `GET …/batches/{batchId}` (or stream `…/events`) until a terminal state.
7. `POST /api/v1/cases/{caseId}/audit-entries` to attach the pipeline report.

---

## 3. Manifest (inline)

```json
{
  "items": [
    {
      "controlNumber": "POD-00001",
      "metadata": { "FROM": "joel@example.com", "TO": "team@example.com",
                    "SUBJECT": "Joel's Memo", "DATESENT": "2021-03-04T09:30:00Z" },
      "text": [
        { "part": "t1", "language": "en", "kind": "extracted" },
        { "part": "t2", "language": "fr", "kind": "translation",
          "translatedFrom": "en", "method": "machine" }
      ],
      "native": { "part": "n1", "fileName": "message.eml", "mimeType": "message/rfc822" },
      "image": { "part": "i1", "format": "pdf", "pageCount": 3 },
      "thread": { "threadId": "TH-100", "position": 1, "size": 3, "subject": "Joel's Memo" }
    },
    { "controlNumber": "POD-00002",
      "metadata": { "SUBJECT": "Cover note" },
      "text": [ { "inline": "Short cover note.", "language": "en" } ] },
    { "controlNumber": "POD-00003",
      "metadata": { "SUBJECT": "Spreadsheet summary" },
      "text": [ { "part": "t3", "language": "en", "kind": "extracted" } ] },

    { "controlNumber": "POD-00004",
      "metadata": { "SUBJECT": "Re: Joel's Memo (1)" },
      "text": [ { "inline": "First reply.", "language": "en" } ],
      "thread": { "threadId": "TH-100", "position": 2, "size": 3, "subject": "Joel's Memo" },
      "messageId": "<m4@example.com>", "inReplyTo": "<m1@example.com>" },
    { "controlNumber": "POD-00005",
      "metadata": { "SUBJECT": "Re: Joel's Memo (2)" },
      "text": [ { "inline": "Second reply.", "language": "en" } ],
      "thread": { "threadId": "TH-100", "position": 3, "size": 3, "subject": "Joel's Memo" },
      "messageId": "<m5@example.com>", "inReplyTo": "<m4@example.com>" },
    { "controlNumber": "POD-00006",
      "metadata": { "SUBJECT": "Thread index" },
      "text": [ { "inline": "Thread of three.", "language": "en" } ] },

    { "controlNumber": "POD-00007",
      "metadata": { "SUBJECT": "Contract bundle" },
      "text": [ { "part": "t7", "language": "en", "kind": "extracted" } ],
      "native": { "part": "n7", "fileName": "contract.pdf", "mimeType": "application/pdf" } },
    { "controlNumber": "POD-00008",
      "parentControlNumber": "POD-00007",
      "metadata": { "SUBJECT": "Appendix A" },
      "text": [ { "inline": "Attachment to the contract bundle.", "language": "en" } ] },

    { "controlNumber": "POD-00009",
      "metadata": { "SUBJECT": "Scanned exhibit" },
      "text": [ { "inline": "Exhibit text.", "language": "en" } ],
      "image": { "part": "i9", "format": "tiff", "pageCount": 2 } },
    { "controlNumber": "POD-00010",
      "metadata": { "SUBJECT": "Memo B" },
      "text": [ { "part": "t10", "language": "de", "kind": "extracted" } ] },
    { "controlNumber": "POD-00011",
      "metadata": { "SUBJECT": "Memo C" },
      "text": [ { "inline": "English memo C.", "language": "en" } ] },
    { "controlNumber": "POD-00012",
      "metadata": { "SUBJECT": "Memo D" },
      "text": [ { "inline": "English memo D.", "language": "en" } ] }
  ]
}
```

File parts referenced above (`t1, t2, t3, t7, t10`, `n1, n7`, `i1, i9`) are sent as
multipart parts named exactly by their `part` value.

---

## 4. Expected document records

| Control # | Text rows (lang/kind) | Native | Image | Thread | Parent | `native_type` |
| --- | --- | --- | --- | --- | --- | --- |
| POD-00001 | en/extracted, fr/translation | message.eml | pdf (3 pp) | TH-100 pos 1/3 | — | `pdf` |
| POD-00002 | en/extracted | — | — | — | — | `none` |
| POD-00003 | en/extracted | — | — | — | — | `none` |
| POD-00004 | en/extracted | — | — | TH-100 pos 2/3 | — | `none` |
| POD-00005 | en/extracted | — | — | TH-100 pos 3/3 | — | `none` |
| POD-00006 | en/extracted | — | — | — | — | `none` |
| POD-00007 | en/extracted | contract.pdf | — | — | — | `native` |
| POD-00008 | en/extracted | — | — | — | POD-00007 | `none` |
| POD-00009 | en/extracted | — | tiff (2 pp) | — | — | `tiff` |
| POD-00010 | de/extracted | — | — | — | — | `none` |
| POD-00011 | en/extracted | — | — | — | — | `none` |
| POD-00012 | en/extracted | — | — | — | — | `none` |

Notes:
- Every inline `text` entry defaults to `kind: extracted`; the first extracted entry
  per item is the original (`isOriginal = true`).
- `native_type` is the viewer render kind: `pdf`/`tiff` when a review image is
  present, else `native` when only a native is present, else `none`.

---

## 5. Expected verification counts

| Count | Value | Why |
| --- | --- | --- |
| `items_received` | 12 | All items in the manifest. |
| `items_created` | 12 | Fresh case; all new. |
| `items_updated` | 0 | No pre-existing control numbers. |
| `text_indexed` | `{ "en": 11, "fr": 1, "de": 1 }` | Per-language document_text rows. |
| `text_missing` | 0 | Every item carries usable text. |
| `natives_stored` | 2 | POD-00001, POD-00007. |
| `images_stored` | 2 | POD-00001 (pdf), POD-00009 (tiff). |
| `pages` | 5 | 3 (POD-00001) + 2 (POD-00009). |
| `threads_populated` | 3 | POD-00001, POD-00004, POD-00005 (threadId present). |
| `families_linked` | 1 | POD-00008 → POD-00007. |
| `unmapped_columns` | `[]` | Structured manifest has no stray columns. |
| `failures` | `[]` | Clean package. |

End state: **`completed`** (no failures).

---

## 6. Negative variants (optional assertions)

To exercise error handling, swap in these single-item variants and assert the
failure code (all non-fatal unless noted):

| Variant | Change | Expected `code` |
| --- | --- | --- |
| Missing control number | omit `controlNumber` | `missing_control_number` |
| Missing part | `native.part` references a part not sent | `missing_part` |
| Hash mismatch | wrong `native.sha256` | `hash_mismatch` (nothing stored) |
| No usable text | empty/absent `text` | `text_missing` |
| Unknown parent | `parentControlNumber` not in case | `parent_not_found` |
| Bad image format | `image.format: "jpeg"` | `unsupported_image_format` |

An item that raises only non-fatal failures still commits; the batch end state
becomes `completed_with_failures` when any failure is present.
