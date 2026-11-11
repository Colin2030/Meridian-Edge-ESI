-- 016_archive_retention.sql — case archive + soft-delete / retention columns.
-- Phase 1 of the v1.4.0 "Remontoire delivery" epic (schema foundation).
--
-- The delete/archive ENDPOINTS and the restore flow are built in Phase 3; this
-- migration lays the durable columns so a short retention window (e.g. 7 days)
-- with a restore path can be implemented without a later schema change (request 10).
--
--   deleted_at     — when the row was soft-deleted (NULL = live). A background
--                    sweep removes rows whose retention_until has passed.
--   retention_until— hard-delete deadline; until then a restore is possible.
--   archived_at    — when a case was archived (hidden from active lists, nothing
--                    removed). Archive uses PATCH status='archived'.
--   restored_at / restored_by — restore bookkeeping.
--
-- The cases.status column is free text (no CHECK constraint), so 'archived' is
-- already a permitted value; no constraint change is needed.
--
-- Additive, backward-compatible and idempotent (safe to re-run; never drops).

-- Cases: archive + soft-delete + restore.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS archived_at     TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS restored_at     TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS restored_by     INTEGER REFERENCES users(id);

-- Documents: soft-delete + retention (single-item delete / import rollback).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;

-- Imports: soft-delete + retention (import rollback).
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;

-- Fast filtering of live (non-deleted) rows.
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(case_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_cases_deleted     ON cases(deleted_at);
