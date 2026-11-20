import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';
import { query, withTx, isTransientConnError } from '../db';
import * as blobStore from './blobStore';
import { audit } from './audit';

// ============================================================================
// Item batch API — shared runner (Phase 2, v1.4.0 "Remontoire delivery").
// ----------------------------------------------------------------------------
// The batch endpoints (src/routes/batches.ts) store already-processed items
// synchronously at POST time (text already extracted, natives + review images
// supplied). The heavy, deferrable work — rendering a supplied PDF/TIFF review
// image into page images for the viewer, and linking families — runs
// ASYNCHRONOUSLY on commit, mirroring the durable-worker pattern used by the
// load-file import queue (src/lib/importQueue.ts): a batch left in 'committing'
// by a restart is re-finalised on boot (reconcileBatchesOnBoot), and finalise is
// idempotent (pages upsert, families recompute). No ESI processing / text
// extraction is performed — rendering a SUPPLIED image is display only.
//
// Progress (request 11) is held in batches.counts JSONB as a fixed-order phase
// map plus the request-9 verification aggregate. Counters only ever increase and
// every mutation refreshes batches.updated_at, so a client can tell a slow job
// from a stalled one.
// ============================================================================

/** How many parallel item requests the server accepts against one batch.
 * Chosen at 4: item ingestion is cheap (no extraction) but each request can
 * carry a few hundred items and their files, and finalise rendering is CPU-bound
 * (pdftoppm/convert). 4 keeps the box responsive and matches the import worker's
 * one-render-at-a-time discipline that previously prevented overload restarts. */
export const BATCH_CONCURRENCY = 4;

/** Phases in the FIXED order required by the brief's progress table (request 11). */
export const PHASE_ORDER = [
  'receiving',
  'storing',
  'indexing_text',
  'rendering',
  'linking',
  'finalising',
] as const;
export type PhaseName = typeof PHASE_ORDER[number];

/** Stable machine-readable error codes (request 5 / "name every error").
 * Documented in the OpenAPI spec (Phase 5) — keep consistent and centralised. */
export const ERROR_CODES = {
  MISSING_CONTROL_NUMBER: 'missing_control_number',
  MISSING_PART: 'missing_part',
  HASH_MISMATCH: 'hash_mismatch',
  TEXT_MISSING: 'text_missing',
  PARENT_NOT_FOUND: 'parent_not_found',
  UNSUPPORTED_IMAGE_FORMAT: 'unsupported_image_format',
  INVALID_MANIFEST: 'invalid_manifest',
  BATCH_NOT_OPEN: 'batch_not_open',
  ITEM_ERROR: 'item_error',
} as const;

export interface BatchFailure {
  controlNumber: string | null;
  code: string;
  reason: string;
  failedValue?: string | null;
}

export interface PhaseCount { done: number; total: number; state: 'pending' | 'running' | 'complete'; }

export interface Verification {
  items_received: number;
  items_created: number;
  items_updated: number;
  text_indexed: Record<string, number>; // per BCP-47 language
  text_missing: number;                 // items with no searchable text
  natives_stored: number;
  images_stored: number;
  pages: number;
  threads_populated: number;
  families_linked: number;
  unmapped_columns: string[];
  failures: BatchFailure[];
}

export interface BatchCounts {
  phases: Record<PhaseName, PhaseCount>;
  verification: Verification;
}

export function emptyVerification(): Verification {
  return {
    items_received: 0, items_created: 0, items_updated: 0,
    text_indexed: {}, text_missing: 0,
    natives_stored: 0, images_stored: 0, pages: 0,
    threads_populated: 0, families_linked: 0,
    unmapped_columns: [], failures: [],
  };
}

export function initialCounts(expected: { items?: number | null; files?: number | null; bytes?: number | null }): BatchCounts {
  const items = expected.items ?? 0;
  const files = expected.files ?? 0;
  const phase = (total: number): PhaseCount => ({ done: 0, total, state: 'pending' });
  return {
    phases: {
      receiving: phase(items),
      storing: phase(files),
      indexing_text: phase(items),
      rendering: phase(0),       // total set from images_stored as they arrive
      linking: phase(0),
      finalising: phase(items),
    },
    verification: emptyVerification(),
  };
}

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[batch] ${msg}`);
}

// ---------------------------------------------------------------------------
// Counting — concurrency-safe, monotonic.
// Item requests may run in parallel; each applies its accumulated deltas under a
// row lock so JSONB merges never race, and counters only increase.
// ---------------------------------------------------------------------------

export interface ItemDeltas {
  items_received: number;
  items_created: number;
  items_updated: number;
  text_indexed: Record<string, number>;
  text_missing: number;
  natives_stored: number;
  images_stored: number;
  threads_populated: number;
  failures: BatchFailure[];
}

export function emptyDeltas(): ItemDeltas {
  return {
    items_received: 0, items_created: 0, items_updated: 0,
    text_indexed: {}, text_missing: 0, natives_stored: 0, images_stored: 0,
    threads_populated: 0, failures: [],
  };
}

/** Apply a request's accumulated deltas to batches.counts under a row lock. */
export async function applyItemDeltas(batchId: string, d: ItemDeltas): Promise<void> {
  await withTx(async (q) => {
    const { rows } = await q(`SELECT counts FROM batches WHERE id=$1 FOR UPDATE`, [batchId]);
    if (!rows.length) return;
    const counts: BatchCounts = rows[0].counts || initialCounts({});
    const v = counts.verification || emptyVerification();
    v.items_received += d.items_received;
    v.items_created += d.items_created;
    v.items_updated += d.items_updated;
    v.text_missing += d.text_missing;
    v.natives_stored += d.natives_stored;
    v.images_stored += d.images_stored;
    v.threads_populated += d.threads_populated;
    for (const [lang, n] of Object.entries(d.text_indexed)) v.text_indexed[lang] = (v.text_indexed[lang] || 0) + n;
    if (d.failures.length) v.failures = [...v.failures, ...d.failures];
    counts.verification = v;
    // Phase done counters (monotonic): receiving/storing/indexing track received work.
    const p = counts.phases;
    p.receiving.done = v.items_received;
    p.receiving.state = 'running';
    p.storing.done = v.natives_stored + v.images_stored;
    p.storing.state = 'running';
    // total files may exceed declared expectation; keep denominator at least done.
    p.storing.total = Math.max(p.storing.total, p.storing.done);
    p.indexing_text.done = Object.values(v.text_indexed).reduce((s, n) => s + n, 0);
    p.indexing_text.state = 'running';
    p.rendering.total = v.images_stored;
    await q(`UPDATE batches SET counts=$2, updated_at=now() WHERE id=$1`, [batchId, JSON.stringify(counts)]);
  });
}

async function readCounts(batchId: string): Promise<BatchCounts | null> {
  const { rows } = await query(`SELECT counts FROM batches WHERE id=$1`, [batchId]);
  if (!rows.length) return null;
  return rows[0].counts || initialCounts({});
}

async function writeCounts(batchId: string, counts: BatchCounts): Promise<void> {
  await query(`UPDATE batches SET counts=$2, updated_at=now() WHERE id=$1`, [batchId, JSON.stringify(counts)]);
}

// ---------------------------------------------------------------------------
// Rendering a supplied review image (PDF/TIFF) into page PNGs (display only).
// ---------------------------------------------------------------------------

function renderImageToPages(srcPath: string, format: 'pdf' | 'tiff', destDir: string, tag: string): string[] {
  fs.mkdirSync(destDir, { recursive: true });
  const out: string[] = [];
  const re = new RegExp(`^${tag}-(\\d+)\\.png$`);
  const numSort = (a: string, b: string) => {
    const na = parseInt((a.match(re) || [])[1] || '0', 10);
    const nb = parseInt((b.match(re) || [])[1] || '0', 10);
    return na - nb;
  };
  try {
    if (format === 'pdf') {
      execFileSync('pdftoppm', ['-png', '-r', '120', srcPath, path.join(destDir, tag)], { stdio: 'ignore' });
    } else {
      execFileSync('convert', ['-density', '120', srcPath, path.join(destDir, `${tag}-%03d.png`)], { stdio: 'ignore' });
    }
  } catch { /* a bad image yields zero pages; reported as 0 rendered */ }
  const produced = fs.readdirSync(destDir).filter((f) => re.test(f)).sort(numSort);
  for (const f of produced) out.push(path.join(destDir, f));
  return out;
}

// ---------------------------------------------------------------------------
// Finalise a committed batch: render review images, link families, mark visible.
// Idempotent and restart-safe (re-runnable from 'committing').
// ---------------------------------------------------------------------------

export async function finaliseBatch(batchId: string): Promise<void> {
  const { rows: brows } = await query(`SELECT id, case_id, status FROM batches WHERE id=$1`, [batchId]);
  if (!brows.length) return;
  const caseId: number = brows[0].case_id;
  if (brows[0].status === 'completed' || brows[0].status === 'completed_with_failures' || brows[0].status === 'failed') return;

  await query(`UPDATE batches SET status='committing', updated_at=now() WHERE id=$1`, [batchId]);
  const counts = (await readCounts(batchId)) || initialCounts({});

  // --- rendering phase: render each item's supplied review image to page PNGs ---
  counts.phases.rendering.state = 'running';
  // Re-run safety: a transient-failure retry re-renders every item, and page
  // inserts upsert by (document_id, page_no), so recompute the page total from
  // zero rather than double-counting the += below on a second pass.
  counts.verification.pages = 0;
  await writeCounts(batchId, counts);
  const pagesRoot = path.join(config.uploadsDir, `case-${caseId}`, 'rendered', `batch-${batchId}`);
  const { rows: imgDocs } = await query<{ id: number; control_number: string; image_sha256: string; image_format: 'pdf' | 'tiff' }>(
    `SELECT d.id, d.control_number, d.image_sha256, d.image_format
       FROM documents d JOIN batch_items bi ON bi.document_id = d.id
      WHERE bi.batch_id=$1 AND d.image_sha256 IS NOT NULL AND d.image_format IS NOT NULL`,
    [batchId]
  );
  counts.phases.rendering.total = Math.max(counts.phases.rendering.total, imgDocs.length);
  let rendered = 0;
  let lastTouch = Date.now();
  for (const d of imgDocs) {
    const blobFile = blobStore.getPath(d.image_sha256);
    if (blobFile) {
      const destDir = path.join(pagesRoot, String(d.id));
      const pagePaths = renderImageToPages(blobFile, d.image_format, destDir, `img`);
      await query(`DELETE FROM document_pages WHERE document_id=$1`, [d.id]);
      for (let i = 0; i < pagePaths.length; i++) {
        const rel = path.relative(config.uploadsDir, pagePaths[i]);
        await query(
          `INSERT INTO document_pages (document_id, page_no, image_path) VALUES ($1,$2,$3)
             ON CONFLICT (document_id, page_no) DO UPDATE SET image_path=EXCLUDED.image_path`,
          [d.id, i + 1, rel]
        );
      }
      await query(`UPDATE documents SET page_count=$2 WHERE id=$1`, [d.id, pagePaths.length]);
      counts.verification.pages += pagePaths.length;
    }
    rendered++;
    counts.phases.rendering.done = rendered;
    // Refresh at least every ~10s so updatedAt stays fresh during a long render.
    if (Date.now() - lastTouch > 10_000) { await writeCounts(batchId, counts); lastTouch = Date.now(); }
  }
  counts.phases.rendering.state = 'complete';
  await writeCounts(batchId, counts);

  // --- linking phase: resolve explicit parent links (families) ---------------
  counts.phases.linking.state = 'running';
  // Re-run safety: drop any PARENT_NOT_FOUND rows/entries from a previous finalise
  // pass so the links recompute cleanly. Item-ingestion failures are untouched.
  await query(`DELETE FROM import_failures WHERE batch_id=$1 AND code=$2`, [batchId, ERROR_CODES.PARENT_NOT_FOUND]);
  counts.verification.failures = counts.verification.failures.filter((f) => f.code !== ERROR_CODES.PARENT_NOT_FOUND);
  await writeCounts(batchId, counts);
  const { rows: children } = await query<{ control_number: string; parent_control_number: string }>(
    `SELECT d.control_number, d.parent_control_number
       FROM documents d JOIN batch_items bi ON bi.document_id = d.id
      WHERE bi.batch_id=$1 AND d.parent_control_number IS NOT NULL AND d.parent_control_number <> ''`,
    [batchId]
  );
  let familiesLinked = 0;
  for (const c of children) {
    const { rows: parent } = await query(
      `SELECT 1 FROM documents WHERE case_id=$1 AND control_number=$2 LIMIT 1`,
      [caseId, c.parent_control_number]
    );
    if (parent.length) {
      familiesLinked++;
    } else {
      counts.verification.failures.push({
        controlNumber: c.control_number, code: ERROR_CODES.PARENT_NOT_FOUND,
        reason: `Parent control number ${c.parent_control_number} not found in the case`,
        failedValue: c.parent_control_number,
      });
      await query(
        `INSERT INTO import_failures (case_id, batch_id, control_number, code, reason, failed_value)
           VALUES ($1,$2,$3,$4,$5,$6)`,
        [caseId, batchId, c.control_number, ERROR_CODES.PARENT_NOT_FOUND,
         `Parent control number ${c.parent_control_number} not found in the case`, c.parent_control_number]
      );
    }
  }
  counts.verification.families_linked = familiesLinked;
  counts.phases.linking.done = children.length;
  counts.phases.linking.total = children.length;
  counts.phases.linking.state = 'complete';
  await writeCounts(batchId, counts);

  // --- finalising phase: mark items complete / visible -----------------------
  counts.phases.finalising.state = 'running';
  await writeCounts(batchId, counts);
  await query(`UPDATE batch_items SET status='completed', updated_at=now() WHERE batch_id=$1 AND status<>'failed'`, [batchId]);
  const { rows: itemCount } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM batch_items WHERE batch_id=$1`, [batchId]);
  // Mark remaining phase denominators complete so a bar reaches a stated result.
  counts.phases.receiving.state = 'complete';
  counts.phases.storing.state = 'complete';
  counts.phases.storing.done = counts.verification.natives_stored + counts.verification.images_stored;
  counts.phases.storing.total = Math.max(counts.phases.storing.total, counts.phases.storing.done);
  counts.phases.indexing_text.state = 'complete';
  counts.phases.finalising.done = itemCount[0].n;
  counts.phases.finalising.total = Math.max(counts.phases.finalising.total, itemCount[0].n);
  counts.phases.finalising.state = 'complete';

  const anyFailures = counts.verification.failures.length > 0;
  const endState = itemCount[0].n === 0 && anyFailures ? 'failed'
    : anyFailures ? 'completed_with_failures' : 'completed';
  await query(`UPDATE batches SET status=$2, end_state=$2, counts=$3, updated_at=now() WHERE id=$1`,
    [batchId, endState, JSON.stringify(counts)]);
  await audit({ userId: null, caseId, action: 'batch.completed', target: `batch:${batchId}`,
    detail: `${counts.verification.items_received} received, ${counts.verification.items_created} created, ${counts.verification.items_updated} updated, ${counts.verification.pages} pages, ${familiesLinked} families (${endState})` });
  log(`finalised ${batchId}: ${endState} (${counts.verification.items_received} items, ${counts.verification.pages} pages)`);
}

/** Kick off finalisation asynchronously; errors mark the batch failed.
 * A dropped connection during the long synchronous render window is transient —
 * finalise is idempotent and re-runs cleanly from 'committing', so retry a few
 * times before giving up. query()/withTx() already retry individual statements;
 * this is the belt-and-braces outer loop for an error that escapes finalise. */
export function startFinalise(batchId: string): void {
  const MAX_ATTEMPTS = 4;
  setImmediate(async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await finaliseBatch(batchId);
        return;
      } catch (e: any) {
        if (isTransientConnError(e) && attempt < MAX_ATTEMPTS) {
          log(`finalise transient error for ${batchId} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying: ${(e?.message || e)}`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        const msg = (e?.message || String(e)).slice(0, 500);
        log(`finalise error for ${batchId}: ${msg}`);
        try {
          const counts = (await readCounts(batchId)) || initialCounts({});
          counts.verification.failures.push({ controlNumber: null, code: 'finalise_error', reason: msg });
          await query(`UPDATE batches SET status='failed', end_state='failed', counts=$2, updated_at=now() WHERE id=$1`,
            [batchId, JSON.stringify(counts)]);
        } catch { /* best effort */ }
        return;
      }
    }
  });
}

/** Boot reconciliation: re-finalise any batch left mid-commit by a restart. */
export async function reconcileBatchesOnBoot(): Promise<void> {
  try {
    const { rows } = await query<{ id: string }>(`SELECT id FROM batches WHERE status='committing'`);
    for (const r of rows) {
      log(`boot: resuming finalisation of batch ${r.id}`);
      startFinalise(r.id);
    }
    if (rows.length) log(`boot: ${rows.length} batch(es) resumed`);
  } catch (e: any) {
    log(`boot reconcile error: ${e?.message || e}`);
  }
}

/** Build the status payload (request 11): fixed-order phases + verification + end state. */
export function buildStatus(batch: any): any {
  const counts: BatchCounts = batch.counts || initialCounts({});
  const phases = PHASE_ORDER.map((name) => ({ phase: name, ...(counts.phases?.[name] || { done: 0, total: 0, state: 'pending' }) }));
  const terminal = ['completed', 'completed_with_failures', 'failed'];
  return {
    batchId: batch.id,
    caseId: batch.case_id,
    status: batch.status,
    expected: { items: batch.expected_items, files: batch.expected_files, bytes: batch.expected_bytes == null ? null : Number(batch.expected_bytes) },
    concurrency: BATCH_CONCURRENCY,
    phases,
    verification: counts.verification || emptyVerification(),
    endState: batch.end_state || (terminal.includes(batch.status) ? batch.status : null),
    updatedAt: batch.updated_at instanceof Date ? batch.updated_at.toISOString() : batch.updated_at,
  };
}
