import fs from 'fs';
import { query, withTx } from '../db';
import { blobPath } from './blobStore';
import { audit } from './audit';

// ---------------------------------------------------------------------------
// Delete / archive / retention / restore + purge (Phase 3, request 10).
//
// Soft-delete model: a delete stamps deleted_at = now() and retention_until =
// now() + RETENTION_DAYS on the affected rows and excludes them from normal
// listings. Nothing is physically removed until retention_until has passed and
// the purge mechanism runs. A restore (within the window) clears those stamps,
// bringing the records and their files back intact.
//
// Blob ref-counting: soft-delete NEVER touches blobs (restore must bring files
// back). Only the purge decrements blobs.ref_count for the native blob of each
// document being permanently removed and deletes the on-disk blob when the count
// reaches zero. Case-level audit_entries (request 8) are KEPT even when a case's
// documents are removed, so their attachment blobs are never decremented here.
//
// VIEW-ONLY: this adds no processing capability — it only hides, restores and
// eventually removes already-ingested records and their stored bytes.
// ---------------------------------------------------------------------------

export const RETENTION_DAYS = 7;

/** A case/import whose document count exceeds this runs the delete as a 202 job. */
export const LARGE_DELETE_THRESHOLD = 1000;

export const ERROR_CODES = {
  not_found: 'not_found',
  forbidden: 'forbidden',
  invalid_status: 'invalid_status',
  retention_expired: 'retention_expired',
  unsupported_attachment_type: 'unsupported_attachment_type',
  nothing_to_restore: 'nothing_to_restore',
  bad_request: 'bad_request',
} as const;

export interface Principal {
  id: number;
  isSystemAdmin: boolean;
}

/**
 * A delete/archive is allowed for a system administrator OR the case manager who
 * created the case (for case-level ops) / the import/batch (for those ops).
 * Returns { ok:true } or { ok:false, code:'forbidden'|'not_found' }.
 */
export async function assertCaseOwnerOrAdmin(
  user: Principal,
  caseId: number
): Promise<{ ok: true } | { ok: false; code: 'forbidden' | 'not_found' }> {
  const { rows } = await query<{ created_by: number | null }>(
    `SELECT created_by FROM cases WHERE id=$1`,
    [caseId]
  );
  if (!rows.length) return { ok: false, code: 'not_found' };
  if (user.isSystemAdmin) return { ok: true };
  if (rows[0].created_by === user.id) return { ok: true };
  return { ok: false, code: 'forbidden' };
}

/** Summarise a control-number list for the audit log: exact count, capped sample. */
export function summariseControlNumbers(controlNumbers: string[], cap = 50): string {
  const n = controlNumbers.length;
  if (n <= cap) return `${n} document(s): ${controlNumbers.join(', ')}`;
  return `${n} document(s): ${controlNumbers.slice(0, cap).join(', ')} … (+${n - cap} more)`;
}

/** Count the LIVE (not already soft-deleted) documents a delete would affect. */
export async function countLiveDocuments(where: string, params: any[]): Promise<number> {
  const { rows } = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents WHERE deleted_at IS NULL AND ${where}`,
    params
  );
  return rows[0]?.n ?? 0;
}

interface SoftDeleteResult {
  count: number;
  controlNumbers: string[];
}

/** Soft-delete the documents matched by `where`, returning count + control numbers. */
async function softDeleteDocuments(where: string, params: any[]): Promise<SoftDeleteResult> {
  const { rows } = await query<{ control_number: string }>(
    `UPDATE documents
        SET deleted_at = now(),
            retention_until = now() + interval '${RETENTION_DAYS} days'
      WHERE deleted_at IS NULL AND ${where}
      RETURNING control_number`,
    params
  );
  return { count: rows.length, controlNumbers: rows.map((r) => r.control_number) };
}

// ---- Soft-delete operations ------------------------------------------------

/** Soft-delete one document by control number. Returns null if not found/live. */
export async function softDeleteDocument(
  caseId: number,
  controlNumber: string,
  user: Principal
): Promise<SoftDeleteResult | null> {
  const r = await softDeleteDocuments(`case_id=$1 AND control_number=$2`, [caseId, controlNumber]);
  if (r.count === 0) return null;
  await audit({
    userId: user.id, caseId, action: 'document.deleted',
    target: `document:${controlNumber}`,
    detail: `Soft-deleted ${summariseControlNumbers(r.controlNumbers)} (retention ${RETENTION_DAYS} days).`,
  });
  return r;
}

/** Soft-delete every document created by an import (set_id), leaving the case. */
export async function softDeleteImportDocuments(
  caseId: number,
  importId: number,
  user: Principal
): Promise<SoftDeleteResult> {
  const r = await softDeleteDocuments(`case_id=$1 AND set_id=$2`, [caseId, importId]);
  await query(
    `UPDATE loadfile_imports
        SET deleted_at = now(), retention_until = now() + interval '${RETENTION_DAYS} days'
      WHERE id=$1 AND deleted_at IS NULL`,
    [importId]
  );
  await audit({
    userId: user.id, caseId, action: 'import.deleted',
    target: `import:${importId}`,
    detail: `Soft-deleted import ${importId} and its ${summariseControlNumbers(r.controlNumbers)} (retention ${RETENTION_DAYS} days).`,
  });
  return r;
}

/** Soft-delete every document created by a batch, leaving the case. */
export async function softDeleteBatchDocuments(
  caseId: number,
  batchId: string,
  user: Principal
): Promise<SoftDeleteResult> {
  const r = await softDeleteDocuments(
    `case_id=$1 AND id IN (SELECT document_id FROM batch_items WHERE batch_id=$2 AND document_id IS NOT NULL)`,
    [caseId, batchId]
  );
  await audit({
    userId: user.id, caseId, action: 'batch.deleted',
    target: `batch:${batchId}`,
    detail: `Soft-deleted batch ${batchId}'s ${summariseControlNumbers(r.controlNumbers)} (retention ${RETENTION_DAYS} days).`,
  });
  return r;
}

/**
 * Soft-delete a whole case: the case row, its imports, and all its documents.
 * audit_entries (request 8) are deliberately NOT touched — they survive the case
 * delete so the integrator run history remains auditable.
 */
export async function softDeleteCase(caseId: number, user: Principal): Promise<SoftDeleteResult> {
  const r = await softDeleteDocuments(`case_id=$1`, [caseId]);
  await query(
    `UPDATE loadfile_imports SET deleted_at=now(), retention_until=now()+interval '${RETENTION_DAYS} days'
      WHERE case_id=$1 AND deleted_at IS NULL`,
    [caseId]
  );
  await query(
    `UPDATE cases SET deleted_at=now(), retention_until=now()+interval '${RETENTION_DAYS} days'
      WHERE id=$1 AND deleted_at IS NULL`,
    [caseId]
  );
  await audit({
    userId: user.id, caseId, action: 'case.deleted',
    target: `case:${caseId}`,
    detail: `Soft-deleted case ${caseId} with ${summariseControlNumbers(r.controlNumbers)} (retention ${RETENTION_DAYS} days). Case audit entries retained.`,
  });
  return r;
}

// ---- Restore ---------------------------------------------------------------

/**
 * Restore whatever was soft-deleted for a case within the retention window:
 * the case row, its imports and documents whose retention has NOT expired.
 * Returns the number of documents restored, or null when nothing is restorable.
 */
export async function restoreCase(
  caseId: number,
  user: Principal
): Promise<{ docsRestored: number } | { expired: true } | null> {
  const { rows: caseRows } = await query<{ deleted_at: Date | null; retention_until: Date | null }>(
    `SELECT deleted_at, retention_until FROM cases WHERE id=$1`,
    [caseId]
  );
  if (!caseRows.length) return null;
  const c = caseRows[0];
  if (!c.deleted_at) {
    // Case itself is live; still try to restore any soft-deleted docs within window.
  } else if (c.retention_until && new Date(c.retention_until).getTime() < Date.now()) {
    return { expired: true };
  }
  const result = await withTx(async (q) => {
    await q(
      `UPDATE cases SET deleted_at=NULL, retention_until=NULL, restored_at=now(), restored_by=$2
        WHERE id=$1 AND deleted_at IS NOT NULL AND (retention_until IS NULL OR retention_until > now())`,
      [caseId, user.id]
    );
    await q(
      `UPDATE loadfile_imports SET deleted_at=NULL, retention_until=NULL
        WHERE case_id=$1 AND deleted_at IS NOT NULL AND (retention_until IS NULL OR retention_until > now())`,
      [caseId]
    );
    const { rows } = await q(
      `UPDATE documents SET deleted_at=NULL, retention_until=NULL
        WHERE case_id=$1 AND deleted_at IS NOT NULL AND (retention_until IS NULL OR retention_until > now())
        RETURNING control_number`,
      [caseId]
    );
    return rows.length;
  });
  await audit({
    userId: user.id, caseId, action: 'case.restored',
    target: `case:${caseId}`, detail: `Restored case ${caseId} and ${result} document(s) within retention window.`,
  });
  return { docsRestored: result };
}

/** Restore a single document (within window). */
export async function restoreDocument(
  caseId: number,
  controlNumber: string,
  user: Principal
): Promise<{ restored: boolean } | { expired: true } | null> {
  const { rows } = await query<{ deleted_at: Date | null; retention_until: Date | null }>(
    `SELECT deleted_at, retention_until FROM documents WHERE case_id=$1 AND control_number=$2`,
    [caseId, controlNumber]
  );
  if (!rows.length) return null;
  if (!rows[0].deleted_at) return { restored: false };
  if (rows[0].retention_until && new Date(rows[0].retention_until).getTime() < Date.now()) return { expired: true };
  await query(
    `UPDATE documents SET deleted_at=NULL, retention_until=NULL WHERE case_id=$1 AND control_number=$2`,
    [caseId, controlNumber]
  );
  await audit({
    userId: user.id, caseId, action: 'document.restored',
    target: `document:${controlNumber}`, detail: `Restored document ${controlNumber}.`,
  });
  return { restored: true };
}

/** Restore the documents (and the import row) of a soft-deleted import (within window). */
export async function restoreImport(
  caseId: number,
  importId: number,
  user: Principal
): Promise<{ docsRestored: number } | null> {
  const { rows } = await query<{ control_number: string }>(
    `UPDATE documents SET deleted_at=NULL, retention_until=NULL
      WHERE case_id=$1 AND set_id=$2 AND deleted_at IS NOT NULL AND (retention_until IS NULL OR retention_until > now())
      RETURNING control_number`,
    [caseId, importId]
  );
  await query(
    `UPDATE loadfile_imports SET deleted_at=NULL, retention_until=NULL
      WHERE id=$1 AND deleted_at IS NOT NULL AND (retention_until IS NULL OR retention_until > now())`,
    [importId]
  );
  await audit({
    userId: user.id, caseId, action: 'import.restored',
    target: `import:${importId}`, detail: `Restored import ${importId} and ${rows.length} document(s).`,
  });
  return { docsRestored: rows.length };
}

// ---- Async delete job (202 for large cases) --------------------------------

export type DeleteKind = 'case' | 'import' | 'batch' | 'document';

/** Create a running delete job row and return its id. */
export async function createDeleteJob(
  caseId: number, kind: DeleteKind, target: string | null, docsTotal: number, user: Principal
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO delete_jobs (case_id, kind, target, docs_total, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [caseId, kind, target, docsTotal, user.id]
  );
  return rows[0].id;
}

export async function getDeleteJob(jobId: string): Promise<any | null> {
  const { rows } = await query(
    `SELECT id, case_id, kind, target, status, docs_total, docs_done, error, created_at, updated_at
       FROM delete_jobs WHERE id=$1`,
    [jobId]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Run a soft-delete operation in the background, updating the job row. The delete
 * itself is a set of UPDATEs so it is quick; running it off the request keeps the
 * 202 response immediate and consistent with the import/batch async pattern.
 */
export function runDeleteJob(jobId: string, op: () => Promise<SoftDeleteResult>): void {
  (async () => {
    try {
      const r = await op();
      await query(
        `UPDATE delete_jobs SET status='completed', docs_done=$2, docs_total=GREATEST(docs_total,$2), updated_at=now() WHERE id=$1`,
        [jobId, r.count]
      );
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 500);
      await query(`UPDATE delete_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [jobId, msg]).catch(() => { /* ignore */ });
    }
  })();
}

// ---- Purge (permanent removal past retention) ------------------------------

export interface PurgeResult {
  documentsPurged: number;
  importsPurged: number;
  casesPurged: number;
  blobsDecremented: number;
  blobFilesRemoved: number;
}

/**
 * Permanently remove every record whose retention_until has passed, decrementing
 * blob ref-counts for purged documents' native files and deleting any blob file
 * that reaches ref_count 0. Idempotent: safe to run repeatedly and when nothing
 * is due. NOT wired to any scheduler — invoked by scripts/purge-expired.js.
 */
export async function purgeExpired(now: Date = new Date()): Promise<PurgeResult> {
  const result: PurgeResult = {
    documentsPurged: 0, importsPurged: 0, casesPurged: 0, blobsDecremented: 0, blobFilesRemoved: 0,
  };
  const nowIso = now.toISOString();

  // 1. Documents past retention: decrement their native blob, then hard-delete.
  const { rows: docs } = await query<{ id: number; native_sha256: string | null }>(
    `SELECT id, native_sha256 FROM documents
      WHERE deleted_at IS NOT NULL AND retention_until IS NOT NULL AND retention_until < $1`,
    [nowIso]
  );
  for (const d of docs) {
    if (d.native_sha256) {
      const dec = await decrementBlob(d.native_sha256);
      result.blobsDecremented++;
      if (dec.removedFile) result.blobFilesRemoved++;
    }
    await query(`DELETE FROM documents WHERE id=$1`, [d.id]);
    result.documentsPurged++;
  }

  // 2. Imports past retention (their documents are gone via step 1 / cascade).
  const { rows: imps } = await query<{ id: number }>(
    `DELETE FROM loadfile_imports
      WHERE deleted_at IS NOT NULL AND retention_until IS NOT NULL AND retention_until < $1
      RETURNING id`,
    [nowIso]
  );
  result.importsPurged = imps.length;

  // 3. Cases past retention. audit_entries reference the case with ON DELETE
  //    CASCADE, so to KEEP them we detach first, then delete the case.
  const { rows: cs } = await query<{ id: number }>(
    `SELECT id FROM cases WHERE deleted_at IS NOT NULL AND retention_until IS NOT NULL AND retention_until < $1`,
    [nowIso]
  );
  for (const c of cs) {
    // Any remaining documents in the case still hold blob refs — decrement them.
    const { rows: remDocs } = await query<{ id: number; native_sha256: string | null }>(
      `SELECT id, native_sha256 FROM documents WHERE case_id=$1`, [c.id]
    );
    for (const d of remDocs) {
      if (d.native_sha256) {
        const dec = await decrementBlob(d.native_sha256);
        result.blobsDecremented++;
        if (dec.removedFile) result.blobFilesRemoved++;
      }
      result.documentsPurged++;
    }
    result.casesPurged++;
    await query(`DELETE FROM cases WHERE id=$1`, [c.id]);
  }
  return result;
}

/** Decrement a blob's ref_count; when it hits zero, remove the row and the file. */
async function decrementBlob(sha256: string): Promise<{ removedFile: boolean }> {
  const { rows } = await query<{ ref_count: number }>(
    `UPDATE blobs SET ref_count = GREATEST(ref_count - 1, 0) WHERE sha256=$1 RETURNING ref_count`,
    [sha256.toLowerCase()]
  );
  if (!rows.length) return { removedFile: false };
  if (rows[0].ref_count === 0) {
    try { fs.rmSync(blobPath(sha256), { force: true }); } catch { /* best effort */ }
    await query(`DELETE FROM blobs WHERE sha256=$1 AND ref_count=0`, [sha256.toLowerCase()]);
    return { removedFile: true };
  }
  return { removedFile: false };
}
