# Meridian Edge — Programmatic REST API (v1)

This guide describes the token-authenticated REST API that lets an external
integration feed **pre-processed ESI loadfile packages** into Meridian Edge and
query case and document state programmatically.

> **Scope.** Meridian Edge is a *view-only* review platform for ESI that has
> **already** been processed into a Concordance loadfile package (`.DAT` / `.OPT`
> plus TIFF/PDF images). This API exposes the platform's existing loadfile ingest
> over HTTP — it performs **no** OCR, rendering, de-duplication, or forensic
> processing of its own. You must supply packages that are already in the format
> described under [Loadfile package format](#loadfile-package-format).

---

## Contents

1. [Overview](#overview)
2. [Base URLs](#base-urls)
3. [Authentication](#authentication)
4. [Managing API tokens](#managing-api-tokens)
5. [Loadfile package format](#loadfile-package-format)
6. [Endpoint reference](#endpoint-reference)
   - [GET /me](#get-apiv1me)
   - [GET /cases](#get-apiv1cases)
   - [POST /cases](#post-apiv1cases)
   - [POST /cases/:caseId/imports](#post-apiv1casescaseidimports)
   - [POST /cases/:caseId/imports/path](#post-apiv1casescaseidimportspath)
   - [GET /cases/:caseId/imports/:importId](#get-apiv1casescaseidimportsimportid)
   - [GET /cases/:caseId/documents](#get-apiv1casescaseiddocuments)
7. [Complete worked example](#complete-worked-example)
8. [Error responses](#error-responses)
9. [Notes and operational guidance](#notes-and-operational-guidance)

---

## Overview

The API is versioned under `/api/v1`. It mirrors the role-based access controls
of the browser application exactly: a token acts **as a specific user**, and
every request is subject to the same per-case permissions that user has in the
web interface. The typical integration flow is:

1. Obtain an API token (issued by a system administrator — see
   [Managing API tokens](#managing-api-tokens)).
2. Confirm the token with `GET /api/v1/me`.
3. Create a case (or use an existing one you have access to).
4. Upload a pre-processed loadfile package with
   `POST /api/v1/cases/:caseId/imports` (or ingest from a server-reachable path).
5. Poll `GET /api/v1/cases/:caseId/imports/:importId` until the import reports
   `completed`.
6. List the resulting documents with `GET /api/v1/cases/:caseId/documents`.

All request and response bodies are JSON, except file uploads, which use
`multipart/form-data`. All timestamps are ISO 8601 (UTC).

---

## Base URLs

| Environment | Base URL |
|-------------|----------|
| Primary (branded) | `https://esireview.meridianedge.co.uk/api/v1` |
| Platform (native) | `https://meridian-edge.abacusai.cloud/api/v1` |

Both hosts serve the identical API. Use whichever your network can reach; the
examples below use the branded host.

---

## Authentication

Every `/api/v1` endpoint requires an **API token** supplied as a Bearer token in
the `Authorization` header:

```
Authorization: Bearer me_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

- Tokens begin with the prefix `me_live_` followed by a high-entropy random
  string.
- The API uses **only** Bearer tokens — session cookies are not accepted on
  `/api/v1`. (Conversely, the browser application uses cookies and does not accept
  Bearer tokens.)
- A token carries the identity and permissions of the user it was issued for.
  Requests are authorised exactly as if that user were signed in.
- Tokens are **secrets**. Store them in your integration's secret store, never in
  source control. If a token is exposed, revoke it immediately (see below).

A quick check that a token is valid:

```bash
curl -s https://esireview.meridianedge.co.uk/api/v1/me \
  -H "Authorization: Bearer $MERIDIAN_TOKEN"
```

---

## Managing API tokens

API tokens are created and revoked by a **system administrator** from the
Meridian Edge web application: **Admin → API tokens**. When creating a token the
administrator chooses the owning user (the token then acts as that user) and a
descriptive name.

> **The raw token is shown only once**, at the moment of creation. Copy it
> immediately into your secret store — it cannot be retrieved afterwards. Meridian
> Edge stores only a SHA-256 hash of the token plus a short non-secret prefix for
> identification, so a lost token must be revoked and replaced.

Administrators (and the owning user) can also manage tokens over the
cookie-authenticated management API (`/api/tokens`), which is used by the web UI:

| Method & path | Description |
|---------------|-------------|
| `POST /api/tokens` | Create a token. Body: `{ "name": "...", "userId": <optional> }`. Only a system administrator may set `userId` (to issue a token for another user); otherwise the token is issued for the caller. Returns the raw token **once**. |
| `GET /api/tokens` | List tokens (owner sees their own; a system administrator sees all, or filter with `?userId=`). Never returns the raw token or its hash. |
| `DELETE /api/tokens/:id` | Revoke a token. Idempotent. |

> These management endpoints use the browser session (cookie) and are **not** part
> of the `/api/v1` surface. Your integration uses the issued token against
> `/api/v1`; it does not need the management endpoints.

Token lifecycle events (`token.created`, `token.revoked`) are written to the
audit log.

---

## Loadfile package format

The ingest accepts an **already-processed** Concordance-style loadfile package.
A package consists of a metadata file, an image cross-reference file, and the
image/native files they reference.

### `.DAT` — document metadata (Concordance)

A delimited text file with a header row followed by one row per document.
Meridian Edge auto-detects the delimiters:

| Style | Field delimiter | Text qualifier | Multi-value |
|-------|-----------------|----------------|-------------|
| **Concordance** (preferred) | ASCII 20 (`\u0014`, shown as `¶`) | ASCII 254 (`\u00FE`, shown as `þ`) | `;` |
| CSV (fallback) | `,` | `"` | `;` |
| TSV (fallback) | tab | `"` | `;` |

Field names are matched case-insensitively (ignoring spaces, underscores and
hyphens) against these aliases:

| Normalised field | Recognised header aliases |
|------------------|---------------------------|
| `control_number` | `DOCID`, `BEGDOC`, `BEG_DOC`, `BATESBEG`, `CONTROLNUMBER`, `CONTROL NUMBER`, `BEGBATES`, `PRODBEG` |
| `beg_attach` | `BEGATTACH`, `ATTACHBEG` |
| `end_attach` | `ENDATTACH`, `ATTACHEND` |
| `text_path` | `TEXTPATH`, `OCRPATH`, `EXTRACTEDTEXT`, `TEXT`, `OCR` |
| `native_path` | `NATIVEPATH`, `NATIVELINK`, `NATIVE`, `FILEPATH` |
| `date` | `DATE`, `DATESENT`, `DOCDATE`, `DATE_CREATED` |
| `from` | `FROM`, `AUTHOR`, `SENDER` |
| `to` | `TO`, `RECIPIENT`, `RECIPIENTS` |
| `subject` | `SUBJECT`, `TITLE`, `RE` |
| `filename` | `FILENAME`, `FILE_NAME`, `FILE` |

`control_number` is required to identify each document. Extracted/OCR text, when
referenced via a `text_path`-family field (or supplied inline), is indexed so the
document becomes full-text searchable. All other columns are preserved verbatim
as the document's metadata and returned on the documents endpoint.

### `.OPT` — image cross-reference (Opticon)

One comma-separated row **per page**, with columns:

```
ImageKey,Volume,FullPath,DocBreak,FolderBreak,BoxBreak,PageCount
```

- `DocBreak = Y` marks the **first page of a new document**; subsequent rows
  (blank/`N` DocBreak) belong to that same document. This is how pages are grouped
  into documents.
- `FullPath` points to the page image within the package.

### Images / natives

- **Single-page TIFF** (CCITT Group 4) — one file per page, referenced by the
  `.OPT` rows.
- **Multi-page PDF** — a single PDF whose pages map to the document's pages.

> **Image filename uniqueness.** Image file **names** must be unique across the
> whole package (the ingest flattens images into one working set). If two images
> share a filename, the later one is reported as a *collision* and skipped. Keep
> Bates-stamped, unique filenames.

### Packaging

Submit the package either as:

- a single **`.zip`** containing the `.DAT`, `.OPT` and image files (the ingest
  expands it, then locates the first `.DAT` and `.OPT`), or
- the individual files (`.dat`, `.opt`, `.tif`/`.tiff`, `.pdf`) as separate
  multipart parts, or
- a server-reachable **folder path** (see
  [`POST .../imports/path`](#post-apiv1casescaseidimportspath)).

A complete, valid sample package is shipped with the platform at
`/home/ubuntu/esi-testset/Operation_Kingfisher_ESI_Loadfile.zip`
(14 documents / 21 pages).

---

## Endpoint reference

All paths below are relative to a [base URL](#base-urls) and require the
`Authorization: Bearer <token>` header.

Role requirements use the per-case role hierarchy:
`read_only (1) < reviewer (2) < case_manager (3) < system_admin (4)`.

---

### `GET /api/v1/me`

Returns the identity the token acts as. Useful as a health/validation check.

**Auth:** any valid token.

```bash
curl -s https://esireview.meridianedge.co.uk/api/v1/me \
  -H "Authorization: Bearer $MERIDIAN_TOKEN"
```

```json
{
  "id": 2,
  "username": "manager",
  "isSystemAdmin": false
}
```

---

### `GET /api/v1/cases`

Lists the cases the token owner can access (a system administrator sees all
cases). Each entry includes the owner's role on that case and summary counts.

**Auth:** any valid token.

```bash
curl -s https://esireview.meridianedge.co.uk/api/v1/cases \
  -H "Authorization: Bearer $MERIDIAN_TOKEN"
```

```json
[
  {
    "id": 11,
    "name": "Operation Kingfisher",
    "case_number": "KF-2026-01",
    "description": "Procurement fraud review",
    "status": "open",
    "created_at": "2026-11-04T14:55:36.420Z",
    "doc_count": 14,
    "reviewed_count": 0,
    "bookmark_count": 0,
    "role": "case_manager"
  }
]
```

---

### `POST /api/v1/cases`

Creates a case. The token owner is automatically made a `case_manager` of the new
case.

**Auth:** the token owner must have the global *create cases* permission
(`can_create_cases`), or be a system administrator; otherwise `403`.

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | Case name. |
| `caseNumber` | string | no | Your reference / matter number. |
| `description` | string | no | Free text. |

```bash
curl -s -X POST https://esireview.meridianedge.co.uk/api/v1/cases \
  -H "Authorization: Bearer $MERIDIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Operation Kingfisher","caseNumber":"KF-2026-01","description":"Procurement fraud review"}'
```

**`201 Created`:**

```json
{
  "id": 11,
  "name": "Operation Kingfisher",
  "case_number": "KF-2026-01",
  "description": "Procurement fraud review",
  "status": "open",
  "created_by": 2,
  "created_at": "2026-11-04T14:55:36.420Z"
}
```

---

### `POST /api/v1/cases/:caseId/imports`

Uploads a pre-processed loadfile package (as `multipart/form-data`) and starts an
**asynchronous** ingest. Returns immediately with `202 Accepted` and an
`importId`; poll the status endpoint for progress.

**Auth:** `case_manager` or above on `:caseId`.

**Form fields:**

| Field | Type | Notes |
|-------|------|-------|
| `file` | file | One or more files. A single `.zip`, or the individual `.dat`/`.opt`/`.tif`/`.pdf` parts. Repeat the field for multiple files. |
| `name` | text | Optional import label (defaults to the `.DAT` filename). |

```bash
curl -s -X POST \
  https://esireview.meridianedge.co.uk/api/v1/cases/11/imports \
  -H "Authorization: Bearer $MERIDIAN_TOKEN" \
  -F file=@Operation_Kingfisher_ESI_Loadfile.zip
```

**`202 Accepted`:**

```json
{
  "importId": 10,
  "status": "pending",
  "datFile": "OperationKingfisher.DAT",
  "optFile": "OperationKingfisher.OPT",
  "imageCount": 17,
  "collisions": []
}
```

- `imageCount` — images staged for ingest.
- `collisions` — image filenames skipped because the name was already used (see
  [image filename uniqueness](#images--natives)).

---

### `POST /api/v1/cases/:caseId/imports/path`

Ingests a package from a **server-reachable folder path** instead of uploading it
— for large packages already staged on a mounted share (SMB/NFS) or storage
mount. Same asynchronous behaviour and status lifecycle as the upload route.

**Auth:** `case_manager` or above on `:caseId`.

**Body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `path` | string | yes | Absolute path on the Meridian Edge server, within a configured ingest root. |
| `name` | string | no | Optional import label. |

```bash
curl -s -X POST \
  https://esireview.meridianedge.co.uk/api/v1/cases/11/imports/path \
  -H "Authorization: Bearer $MERIDIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"/mnt/esi-shares/operation-kingfisher"}'
```

**`202 Accepted`:**

```json
{
  "importId": 11,
  "status": "pending",
  "datFile": "OperationKingfisher.DAT",
  "optFile": "OperationKingfisher.OPT",
  "imageCount": 17,
  "collisions": [],
  "sourceKind": "path"
}
```

> The path must sit inside an administrator-configured ingest root
> (`INGEST_ALLOWED_ROOTS`). Paths outside those roots are rejected with `400`.

---

### `GET /api/v1/cases/:caseId/imports/:importId`

Returns the status of an import. Poll this until `status` is `completed` (or
`failed`).

**Auth:** `case_manager` or above on `:caseId`.

**Status lifecycle:** `pending` → (`phase`: `parsing` → `rendering`) →
`completed`, or `failed` on error.

```bash
curl -s \
  https://esireview.meridianedge.co.uk/api/v1/cases/11/imports/10 \
  -H "Authorization: Bearer $MERIDIAN_TOKEN"
```

**While running:**

```json
{
  "id": 10,
  "name": "OperationKingfisher.DAT",
  "dat_filename": "OperationKingfisher.DAT",
  "opt_filename": "OperationKingfisher.OPT",
  "status": "pending",
  "phase": "parsing",
  "docs_total": 14,
  "docs_done": 3,
  "pages_done": 4,
  "doc_count": null,
  "page_count": null,
  "error": null,
  "source_kind": "zip",
  "imported_at": null,
  "imported_by_name": "Alex Manager"
}
```

**When complete:**

```json
{
  "id": 10,
  "name": "OperationKingfisher.DAT",
  "dat_filename": "OperationKingfisher.DAT",
  "opt_filename": "OperationKingfisher.OPT",
  "status": "completed",
  "phase": "completed",
  "docs_total": 14,
  "docs_done": 14,
  "pages_done": 21,
  "doc_count": 14,
  "page_count": 21,
  "error": null,
  "source_kind": "zip",
  "imported_at": "2026-11-04T14:55:41.044Z",
  "imported_by_name": "Alex Manager"
}
```

On failure, `status` is `failed` and `error` holds a message.

---

### `GET /api/v1/cases/:caseId/documents`

Lists (and optionally searches/filters) the documents in a case. Results are
paginated.

**Auth:** `read_only` or above on `:caseId`.

**Query parameters (all optional):**

| Param | Description |
|-------|-------------|
| `q` | Search term. |
| `mode` | `fulltext` (default) or `pattern`. |
| `status` | Review status filter (e.g. `unreviewed`, `reviewed`). |
| `tagId` | Filter by tag id. |
| `dateFrom`, `dateTo` | Date range (document date). |
| `bookmarked` | `true` to return only bookmarked documents. |
| `sort`, `dir` | Sort column and direction (`asc`/`desc`). |
| `limit` | Page size, default `50`, maximum `200`. |
| `offset` | Pagination offset, default `0`. |

```bash
curl -s \
  "https://esireview.meridianedge.co.uk/api/v1/cases/11/documents?limit=200" \
  -H "Authorization: Bearer $MERIDIAN_TOKEN"
```

```json
{
  "total": 14,
  "limit": 200,
  "offset": 0,
  "mode": "fulltext",
  "documents": [
    {
      "id": 112,
      "control_number": "KF0000004",
      "native_type": "tiff",
      "page_count": 2,
      "has_text": true,
      "created_at": "2026-11-04T14:55:41.406Z",
      "metadata": {
        "DOCID": "KF0000004",
        "BEGBATES": "KF0000004",
        "ENDBATES": "KF0000005",
        "DOCTYPE": "Memo",
        "CUSTODIAN": "Daniel Hartley",
        "FROM": "Daniel Hartley",
        "SUBJECT": "Contract Award Justification FM/2026/07",
        "PAGECOUNT": "2"
      },
      "review_status": "unreviewed",
      "rank": 0,
      "bookmarked": false,
      "tags": []
    }
  ]
}
```

- `total` is the full count matching the query; `documents` is the current page.
- `metadata` preserves the original `.DAT` columns for each document.

---

## Complete worked example

An end-to-end Bash script: validate the token, create a case, upload a loadfile
ZIP, poll until the ingest completes, then list the resulting documents.

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="https://esireview.meridianedge.co.uk/api/v1"
TOKEN="me_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
PACKAGE="Operation_Kingfisher_ESI_Loadfile.zip"
AUTH=(-H "Authorization: Bearer ${TOKEN}")

# 1) Confirm the token
echo "Authenticated as:"
curl -s "${AUTH[@]}" "${BASE}/me"; echo

# 2) Create a case (requires the create-cases permission)
CASE_ID=$(curl -s "${AUTH[@]}" -H "Content-Type: application/json" \
  -X POST "${BASE}/cases" \
  -d '{"name":"Operation Kingfisher","caseNumber":"KF-2026-01"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
echo "Created case ${CASE_ID}"

# 3) Upload the pre-processed loadfile package
IMPORT_ID=$(curl -s "${AUTH[@]}" \
  -X POST "${BASE}/cases/${CASE_ID}/imports" \
  -F "file=@${PACKAGE}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["importId"])')
echo "Started import ${IMPORT_ID}"

# 4) Poll until completed (or failed)
while true; do
  BODY=$(curl -s "${AUTH[@]}" "${BASE}/cases/${CASE_ID}/imports/${IMPORT_ID}")
  STATUS=$(echo "${BODY}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
  echo "  import status: ${STATUS}"
  case "${STATUS}" in
    completed)
      echo "${BODY}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(f"  -> {d[\"doc_count\"]} docs / {d[\"page_count\"]} pages")'
      break ;;
    failed)
      echo "${BODY}" | python3 -c 'import sys,json;print("  ERROR:",json.load(sys.stdin)["error"])'
      exit 1 ;;
  esac
  sleep 2
done

# 5) List the resulting documents
curl -s "${AUTH[@]}" "${BASE}/cases/${CASE_ID}/documents?limit=200" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(f"{d[\"total\"]} documents:");[print(" ",x["control_number"],"-",x["page_count"],"page(s)") for x in d["documents"]]'
```

Running this against the sample package prints a `completed` import of
**14 documents / 21 pages** and then lists all 14 documents.

---

## Error responses

Errors return the appropriate HTTP status and a JSON body `{ "error": "..." }`.

| Status | When | Example body |
|--------|------|--------------|
| `401` | No `Authorization` header | `{"error":"Missing API token. Supply an Authorization: Bearer <token> header."}` |
| `401` | Unknown / malformed token | `{"error":"Invalid API token."}` |
| `401` | Revoked token | `{"error":"This API token has been revoked."}` |
| `403` | Owner account inactive | `{"error":"The account that owns this token is inactive."}` |
| `403` | No access to the case | `{"error":"No access to this case"}` |
| `403` | Case role too low (e.g. `read_only` attempting an import) | `{"error":"Insufficient permissions for this case"}` |
| `403` | No permission to create cases | `{"error":"You do not have permission to create cases"}` |
| `400` | `POST /cases` without a name | `{"error":"name required"}` |
| `400` | No files in the upload | `{"error":"No files were uploaded."}` |
| `400` | ZIP could not be read | `{"error":"Could not read the ZIP archive \"...\". Please check it is a valid .zip."}` |
| `400` | No `.DAT` found in the package | `{"error":"No .DAT loadfile found in the upload. A Concordance .DAT metadata file is required."}` |
| `400` | Path not absolute / not found / not readable | `{"error":"The path must be an absolute path (for example /mnt/esi-shares/operation-kingfisher)."}` |
| `400` | Path outside allowed ingest roots | `{"error":"That location is not within an allowed ingest root. Ask an administrator to add it to INGEST_ALLOWED_ROOTS."}` |
| `404` | Import id not found | `{"error":"Import not found"}` |

---

## Notes and operational guidance

- **Asynchronous ingest.** Imports return `202 Accepted` immediately and run in
  the background. Always poll `GET .../imports/:importId` until `status` is
  `completed` (or `failed`) rather than assuming the documents exist right after
  upload. The sample 14-document package completes in a couple of seconds; larger
  packages take proportionally longer.
- **No processing is performed.** The API ingests packages that are *already*
  processed. It does not OCR, render, or otherwise transform your ESI — supply
  images and extracted text in the package as described above.
- **Image filename uniqueness.** Image file names must be unique across the whole
  package. Duplicates are reported in `collisions` on the `202` response and are
  skipped.
- **Upload size.** The upload endpoint accepts large multipart payloads (up to
  512 MB and 2000 files per request). For very large packages already staged on
  the server, prefer the [path ingest](#post-apiv1casescaseidimportspath).
- **Long-lived connections.** The platform edge terminates idle connections after
  ~300s. Because ingest is asynchronous you never hold a long upload open waiting
  for processing — upload, then poll.
- **RBAC.** A token carries its owner's permissions. Importing requires
  `case_manager` on the case; reading documents requires `read_only` or above.
  System administrators have access to every case.
- **Auditing.** All actions are recorded in the Meridian Edge audit log, including
  token creation and revocation (`token.created`, `token.revoked`), case creation
  (`case_created`), and ingest lifecycle (`import.started`, `import.completed` /
  `import.failed`).
- **UK English and branding.** All platform-generated text uses UK English spelling.
