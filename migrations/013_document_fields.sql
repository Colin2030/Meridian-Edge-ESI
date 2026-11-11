-- 013_document_fields.sql — per-document threading, native, family and image fields.
-- Phase 1 of the v1.4.0 "Remontoire delivery" epic.
--
-- Fills gaps the load-file import could not carry through and prepares the columns
-- the Phase 2 batch API and viewer will populate. All columns are NULLABLE with no
-- default, so existing documents are unaffected.
--
-- RECONCILIATION NOTE — native_type vs native_mime:
--   documents.native_type ALREADY EXISTS and is the VIEWER RENDER-KIND
--   ('tiff' | 'pdf' | 'none' | 'native'); it drives how the viewer renders an item
--   and carries a CHECK constraint (migrations 001 + 008). We do NOT overload it.
--   The brief's "native type from the declared/detected field" is stored in a NEW
--   column, native_mime, which is the authoritative declared-or-detected MIME type
--   of the native file (request 3). native_type stays the render-kind.
--
-- Additive, backward-compatible and idempotent (safe to re-run; never drops).

-- --- Conversation threading (request 6) ------------------------------------
-- thread_id + thread_subject already exist (migration 009). Add position/size and
-- the optional reply-tree headers.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS thread_position INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS thread_size     INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS message_id      TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS in_reply_to     TEXT;

-- --- Family relationships by explicit parent (request 7) -------------------
-- Explicit parent link by control number (from a PARENTID / parentControlNumber
-- field), kept alongside the existing BEGATTACH/ENDATTACH handling.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_control_number TEXT;

-- --- Native file identity (request 3) -------------------------------------
-- native_sha256 was added in migration 011. Keep the original file name separate
-- from the storage (hash) name; record the declared/detected MIME type.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS native_filename     TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS native_storage_name TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS native_mime         TEXT;

-- --- Review image identity (requests 1/4) ---------------------------------
-- The rendered review image, stored by hash, with its format and page count.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS image_sha256     TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS image_format     TEXT
                                   CHECK (image_format IN ('pdf','tiff'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS image_page_count INTEGER;

-- --- Provenance (implementation recommendation: keep the record traceable) -
-- Which engine + version produced the item (manifest processedBy).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS processed_by TEXT;

-- Fast lookup of a document's children within a case (family panel).
CREATE INDEX IF NOT EXISTS idx_documents_parent
  ON documents(case_id, parent_control_number);
CREATE INDEX IF NOT EXISTS idx_documents_thread_pos
  ON documents(case_id, thread_id, thread_position);
