-- Meridian Edge — initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  email           TEXT,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  is_system_admin BOOLEAN NOT NULL DEFAULT FALSE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cases (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  case_number  TEXT,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  created_by   INTEGER REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_memberships (
  id       SERIAL PRIMARY KEY,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id  INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('case_manager','reviewer','read_only')),
  UNIQUE (user_id, case_id)
);

CREATE TABLE IF NOT EXISTS loadfile_imports (
  id           SERIAL PRIMARY KEY,
  case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  dat_filename TEXT,
  opt_filename TEXT,
  imported_by  INTEGER REFERENCES users(id),
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  doc_count    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'completed'
);

CREATE TABLE IF NOT EXISTS documents (
  id             SERIAL PRIMARY KEY,
  case_id        INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  set_id         INTEGER REFERENCES loadfile_imports(id) ON DELETE SET NULL,
  control_number TEXT NOT NULL,
  native_type    TEXT NOT NULL DEFAULT 'tiff' CHECK (native_type IN ('tiff','pdf','none')),
  native_path    TEXT,
  page_count     INTEGER NOT NULL DEFAULT 0,
  has_text       BOOLEAN NOT NULL DEFAULT FALSE,
  extracted_text TEXT,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_tsv     tsvector,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, control_number)
);
CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id);
CREATE INDEX IF NOT EXISTS idx_documents_tsv ON documents USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_documents_meta ON documents USING GIN (metadata);

CREATE TABLE IF NOT EXISTS document_pages (
  id          SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_no     INTEGER NOT NULL,
  image_path  TEXT NOT NULL,
  UNIQUE (document_id, page_no)
);

CREATE TABLE IF NOT EXISTS review_states (
  document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK (status IN ('unreviewed','in_review','responsive','non_responsive','privileged','further_review')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_review_states_case ON review_states(case_id, status);

CREATE TABLE IF NOT EXISTS bookmarks (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, document_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id      SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  colour  TEXT NOT NULL DEFAULT '#64748b',
  UNIQUE (case_id, name)
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);

CREATE TABLE IF NOT EXISTS folders (
  id        SERIAL PRIMARY KEY,
  case_id   INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS document_folders (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  folder_id   INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, folder_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id          SERIAL PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  case_id    INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_log(case_id);
