import path from 'path';
import { fork } from 'child_process';
import { query } from '../db';

// ---------------------------------------------------------------------------
// Durable, resumable, serialised background import worker.
//
// ONE worker runs in the app process (started on boot). It processes imports
// STRICTLY one at a time — never two concurrent renders, which previously
// overloaded the box and triggered auto-restarts. State is DB-backed so the
// worker survives a service restart: an import that was mid-render when the
// process died is left as status='processing' with a stale heartbeat, and the
// worker RESUMES it (re-running the idempotent ingest from the still-staged
// source). If the source is gone, it is marked failed with a re-upload message.
//
// Each claimed import is rendered in a forked CHILD process
// (importWorkerChild.ts). The ingest pipeline converts images synchronously
// (execFileSync), which would otherwise block the main event loop and freeze the
// HTTP API and this worker's heartbeat for the duration of a render. Forking keeps
// the parent responsive; the parent refreshes the heartbeat and awaits the child
// so serialisation is preserved (the next import is only claimed after the child
// exits). A service restart kills parent and child together (same cgroup), so no
// orphaned render survives — boot reconciliation then resumes the interrupted row.
//
// Lifecycle: queued -> processing -> completed | failed.
// ---------------------------------------------------------------------------

/** How often the idle worker looks for the next import to run. */
const POLL_INTERVAL_MS = 4_000;
/** How often the worker refreshes the heartbeat of the import it is running. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * A 'processing' row whose heartbeat is older than this is considered orphaned
 * (its worker died) and is eligible to be resumed. Must be comfortably larger
 * than HEARTBEAT_INTERVAL_MS so a live import is never mistaken for orphaned.
 */
const STALE_LEASE_MS = 90_000;

let running = false;          // true while an import is actively rendering
let pollTimer: NodeJS.Timeout | null = null;
let started = false;

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[import-queue] ${msg}`);
}

interface ClaimedRow {
  id: number;
  case_id: number;
  name: string | null;
  dat_filename: string | null;
  opt_filename: string | null;
  xml_filename: string | null;
  source_kind: string | null;
  original_files: any;
  imported_by: number | null;
  attempts: number;
  was_processing: boolean;
}

/**
 * Atomically claim the next import to run: the oldest 'queued' row, OR a
 * 'processing' row whose heartbeat has gone stale (orphaned by a restart). The
 * claim flips it to 'processing' with a fresh heartbeat under FOR UPDATE SKIP
 * LOCKED so even two worker instances could never claim the same row. Returns
 * null when there is nothing to do.
 */
async function claimNext(): Promise<ClaimedRow | null> {
  const staleCutoffSql = `now() - interval '${Math.round(STALE_LEASE_MS / 1000)} seconds'`;
  const { rows } = await query<ClaimedRow>(
    `UPDATE loadfile_imports i
        SET status = 'processing',
            last_heartbeat_at = now(),
            attempts = i.attempts + 1
      WHERE i.id = (
        SELECT c.id
          FROM loadfile_imports c
         WHERE c.status = 'queued'
            OR (c.status = 'processing'
                AND (c.last_heartbeat_at IS NULL OR c.last_heartbeat_at < ${staleCutoffSql}))
         ORDER BY (c.status = 'processing') DESC,  -- resume orphans before new queued work
                  c.enqueued_at ASC NULLS FIRST,
                  c.id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING i.id, i.case_id, i.name, i.dat_filename, i.opt_filename, i.xml_filename,
                i.source_kind, i.original_files, i.imported_by, i.attempts,
                (i.attempts > 1) AS was_processing`,
    []
  );
  return rows.length ? rows[0] : null;
}

/** Keep the claimed import's heartbeat fresh so no other worker reclaims it mid-render. */
function startHeartbeat(importId: number): NodeJS.Timeout {
  return setInterval(() => {
    query(`UPDATE loadfile_imports SET last_heartbeat_at = now() WHERE id=$1 AND status='processing'`, [importId])
      .catch((e) => log(`heartbeat error for import ${importId}: ${e?.message || e}`));
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Render one import in a forked child process, resolving only once the child has
 * exited. Keeps the heavy synchronous render off the parent's event loop while
 * still being awaited (so the queue stays strictly serial).
 *   exit 0 -> completed · exit 2 -> source missing (already marked failed) · else -> error
 */
function runInChild(importId: number): Promise<{ ok: boolean; reason?: 'missing' }> {
  return new Promise((resolve, reject) => {
    const childPath = path.join(__dirname, 'importWorkerChild.js');
    const child = fork(childPath, [String(importId)]);
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else if (code === 2) resolve({ ok: false, reason: 'missing' });
      else reject(new Error(`render child exited with code ${code}`));
    });
    child.on('error', (err) => reject(err));
  });
}

async function processOne(row: ClaimedRow): Promise<void> {
  const label = `import ${row.id} (case ${row.case_id}${row.name ? `, "${row.name}"` : ''})`;
  // attempts was just incremented by the claim; a freshly-queued row claims at
  // attempts=1. Anything higher means we are resuming a previously-run import.
  if (row.attempts > 1) {
    log(`RESUMING ${label} after interruption (attempt ${row.attempts}) — re-running idempotent ingest from staged source`);
  } else {
    log(`CLAIMED ${label} — starting render`);
  }
  const hb = startHeartbeat(row.id);
  try {
    const res = await runInChild(row.id);
    if (res.ok) log(`COMPLETED ${label}`);
    else if (res.reason === 'missing') log(`FAILED ${label} — staged source gone; marked for re-upload`);
  } catch (e: any) {
    const msg = (e?.message || String(e)).slice(0, 500);
    log(`FAILED ${label} — ${msg}`);
    // The child persists its own detailed error on a hard failure; only fall back
    // to this generic message if it died without recording one (e.g. was killed).
    try {
      await query(
        `UPDATE loadfile_imports SET status='failed', phase='failed', error=COALESCE(error,$2) WHERE id=$1 AND status<>'completed'`,
        [row.id, msg]
      );
    } catch { /* best effort */ }
  } finally {
    clearInterval(hb);
  }
}

async function tick(): Promise<void> {
  if (running) return;          // strict serialisation: one import at a time
  running = true;
  try {
    // Drain the queue: keep claiming and running until there is nothing left,
    // then fall back to idle polling. Still strictly one at a time.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let row: ClaimedRow | null;
      try {
        row = await claimNext();
      } catch (e: any) {
        log(`claim error: ${e?.message || e}`);
        break;
      }
      if (!row) break;
      await processOne(row);
    }
  } finally {
    running = false;
  }
}

/**
 * Boot reconciliation: this is the ONLY worker, so on startup any row still
 * marked 'processing' was orphaned by the previous process dying mid-render.
 * Clear its heartbeat so the very next claim cycle resumes it immediately
 * (rather than waiting out the stale-lease window).
 */
async function reconcileOnBoot(): Promise<void> {
  try {
    const { rows } = await query<{ id: number }>(
      `UPDATE loadfile_imports SET last_heartbeat_at = NULL
        WHERE status = 'processing'
        RETURNING id`,
      []
    );
    if (rows.length) {
      log(`boot: found ${rows.length} orphaned processing import(s) [${rows.map((r) => r.id).join(', ')}] — will resume`);
    } else {
      log('boot: no orphaned imports to resume');
    }
  } catch (e: any) {
    log(`boot reconcile error: ${e?.message || e}`);
  }
}

/** Start the durable import worker. Idempotent — safe to call once on boot. */
export function startImportWorker(): void {
  if (started) return;
  started = true;
  log(`starting (poll ${POLL_INTERVAL_MS}ms, heartbeat ${HEARTBEAT_INTERVAL_MS}ms, stale-lease ${STALE_LEASE_MS}ms)`);
  reconcileOnBoot()
    .then(() => tick())
    .catch((e) => log(`initial tick error: ${e?.message || e}`));
  pollTimer = setInterval(() => { tick().catch((e) => log(`tick error: ${e?.message || e}`)); }, POLL_INTERVAL_MS);
  if (pollTimer.unref) pollTimer.unref();
}
