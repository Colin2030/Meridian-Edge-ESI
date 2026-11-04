-- Meridian Edge — API tokens for the programmatic (token-authenticated) REST API.
-- An API token acts AS its owning user: when presented it loads that user and
-- all existing per-case RBAC applies unchanged. We NEVER store the raw token —
-- only a SHA-256 hash of it plus a short display prefix. The raw token is shown
-- to the caller exactly once, at creation time.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS api_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_prefix  TEXT NOT NULL,                 -- first ~12 chars (e.g. me_live_ab12) for display/lookup
  token_hash    TEXT NOT NULL UNIQUE,          -- SHA-256 hex of the full raw token
  scopes        TEXT[] NOT NULL DEFAULT '{}',  -- reserved; empty = full access of the owning user
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,                    -- NULL = active
  created_by    INTEGER NOT NULL REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
