import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { query } from '../db';
import { config } from '../config';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';
import * as blobStore from '../lib/blobStore';
import { buildStatus } from '../lib/batchRunner';
import {
  ERROR_CODES, LARGE_DELETE_THRESHOLD, Principal,
  assertCaseOwnerOrAdmin, countLiveDocuments,
  softDeleteCase, softDeleteImportDocuments, softDeleteDocument,
  createDeleteJob, getDeleteJob, runDeleteJob,
} from '../lib/retention';

// ---------------------------------------------------------------------------
// Session-authed (cookie) web endpoints that surface the v1.4.0 "Remontoire"
// features to the logged-in SPA. These mirror the token-only /api/v1 endpoints
// but authenticate with the browser session and REUSE the same underlying lib
// logic (retention.ts, blobStore, batchRunner, document_text queries) — no
// business rule is duplicated here. Mounted under /api/cases.
// ---------------------------------------------------------------------------

const router = Router();

function principal(req: AuthedRequest): Principal {
  return { id: req.user!.id, isSystemAdmin: req.user!.isSystemAdmin };
}

/** Guard reused by archive/delete: admin OR owning case manager (same rule as /api/v1). */
async function ownerGuard(req: AuthedRequest, res: any, caseId: number): Promise<boolean> {
  const perm = await assertCaseOwnerOrAdmin(principal(req), caseId);
  if (!perm.ok) {
    res.status(perm.code === 'not_found' ? 404 : 403).json({
      error: perm.code === 'not_found'
        ? 'Case not found.'
        : 'Only a system administrator or the case manager who created this case may do this.',
    });
    return false;
  }
  return true;
}

// ---- #1 Translations: list a document's text versions (read_only+) ----------
// Returns every document_text version with its language/kind/original flag and
// the text content inline (resolved from the blob store when stored by ref), so
// the viewer can switch versions without a further round-trip.
router.get('/:caseId/documents/:docId/text-versions', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const docId = parseInt(req.params.docId, 10);
  const { rows: drows } = await query<any>(`SELECT id FROM documents WHERE id=$1 AND case_id=$2`, [docId, caseId]);
  if (!drows.length) return res.status(404).json({ error: 'Document not found' });
  const { rows } = await query<any>(
    `SELECT id, language, kind, is_original, translated_from, method,
            blob_sha256, text_content, char_length
       FROM document_text WHERE document_id=$1
      ORDER BY is_original DESC, kind ASC, language ASC`,
    [docId]
  );
  const versions = rows.map((r) => {
    let content: string | null = r.text_content ?? null;
    if (content == null && r.blob_sha256) {
      const buf = blobStore.get(r.blob_sha256);
      content = buf ? buf.toString('utf8') : null;
    }
    return {
      id: r.id,
      language: r.language,
      kind: r.kind,
      isOriginal: r.is_original,
      translatedFrom: r.translated_from,
      method: r.method,
      charLength: r.char_length,
      content,
    };
  });
  res.json({ versions });
});

// ---- #3 Family: parent email + its attachments (read_only+) -----------------
// Builds the family from the explicit parent_control_number link. Flags a
// document whose declared parent is not present in the case.
router.get('/:caseId/documents/:docId/family', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const docId = parseInt(req.params.docId, 10);
  const { rows: drows } = await query<any>(
    `SELECT id, control_number, parent_control_number FROM documents WHERE id=$1 AND case_id=$2`,
    [docId, caseId]
  );
  if (!drows.length) return res.status(404).json({ error: 'Document not found' });
  const self = drows[0];

  // The parent control number of the family: this doc's parent, or itself if it is a parent.
  const parentCn: string | null = self.parent_control_number || null;

  let parent: any = null;
  let parentNotFound = false;
  if (parentCn) {
    const { rows: prows } = await query<any>(
      `SELECT id, control_number, native_type, metadata FROM documents
        WHERE case_id=$1 AND control_number=$2 AND deleted_at IS NULL`,
      [caseId, parentCn]
    );
    if (prows.length) parent = prows[0];
    else parentNotFound = true;
  }

  // The family root: the parent if known, else this document (which may itself be the parent).
  const rootCn = parent ? parent.control_number : (parentCn ? null : self.control_number);

  let attachments: any[] = [];
  if (rootCn) {
    attachments = (await query<any>(
      `SELECT id, control_number, native_type, native_filename, metadata FROM documents
        WHERE case_id=$1 AND parent_control_number=$2 AND deleted_at IS NULL
        ORDER BY control_number ASC`,
      [caseId, rootCn]
    )).rows;
  }

  res.json({
    controlNumber: self.control_number,
    parentControlNumber: parentCn,
    parentNotFound,
    parent: parent ? {
      id: parent.id, controlNumber: parent.control_number,
      nativeType: parent.native_type, metadata: parent.metadata,
    } : null,
    attachments: attachments.map((a) => ({
      id: a.id, controlNumber: a.control_number, nativeType: a.native_type,
      nativeFilename: a.native_filename, metadata: a.metadata,
      current: a.id === self.id,
    })),
    isFamily: !!parent || parentNotFound || attachments.length > 0,
  });
});

// ---- #4 Native download with original filename + declared/detected type -----
router.get('/:caseId/documents/:docId/native', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(
    `SELECT native_sha256, native_storage_name, native_filename, native_mime, native_type, native_path, control_number
       FROM documents WHERE id=$1 AND case_id=$2`,
    [docId, caseId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const d = rows[0];
  const downloadName = d.native_filename || d.native_storage_name || `${d.control_number}`;
  const mime = d.native_mime || 'application/octet-stream';

  // Preferred: content-addressed blob store (batch-ingested natives).
  if (d.native_sha256) {
    const p = blobStore.getPath(d.native_sha256);
    if (p && fs.existsSync(p)) {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
      return res.sendFile(p);
    }
  }
  // Legacy: native stored on disk under the uploads dir (loadfile imports).
  if (d.native_path) {
    const abs = path.normalize(path.join(config.uploadsDir, d.native_path));
    if (abs.startsWith(config.uploadsDir + path.sep) && fs.existsSync(abs)) {
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
      return res.sendFile(abs);
    }
  }
  return res.status(404).json({ error: 'No native file is available for this document.' });
});

// ---- #5/#8 Combined case history: platform events + integrator audit entries -
router.get('/:caseId/history', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  // Platform lifecycle events from the internal audit_log (imports, delete/archive,
  // and the posting of integrator entries). Exclude high-volume view/review noise.
  const { rows: platform } = await query<any>(
    `SELECT a.id, a.action, a.target, a.detail, a.created_at, u.display_name AS actor
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.case_id=$1
        AND (a.action LIKE 'import%' OR a.action LIKE 'batch%'
             OR a.action IN ('case.archived','case.unarchived','case_created','audit_entry.created')
             OR a.action LIKE '%deleted' OR a.action LIKE '%.failed' OR a.action LIKE '%.completed'
             OR a.action LIKE 'case.%' OR a.action LIKE 'document.%')
      ORDER BY a.created_at DESC
      LIMIT 500`,
    [caseId]
  );

  // Integrator audit entries (request 8) with their downloadable attachments.
  const { rows: entries } = await query<any>(
    `SELECT e.id, e.event_type, e.occurred_at, e.summary,
            e.source_system, e.source_version, e.source_run_id,
            e.import_id, e.batch_id, e.posted_at, u.display_name AS posted_by
       FROM audit_entries e LEFT JOIN users u ON u.id = e.posted_by
      WHERE e.case_id=$1 ORDER BY e.posted_at DESC`,
    [caseId]
  );
  let attByEntry: Record<string, any[]> = {};
  if (entries.length) {
    const ids = entries.map((e) => e.id);
    const { rows: atts } = await query<any>(
      `SELECT id, entry_id, filename, mime_type, byte_size FROM audit_entry_attachments
        WHERE entry_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [ids]
    );
    for (const a of atts) {
      (attByEntry[a.entry_id] ||= []).push({
        id: a.id, filename: a.filename, mime: a.mime_type,
        size: a.byte_size != null ? Number(a.byte_size) : null,
      });
    }
  }

  const events = [
    ...platform.map((p) => ({
      kind: 'platform' as const,
      id: `p${p.id}`,
      at: p.created_at,
      action: p.action,
      title: p.action,
      detail: p.detail,
      target: p.target,
      actor: p.actor,
    })),
    ...entries.map((e) => ({
      kind: 'integrator' as const,
      id: `e${e.id}`,
      entryId: e.id,
      at: e.occurred_at || e.posted_at,
      occurredAt: e.occurred_at,
      postedAt: e.posted_at,
      action: e.event_type,
      title: e.event_type,
      detail: e.summary,
      source: { system: e.source_system, version: e.source_version, runId: e.source_run_id },
      importId: e.import_id,
      batchId: e.batch_id,
      postedBy: e.posted_by,
      attachments: attByEntry[e.id] || [],
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  res.json({ events });
});

// ---- #8 Session-authed download of an integrator report attachment ----------
router.get('/:caseId/audit-entries/:entryId/attachments/:attachmentId', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { entryId, attachmentId } = req.params;
  const { rows } = await query<{ filename: string; mime_type: string | null; blob_sha256: string | null }>(
    `SELECT a.filename, a.mime_type, a.blob_sha256
       FROM audit_entry_attachments a JOIN audit_entries e ON e.id = a.entry_id
      WHERE a.id=$1 AND a.entry_id=$2 AND e.case_id=$3`,
    [attachmentId, entryId, caseId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Attachment not found.' });
  const a = rows[0];
  const p = a.blob_sha256 ? blobStore.getPath(a.blob_sha256) : null;
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Attachment content not available.' });
  res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.filename)}"`);
  res.sendFile(p);
});

// ---- #6/#9/#11 Batch verification + progress (read_only+) --------------------
router.get('/:caseId/batches', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT * FROM batches WHERE case_id=$1 ORDER BY created_at DESC LIMIT 100`, [caseId]
  );
  res.json({ batches: rows.map((b) => buildStatus(b)) });
});
router.get('/:caseId/batches/:batchId', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(`SELECT * FROM batches WHERE id=$1 AND case_id=$2`, [req.params.batchId, caseId]);
  if (!rows.length) return res.status(404).json({ error: 'Batch not found' });
  res.json(buildStatus(rows[0]));
});

// ---- #10 Archive / un-archive a case (admin or owning manager) --------------
router.patch('/:caseId/status', requireAuth, async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  if (!caseId) return res.status(400).json({ error: 'A valid caseId is required.' });
  if (!(await ownerGuard(req, res, caseId))) return;
  const status = (req.body && req.body.status) || '';
  if (status !== 'archived' && status !== 'open') {
    return res.status(400).json({ error: 'Use "archived" to archive or "open" to un-archive.' });
  }
  const { rows } = await query<any>(`SELECT id FROM cases WHERE id=$1 AND deleted_at IS NULL`, [caseId]);
  if (!rows.length) return res.status(404).json({ error: 'Case not found.' });
  if (status === 'archived') await query(`UPDATE cases SET status='archived', archived_at=now() WHERE id=$1`, [caseId]);
  else await query(`UPDATE cases SET status='open', archived_at=NULL WHERE id=$1`, [caseId]);
  await audit({
    userId: req.user!.id, caseId, action: status === 'archived' ? 'case.archived' : 'case.unarchived',
    target: `case:${caseId}`, detail: status === 'archived' ? 'Case archived from the web UI.' : 'Case un-archived from the web UI.',
  });
  res.json({ id: caseId, status });
});

// ---- #10 Delete a whole case (soft, 7-day retention) ------------------------
router.delete('/:caseId', requireAuth, async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  if (!caseId) return res.status(400).json({ error: 'A valid caseId is required.' });
  if (!(await ownerGuard(req, res, caseId))) return;
  const total = await countLiveDocuments('case_id=$1', [caseId]);
  if (total > LARGE_DELETE_THRESHOLD) {
    const jobId = await createDeleteJob(caseId, 'case', `case:${caseId}`, total, principal(req));
    runDeleteJob(jobId, () => softDeleteCase(caseId, principal(req)));
    return res.status(202).json({ jobId, kind: 'case', status: 'running', docsTotal: total, pollUrl: `/api/cases/jobs/${jobId}`, retentionDays: 7 });
  }
  const r = await softDeleteCase(caseId, principal(req));
  res.json({ caseId, deleted: true, documentsDeleted: r.count, retentionDays: 7 });
});

// ---- #10 Delete one import's documents --------------------------------------
router.delete('/:caseId/imports/:importId', requireAuth, async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const importId = parseInt(req.params.importId, 10);
  if (!caseId || !importId) return res.status(400).json({ error: 'Valid caseId and importId are required.' });
  if (!(await ownerGuard(req, res, caseId))) return;
  const { rows } = await query(`SELECT id FROM loadfile_imports WHERE id=$1 AND case_id=$2`, [importId, caseId]);
  if (!rows.length) return res.status(404).json({ error: 'Import not found in this case.' });
  const total = await countLiveDocuments('case_id=$1 AND set_id=$2', [caseId, importId]);
  if (total > LARGE_DELETE_THRESHOLD) {
    const jobId = await createDeleteJob(caseId, 'import', `import:${importId}`, total, principal(req));
    runDeleteJob(jobId, () => softDeleteImportDocuments(caseId, importId, principal(req)));
    return res.status(202).json({ jobId, kind: 'import', status: 'running', docsTotal: total, pollUrl: `/api/cases/jobs/${jobId}`, retentionDays: 7 });
  }
  const r = await softDeleteImportDocuments(caseId, importId, principal(req));
  res.json({ caseId, importId, deleted: true, documentsDeleted: r.count, retentionDays: 7 });
});

// ---- #10 Delete one document (by id, resolved to control number) ------------
router.delete('/:caseId/documents/:docId', requireAuth, async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const docId = parseInt(req.params.docId, 10);
  if (!caseId || !docId) return res.status(400).json({ error: 'Valid caseId and docId are required.' });
  if (!(await ownerGuard(req, res, caseId))) return;
  const { rows } = await query<any>(`SELECT control_number FROM documents WHERE id=$1 AND case_id=$2`, [docId, caseId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found.' });
  const r = await softDeleteDocument(caseId, rows[0].control_number, principal(req));
  if (!r) return res.status(404).json({ error: 'Document not found or already deleted.' });
  res.json({ caseId, docId, controlNumber: rows[0].control_number, deleted: true, documentsDeleted: r.count, retentionDays: 7 });
});

// ---- Poll a (large) delete job started above --------------------------------
router.get('/jobs/:jobId', requireAuth, async (req: AuthedRequest, res) => {
  const job = await getDeleteJob(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  const perm = await assertCaseOwnerOrAdmin(principal(req), job.case_id);
  if (!perm.ok) return res.status(403).json({ error: 'Not permitted to view this job.' });
  res.json({
    jobId: job.id, caseId: job.case_id, kind: job.kind, status: job.status,
    docsTotal: job.docs_total, docsDone: job.docs_done, error: job.error,
  });
});

export default router;
