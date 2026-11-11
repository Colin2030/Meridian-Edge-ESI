import { Router } from 'express';
import { AuthedRequest } from '../middleware/auth';
import { query } from '../db';
import { audit } from '../lib/audit';
import {
  ERROR_CODES, LARGE_DELETE_THRESHOLD, Principal,
  assertCaseOwnerOrAdmin, countLiveDocuments,
  softDeleteCase, softDeleteImportDocuments, softDeleteBatchDocuments, softDeleteDocument,
  restoreCase, restoreImport, restoreDocument,
  createDeleteJob, getDeleteJob, runDeleteJob,
} from '../lib/retention';

// ---------------------------------------------------------------------------
// Delete / archive / retention / restore endpoints (request 10), mounted under
// /api/v1/cases. All require an API token (applied on the v1 router) and are
// allowed ONLY for a system administrator OR the case manager who created the
// case/import — enforced per route by assertCaseOwnerOrAdmin, NOT by the generic
// requireCaseRole (a case_manager who did not create the case cannot delete it).
//
// Deletes are soft (deleted_at + retention_until); a restore within the 7-day
// window brings records back intact. A delete affecting more than
// LARGE_DELETE_THRESHOLD documents returns 202 with a job id to poll. Every
// delete is written to the internal audit_log (who/when/what, with counts and
// control numbers) by the lib/retention helpers.
// ---------------------------------------------------------------------------

const router = Router();

function principal(req: AuthedRequest): Principal {
  return { id: req.user!.id, isSystemAdmin: req.user!.isSystemAdmin };
}

function parseCaseId(req: AuthedRequest, res: any): number | null {
  const caseId = parseInt(req.params.caseId, 10);
  if (!caseId || Number.isNaN(caseId)) {
    res.status(400).json({ code: ERROR_CODES.bad_request, item: 'caseId', error: 'A valid caseId is required.' });
    return null;
  }
  return caseId;
}

/** Guard: resolve caseId + enforce admin-or-owning-manager. Returns caseId or null (response already sent). */
async function guard(req: AuthedRequest, res: any): Promise<number | null> {
  const caseId = parseCaseId(req, res);
  if (caseId === null) return null;
  const perm = await assertCaseOwnerOrAdmin(principal(req), caseId);
  if (!perm.ok) {
    const status = perm.code === 'not_found' ? 404 : 403;
    res.status(status).json({
      code: perm.code === 'not_found' ? ERROR_CODES.not_found : ERROR_CODES.forbidden,
      item: `case:${caseId}`,
      error: perm.code === 'not_found'
        ? 'Case not found.'
        : 'Only a system administrator or the case manager who created this case may perform this action.',
    });
    return null;
  }
  return caseId;
}

// ---- PATCH /cases/:caseId — archive / un-archive ----------------------------
router.patch('/:caseId', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const status = (req.body && req.body.status) || '';
    if (status !== 'archived' && status !== 'open') {
      return res.status(400).json({
        code: ERROR_CODES.invalid_status, item: `case:${caseId}`,
        error: `Unsupported status "${status}". Use "archived" to archive or "open" to un-archive.`,
      });
    }
    const { rows } = await query<{ id: number }>(`SELECT id FROM cases WHERE id=$1 AND deleted_at IS NULL`, [caseId]);
    if (!rows.length) return res.status(404).json({ code: ERROR_CODES.not_found, item: `case:${caseId}`, error: 'Case not found.' });

    if (status === 'archived') {
      await query(`UPDATE cases SET status='archived', archived_at=now() WHERE id=$1`, [caseId]);
    } else {
      await query(`UPDATE cases SET status='open', archived_at=NULL WHERE id=$1`, [caseId]);
    }
    await audit({
      userId: req.user!.id, caseId, action: status === 'archived' ? 'case.archived' : 'case.unarchived',
      target: `case:${caseId}`, detail: status === 'archived' ? 'Case archived (hidden from active lists; nothing removed).' : 'Case un-archived.',
    });
    res.json({ id: caseId, status });
  } catch (e) { next(e); }
});

// ---- DELETE /cases/:caseId — soft-delete the whole case ---------------------
router.delete('/:caseId', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const total = await countLiveDocuments('case_id=$1', [caseId]);
    if (total > LARGE_DELETE_THRESHOLD) {
      const jobId = await createDeleteJob(caseId, 'case', `case:${caseId}`, total, principal(req));
      runDeleteJob(jobId, () => softDeleteCase(caseId, principal(req)));
      return res.status(202).json({ jobId, kind: 'case', status: 'running', docsTotal: total, pollUrl: `/api/v1/jobs/${jobId}` });
    }
    const r = await softDeleteCase(caseId, principal(req));
    res.status(200).json({ caseId, deleted: true, documentsDeleted: r.count, retentionDays: 7 });
  } catch (e) { next(e); }
});

// ---- DELETE /cases/:caseId/imports/:importId — soft-delete import's docs -----
router.delete('/:caseId/imports/:importId', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const importId = parseInt(req.params.importId, 10);
    if (!importId) return res.status(400).json({ code: ERROR_CODES.bad_request, item: 'importId', error: 'A valid importId is required.' });
    const { rows } = await query(`SELECT id FROM loadfile_imports WHERE id=$1 AND case_id=$2`, [importId, caseId]);
    if (!rows.length) return res.status(404).json({ code: ERROR_CODES.not_found, item: `import:${importId}`, error: 'Import not found in this case.' });

    const total = await countLiveDocuments('case_id=$1 AND set_id=$2', [caseId, importId]);
    if (total > LARGE_DELETE_THRESHOLD) {
      const jobId = await createDeleteJob(caseId, 'import', `import:${importId}`, total, principal(req));
      runDeleteJob(jobId, () => softDeleteImportDocuments(caseId, importId, principal(req)));
      return res.status(202).json({ jobId, kind: 'import', status: 'running', docsTotal: total, pollUrl: `/api/v1/jobs/${jobId}` });
    }
    const r = await softDeleteImportDocuments(caseId, importId, principal(req));
    res.status(200).json({ caseId, importId, deleted: true, documentsDeleted: r.count, retentionDays: 7 });
  } catch (e) { next(e); }
});

// ---- DELETE /cases/:caseId/batches/:batchId — soft-delete batch's docs ------
router.delete('/:caseId/batches/:batchId', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const batchId = String(req.params.batchId);
    const { rows } = await query(`SELECT id FROM batches WHERE id=$1 AND case_id=$2`, [batchId, caseId]);
    if (!rows.length) return res.status(404).json({ code: ERROR_CODES.not_found, item: `batch:${batchId}`, error: 'Batch not found in this case.' });

    const total = await countLiveDocuments(
      'case_id=$1 AND id IN (SELECT document_id FROM batch_items WHERE batch_id=$2 AND document_id IS NOT NULL)',
      [caseId, batchId]
    );
    if (total > LARGE_DELETE_THRESHOLD) {
      const jobId = await createDeleteJob(caseId, 'batch', `batch:${batchId}`, total, principal(req));
      runDeleteJob(jobId, () => softDeleteBatchDocuments(caseId, batchId, principal(req)));
      return res.status(202).json({ jobId, kind: 'batch', status: 'running', docsTotal: total, pollUrl: `/api/v1/jobs/${jobId}` });
    }
    const r = await softDeleteBatchDocuments(caseId, batchId, principal(req));
    res.status(200).json({ caseId, batchId, deleted: true, documentsDeleted: r.count, retentionDays: 7 });
  } catch (e) { next(e); }
});

// ---- DELETE /cases/:caseId/documents/:controlNumber — one document ----------
router.delete('/:caseId/documents/:controlNumber', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const controlNumber = decodeURIComponent(req.params.controlNumber);
    const r = await softDeleteDocument(caseId, controlNumber, principal(req));
    if (!r) return res.status(404).json({ code: ERROR_CODES.not_found, item: `document:${controlNumber}`, error: 'Document not found or already deleted.' });
    res.status(200).json({ caseId, controlNumber, deleted: true, documentsDeleted: r.count, retentionDays: 7 });
  } catch (e) { next(e); }
});

// ---- POST /cases/:caseId/restore — restore case (+ its imports/docs) --------
router.post('/:caseId/restore', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const r = await restoreCase(caseId, principal(req));
    if (r === null) return res.status(404).json({ code: ERROR_CODES.not_found, item: `case:${caseId}`, error: 'Case not found.' });
    if ('expired' in r) return res.status(410).json({ code: ERROR_CODES.retention_expired, item: `case:${caseId}`, error: 'The retention window for this case has expired; it can no longer be restored.' });
    res.json({ caseId, restored: true, documentsRestored: r.docsRestored });
  } catch (e) { next(e); }
});

// ---- POST /cases/:caseId/imports/:importId/restore --------------------------
router.post('/:caseId/imports/:importId/restore', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const importId = parseInt(req.params.importId, 10);
    if (!importId) return res.status(400).json({ code: ERROR_CODES.bad_request, item: 'importId', error: 'A valid importId is required.' });
    const r = await restoreImport(caseId, importId, principal(req));
    if (!r) return res.status(404).json({ code: ERROR_CODES.not_found, item: `import:${importId}`, error: 'Import not found.' });
    res.json({ caseId, importId, restored: true, documentsRestored: r.docsRestored });
  } catch (e) { next(e); }
});

// ---- POST /cases/:caseId/documents/:controlNumber/restore -------------------
router.post('/:caseId/documents/:controlNumber/restore', async (req: AuthedRequest, res, next) => {
  try {
    const caseId = await guard(req, res);
    if (caseId === null) return;
    const controlNumber = decodeURIComponent(req.params.controlNumber);
    const r = await restoreDocument(caseId, controlNumber, principal(req));
    if (r === null) return res.status(404).json({ code: ERROR_CODES.not_found, item: `document:${controlNumber}`, error: 'Document not found.' });
    if ('expired' in r) return res.status(410).json({ code: ERROR_CODES.retention_expired, item: `document:${controlNumber}`, error: 'The retention window for this document has expired.' });
    if (!r.restored) return res.status(409).json({ code: ERROR_CODES.nothing_to_restore, item: `document:${controlNumber}`, error: 'Document is not deleted; nothing to restore.' });
    res.json({ caseId, controlNumber, restored: true });
  } catch (e) { next(e); }
});

export default router;

// ---- GET /api/v1/jobs/:jobId — poll a delete job ----------------------------
// Exported separately so it can be mounted at the /api/v1 root (not under /cases).
export const jobsRouter = Router();
jobsRouter.get('/jobs/:jobId', async (req: AuthedRequest, res, next) => {
  try {
    const job = await getDeleteJob(String(req.params.jobId));
    if (!job) return res.status(404).json({ code: ERROR_CODES.not_found, item: `job:${req.params.jobId}`, error: 'Job not found.' });
    // Caller must be admin or the owning case manager of the job's case.
    const perm = await assertCaseOwnerOrAdmin(principal(req), job.case_id);
    if (!perm.ok) return res.status(403).json({ code: ERROR_CODES.forbidden, item: `job:${job.id}`, error: 'Not permitted to view this job.' });
    res.json({
      jobId: job.id, caseId: job.case_id, kind: job.kind, target: job.target,
      status: job.status, docsTotal: job.docs_total, docsDone: job.docs_done,
      error: job.error, createdAt: job.created_at, updatedAt: job.updated_at,
    });
  } catch (e) { next(e); }
});
