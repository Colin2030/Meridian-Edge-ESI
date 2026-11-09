-- 009_email_threading.sql — email conversation threading (VIEW-ONLY review feature).
-- Additive and backward-compatible: existing imports and non-email documents are
-- unaffected (columns are NULLABLE with no default). Idempotent: safe to re-run.
--
-- Threading is DERIVED at import time from already-imported loadfile metadata
-- (normalised Email Subject + Date Sent) — it adds NO ESI processing, forensic
-- collection, or ingestion-of-raw-data capability. It is purely a display grouping
-- so reviewers can follow a reply chain.
--
--   thread_id      — stable, deterministic identifier shared by every message in a
--                    conversation within a case. Computed as a hash of
--                    (case_id + normalised subject key), so it is stable across
--                    chunked imports: a later chunk's reply joins the existing thread.
--                    NULL for non-email documents and emails with no usable subject.
--   thread_subject — the normalised (prefix-stripped) subject used as the thread's
--                    display label. NULL when thread_id is NULL.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS thread_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS thread_subject TEXT;

-- Fast lookup of a document's thread siblings within a case (thread panel) and of
-- per-thread counts for the list indicator.
CREATE INDEX IF NOT EXISTS idx_documents_case_thread ON documents (case_id, thread_id);
