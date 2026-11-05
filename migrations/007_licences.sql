-- Meridian Edge — commercial licences.
--
-- Stores installed licence files. The CURRENTLY ACTIVE licence is the most
-- recently installed row with active=TRUE; installing a new licence marks all
-- previous rows active=FALSE (handled in the application layer, in a
-- transaction). The raw signed licence text is retained verbatim so it can be
-- re-verified against the embedded public key at any time.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS licences (
  id            SERIAL PRIMARY KEY,
  licence_id    TEXT NOT NULL,                 -- the uuid from the signed payload
  customer      TEXT NOT NULL,
  seats         INTEGER NOT NULL,
  issued_at     TIMESTAMPTZ,
  valid_from    TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  notes         TEXT,
  raw_licence   TEXT NOT NULL,                 -- the uploaded .melic file text (verbatim)
  signature     TEXT,                          -- base64 Ed25519 signature (from the envelope)
  installed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- Only one active licence at a time (enforced in app; this partial unique index
-- is a backstop).
CREATE UNIQUE INDEX IF NOT EXISTS uq_licences_single_active ON licences (active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_licences_installed_at ON licences (installed_at DESC);
