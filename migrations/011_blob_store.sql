-- 011_blob_store.sql — content-addressed blob storage.
-- Phase 1 of the v1.4.0 "Remontoire delivery" epic.
--
-- Files (natives, audit-report attachments, and — in later phases — batch item
-- files) are stored once on disk under a content-addressed path keyed by their
-- SHA-256, so identical content is never stored twice. This table is the index:
-- it records each distinct blob's hash, size, detected MIME type and a reference
-- count so a blob can be garbage-collected only when nothing refers to it.
--
-- Additive, backward-compatible and idempotent (safe to re-run; never drops).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS blobs (
  sha256      TEXT PRIMARY KEY,                 -- lowercase hex SHA-256 of the content
  byte_size   BIGINT NOT NULL,                  -- exact content length in bytes
  mime_type   TEXT,                             -- detected (or supplied) MIME type
  ref_count   INTEGER NOT NULL DEFAULT 0,       -- number of logical references held
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reference the native file (stored in the blob store) from a document, by hash.
-- The original file name is kept separately (native_filename, migration 013) so a
-- native stored under its hash is still downloadable under its real name.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS native_sha256 TEXT;
CREATE INDEX IF NOT EXISTS idx_documents_native_sha ON documents(native_sha256);
