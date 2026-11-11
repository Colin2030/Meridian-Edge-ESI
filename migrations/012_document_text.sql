-- 012_document_text.sql — multi-version text per document (extracted / translation / OCR).
-- Phase 1 of the v1.4.0 "Remontoire delivery" epic.
--
-- A document may now carry several text versions, each tagged with a BCP-47
-- language code, whether it is the original or a translation, the source language
-- of a translation, and the translation method (machine | human). Each version is
-- independently full-text indexed, so a search in one language finds a document
-- whose original is in another language (request 5).
--
-- Text is stored EITHER inline (text_content) OR by reference to the blob store
-- (blob_sha256), so large extracted-text payloads can be deduplicated. The
-- document's own documents.search_tsv continues to be maintained (folding every
-- version's text in) so the EXISTING case search path (documents.ts) keeps working
-- unchanged and becomes cross-language without any query change.
--
-- Additive, backward-compatible and idempotent (safe to re-run; never drops).

CREATE TABLE IF NOT EXISTS document_text (
  id             SERIAL PRIMARY KEY,
  document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- BCP-47 language tag, e.g. 'en', 'fr', 'zh-Hans'. Lower-cased for grouping.
  language       TEXT NOT NULL DEFAULT 'und',
  -- Kind of text version.
  kind           TEXT NOT NULL DEFAULT 'extracted'
                   CHECK (kind IN ('extracted','translation','ocr')),
  -- TRUE for the item's original/primary extracted text (shown by default).
  is_original    BOOLEAN NOT NULL DEFAULT FALSE,
  -- For a translation: the source language it was translated from (BCP-47).
  translated_from TEXT,
  -- For a translation: how it was produced. NULL for a non-translation.
  method         TEXT CHECK (method IN ('machine','human')),
  -- Text is stored EITHER inline (text_content) OR by blob reference (blob_sha256).
  blob_sha256    TEXT REFERENCES blobs(sha256),
  text_content   TEXT,
  char_length    INTEGER NOT NULL DEFAULT 0,
  byte_length    INTEGER NOT NULL DEFAULT 0,
  -- Per-version full-text index (Phase 2 per-version search).
  search_tsv     tsvector,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One version per (document, language, kind): a re-import upserts in place.
  UNIQUE (document_id, language, kind)
);
CREATE INDEX IF NOT EXISTS idx_document_text_doc  ON document_text(document_id);
CREATE INDEX IF NOT EXISTS idx_document_text_tsv  ON document_text USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_document_text_lang ON document_text(document_id, language);
