-- 014_batches_verification.sql — item batch API tables + per-import verification counts.
-- Phase 1 of the v1.4.0 "Remontoire delivery" epic (schema foundation).
--
-- The batch API ENDPOINTS themselves are built in Phase 2; this migration lays the
-- durable schema so Phase 1 can already record verification counts and per-item
-- failures for load-file imports ("account for every item"), and so the Phase 2
-- batch work has its tables in place.
--
-- Additive, backward-compatible and idempotent (safe to re-run; never drops).

-- --- Batches (request 1 / progress reporting request 11) -------------------
-- A batch groups items streamed from the pipeline. Declared totals (expected_*)
-- give every progress count a denominator from the start; per-phase counts are an
-- append-only JSONB aggregate that only ever increases.
CREATE TABLE IF NOT EXISTS batches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','committing','completed',
                                     'completed_with_failures','failed')),
  -- Declared up front so progress always has a denominator (request 11).
  expected_items INTEGER,
  expected_files INTEGER,
  expected_bytes BIGINT,
  -- Per-phase done/total counts, e.g. {"receiving":{"done":0,"total":0}, ...}.
  counts         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Explicit end state once finalised (mirrors status; kept for audit clarity).
  end_state      TEXT CHECK (end_state IN ('completed','completed_with_failures','failed')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_case ON batches(case_id);

-- --- Batch items ------------------------------------------------------------
-- One row per item received in a batch, upserted on (batch_id, control_number) so
-- a retried request never creates duplicates (request 1).
CREATE TABLE IF NOT EXISTS batch_items (
  id             SERIAL PRIMARY KEY,
  batch_id       UUID NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  control_number TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','stored','indexed','linked',
                                     'completed','failed')),
  document_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, control_number)
);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id);

-- --- Per-item import/batch failures (request 9 + "make every error name its item")
-- Every item that is NOT loaded ends here with its control number, a machine-
-- readable code and a human reason, so items sent == items loaded + items failed.
-- Linked to an import (load-file path) OR a batch (Phase 2), both nullable.
CREATE TABLE IF NOT EXISTS import_failures (
  id             SERIAL PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  import_id      INTEGER REFERENCES loadfile_imports(id) ON DELETE CASCADE,
  batch_id       UUID REFERENCES batches(id) ON DELETE CASCADE,
  control_number TEXT,
  -- Machine-readable code, e.g. 'text_missing', 'parent_not_found', 'hash_mismatch'.
  code           TEXT NOT NULL,
  reason         TEXT NOT NULL,
  -- The value that failed (a path, a hash, a parent id), for tracing.
  failed_value   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_failures_import ON import_failures(import_id);
CREATE INDEX IF NOT EXISTS idx_import_failures_batch  ON import_failures(batch_id);
CREATE INDEX IF NOT EXISTS idx_import_failures_case   ON import_failures(case_id);

-- --- Per-import verification counts + field mapping (requests 9 + metadata) --
-- verification: the reconciliation aggregate returned by the import status
--   endpoint once complete (items_received/created/updated, text_indexed/missing,
--   natives_stored, threads_populated, families_linked, unmapped_columns, ...).
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS verification  JSONB NOT NULL DEFAULT '{}'::jsonb;
-- field_mapping: integrator sourceColumn -> platformField bindings supplied on
--   import, e.g. {"DATESENT":"date","THREADID":"thread_id"}.
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS field_mapping JSONB;
