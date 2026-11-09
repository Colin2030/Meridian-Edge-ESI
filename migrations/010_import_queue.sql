-- Durable, resumable, serialised background import queue.
--
-- Adds queue bookkeeping to loadfile_imports so large multi-chunk loadfile
-- imports process hands-off, one at a time, and SURVIVE a service restart
-- without being orphaned. This only re-sequences the EXISTING pre-processed
-- loadfile import — it adds no new processing capability (the platform remains
-- view-only). Status lifecycle: queued -> processing -> completed | failed.
--
-- Backward compatible: ADD COLUMN IF NOT EXISTS with sensible defaults; no
-- existing column is dropped or renamed. Safe to run repeatedly (idempotent).

-- When the import entered the queue (ordering key: oldest queued runs first).
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS enqueued_at timestamptz;

-- Worker lease/heartbeat: a 'processing' row whose heartbeat is stale (older
-- than the worker's threshold) was orphaned by a restart and is safe to resume.
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

-- How many times the worker has claimed this import (diagnostics only).
ALTER TABLE loadfile_imports ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Fast lookup of the next claimable row (queued, or stale processing) by age.
CREATE INDEX IF NOT EXISTS idx_loadfile_imports_queue
  ON loadfile_imports (status, enqueued_at);
