-- Meridian Edge — nested (hierarchical) tags
-- Adds a nullable self-referencing parent_id to tags so tags can be nested
-- under other tags. parent_id NULL = top-level tag (existing tags stay valid).
-- ON DELETE CASCADE: deleting a parent tag removes its whole subtree; the
-- document_tags rows for the removed tags are cleaned up automatically because
-- document_tags.tag_id already references tags(id) ON DELETE CASCADE.
-- Idempotent: safe to re-run.

ALTER TABLE tags ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES tags(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_tags_parent ON tags(parent_id);
