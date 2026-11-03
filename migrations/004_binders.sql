-- Binders: named groupings of documents within a case, allocatable to a
-- reviewer and shareable via a per-binder URL. A case has unlimited binders;
-- a document may belong to multiple binders. Idempotent (CREATE ... IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS binders (
  id          SERIAL PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_binders_case ON binders(case_id);
CREATE INDEX IF NOT EXISTS idx_binders_assigned ON binders(assigned_to);

CREATE TABLE IF NOT EXISTS binder_documents (
  binder_id   INTEGER NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  added_by    INTEGER REFERENCES users(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (binder_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_binder_documents_doc ON binder_documents(document_id);
