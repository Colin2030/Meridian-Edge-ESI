-- 018_saved_searches.sql
-- Per-user, per-case saved searches. Additive & idempotent (CREATE ... IF NOT EXISTS).
-- Stores the search/filter state as a JSON payload so a user can re-run a complex
-- query later with one click. View-only feature — no ingestion/processing.

CREATE TABLE IF NOT EXISTS saved_searches (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id    INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  payload    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup of a user's saved searches within a case (newest first).
CREATE INDEX IF NOT EXISTS idx_saved_searches_user_case
  ON saved_searches (user_id, case_id, created_at DESC);
