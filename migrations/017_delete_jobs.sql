-- 017_delete_jobs.sql — async job records for large delete operations.
-- Phase 3 of the v1.4.0 "Remontoire delivery" epic (delete/archive endpoints).
--
-- A DELETE of a large case/import returns 202 Accepted with a job id the client
-- polls (request 10, mirroring how large imports/batches run asynchronously).
-- Small deletes complete synchronously and never create a job row. This table is
-- the durable record of an async soft-delete job's progress and outcome.
--
-- Additive, backward-compatible and idempotent (safe to re-run; never drops).

CREATE TABLE IF NOT EXISTS delete_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  -- What is being deleted: 'case' | 'import' | 'batch' | 'document'.
  kind          TEXT NOT NULL,
  -- Identifier of the target (import id, batch id, control number) for tracing.
  target        TEXT,
  status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','completed','failed')),
  -- Progress: documents soft-deleted so far / total to delete.
  docs_total    INTEGER NOT NULL DEFAULT 0,
  docs_done     INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delete_jobs_case ON delete_jobs(case_id, created_at);
