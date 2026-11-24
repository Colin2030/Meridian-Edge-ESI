-- 019_branding_settings.sql
-- Small key/value settings store for cosmetic deployment branding (currently the
-- admin-configurable login-page logo). Additive & idempotent (CREATE ... IF NOT
-- EXISTS). This is DISPLAY/BRANDING ONLY — it stores a reference to an uploaded
-- image for the pre-auth login page and changes nothing about the view-only
-- security model, ingestion, processing or forensic behaviour of the platform.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The login logo is stored under the well-known key 'login_logo' with a JSON
-- value of the shape:
--   { "storedPath": "branding/login-logo-<ts>.<ext>",   -- relative to uploadsDir
--     "originalFilename": "acme-logo.png",
--     "mime": "image/png",
--     "uploadedBy": 1,
--     "uploadedAt": "2026-11-24T12:00:00.000Z" }
-- Absence of the row (or a cleared value) means "use the bundled default logo".
