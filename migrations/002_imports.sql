-- 002_imports.sql — progress/status tracking for the in-app "Add Case Data" upload feature.
-- Idempotent: safe to re-run.

ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS page_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS phase          TEXT;              -- pending|parsing|rendering|completed|failed
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS docs_total     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS docs_done      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS pages_done     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS source_kind    TEXT;              -- zip|files
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS error          TEXT;
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS original_files JSONB;

CREATE INDEX IF NOT EXISTS idx_loadfile_imports_case ON loadfile_imports (case_id, imported_at DESC);
