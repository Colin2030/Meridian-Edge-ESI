import { pool, query } from '../db';
import { runClaimedImport } from './importRunner';

// ---------------------------------------------------------------------------
// Child process that renders a SINGLE claimed import to completion.
//
// The durable worker (src/lib/importQueue.ts) forks this script for each import
// it claims, passing the import id as argv[2]. The heavy image-rendering work in
// the ingest pipeline is synchronous (execFileSync for image conversion); running
// it here, in a separate process, keeps the main app event loop — the Express HTTP
// server and the worker's own heartbeat — fully responsive while an import renders.
//
// Exit codes (read by the parent worker):
//   0  completed successfully (row already set to 'completed' by the ingest run)
//   2  source gone (row already set to 'failed' with the re-upload message)
//   1  hard error (row set to 'failed' here with the error message)
//   3  bad invocation (no/unknown import id) — nothing rendered
// ---------------------------------------------------------------------------

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[import-child] ${msg}`);
}

async function main(): Promise<number> {
  const importId = Number(process.argv[2]);
  if (!Number.isFinite(importId) || importId <= 0) {
    log('missing or invalid import id');
    return 3;
  }
  const { rows } = await query(
    `SELECT id, case_id, name, dat_filename, opt_filename, xml_filename,
            source_kind, original_files, field_mapping, imported_by, attempts
       FROM loadfile_imports WHERE id=$1`,
    [importId]
  );
  if (!rows.length) {
    log(`import ${importId} not found`);
    return 3;
  }
  const res = await runClaimedImport(rows[0]);
  return res.ok ? 0 : 2; // reason:'missing' already persisted as failed by runClaimedImport
}

main()
  .then(async (code) => {
    await pool.end().catch(() => { /* ignore */ });
    process.exit(code);
  })
  .catch(async (e: any) => {
    const importId = Number(process.argv[2]);
    const msg = (e?.message || String(e)).slice(0, 500);
    log(`import ${importId} failed: ${msg}`);
    // Persist the real error so the parent/UI shows it (runClaimedImport throws on hard failure).
    try {
      await query(
        `UPDATE loadfile_imports SET status='failed', phase='failed', error=$2 WHERE id=$1 AND status<>'completed'`,
        [importId, msg]
      );
    } catch { /* best effort */ }
    await pool.end().catch(() => { /* ignore */ });
    process.exit(1);
  });
