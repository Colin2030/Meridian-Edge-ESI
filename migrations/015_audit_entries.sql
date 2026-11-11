-- 015_audit_entries.sql — case audit entries with attached reports (append-only).
-- Phase 1 of the v1.4.0 "Remontoire delivery" epic (schema foundation).
--
-- An integration (e.g. Remontoire) writes entries into a case's history, each
-- carrying one or more report files, at the end of each pipeline stage (request 8).
-- Entries and attachments are APPEND-ONLY — they may be added but never edited or
-- removed, in keeping with an audit trail. The API ENDPOINTS are built in a later
-- phase; this migration lays the durable schema.
--
-- NOTE: this is SEPARATE from the existing operational audit_log table (which
-- records platform actions like import.started / import.completed). audit_entries
-- are integrator-posted, stage-level records that carry attached report files.
--
-- Additive, backward-compatible and idempotent (safe to re-run; never drops).

CREATE TABLE IF NOT EXISTS audit_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  -- Event type, e.g. 'remontoire.scan.completed', 'remontoire.pipeline.completed'.
  event_type     TEXT NOT NULL,
  -- When the stage finished (may differ from when the entry was posted).
  occurred_at    TIMESTAMPTZ,
  summary        TEXT,
  -- Source of the entry (manifest `source`).
  source_system  TEXT,
  source_version TEXT,
  source_run_id  TEXT,
  -- Optional links to the documents the entry describes.
  import_id      INTEGER REFERENCES loadfile_imports(id) ON DELETE SET NULL,
  batch_id       UUID REFERENCES batches(id) ON DELETE SET NULL,
  -- Who posted it and when (recorded by the platform).
  posted_by      INTEGER REFERENCES users(id),
  posted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entries_case ON audit_entries(case_id, posted_at);

CREATE TABLE IF NOT EXISTS audit_entry_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    UUID NOT NULL REFERENCES audit_entries(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT,
  -- Report file content stored in the blob store, verified by hash.
  blob_sha256 TEXT REFERENCES blobs(sha256),
  byte_size   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_entry_attachments_entry ON audit_entry_attachments(entry_id);
