-- 008_edrm_xml.sql — support EDRM XML loadfile imports (third format alongside .DAT/.OPT).
-- Additive and backward-compatible: existing Concordance .DAT/.OPT imports are unaffected.
-- Idempotent: safe to re-run.

-- 1. Allow a 'native' native_type for native-only documents (EDRM exports carry a
--    native file + metadata but no rendered TIFF/PDF pages). Existing values
--    ('tiff','pdf','none') remain valid.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_native_type_check;
ALTER TABLE documents
  ADD CONSTRAINT documents_native_type_check
  CHECK (native_type IN ('tiff','pdf','none','native'));

-- 2. Record the EDRM XML loadfile name on the import row (alongside dat/opt filenames).
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS xml_filename TEXT;
