import { Router } from 'express';
import { query } from '../db';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
// Binders — named groupings of documents within a case. A binder can be
// allocated to a reviewer (assignee) and shared via its own URL. Mounted under
// /api/cases, so the paths below are /api/cases/:caseId/binders...
// ---------------------------------------------------------------------------

/** Confirm a binder exists AND belongs to :caseId. Returns the row or null. */
async function loadBinder(caseId: number, binderId: number) {
  if (!binderId || Number.isNaN(binderId)) return null;
  const { rows } = await query<any>(
    `SELECT id, case_id, name, description, assigned_to, created_by, created_at, updated_at
     FROM binders WHERE id=$1 AND case_id=$2`,
    [binderId, caseId]
  );
  return rows.length ? rows[0] : null;
}

/** Validate that a user is a member of the case (used for assignee validation). */
async function isCaseMember(caseId: number, userId: number): Promise<boolean> {
  const { rowCount } = await query(
    `SELECT 1 FROM case_memberships WHERE case_id=$1 AND user_id=$2`,
    [caseId, userId]
  );
  return (rowCount ?? 0) > 0;
}

// ---- Candidate assignees (reviewer+) ---------------------------------------
// Lists the case's members so the UI can offer them as binder assignees. Must
// be registered BEFORE the '/:binderId' route so 'assignees' isn't treated as
// a binder id.
router.get('/:caseId/binders/assignees', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT m.user_id AS id, u.display_name, u.username, m.role
     FROM case_memberships m JOIN users u ON u.id=m.user_id
     WHERE m.case_id=$1 AND u.active=TRUE
     ORDER BY u.display_name`,
    [caseId]
  );
  res.json(rows);
});

// ---- List binders (read_only+) ---------------------------------------------
router.get('/:caseId/binders', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT b.id, b.name, b.description, b.assigned_to, b.created_by, b.created_at, b.updated_at,
            (SELECT count(*)::int FROM binder_documents bd WHERE bd.binder_id=b.id) AS doc_count,
            au.display_name AS assignee_name,
            cu.display_name AS creator_name
     FROM binders b
     LEFT JOIN users au ON au.id=b.assigned_to
     LEFT JOIN users cu ON cu.id=b.created_by
     WHERE b.case_id=$1
     ORDER BY b.created_at DESC`,
    [caseId]
  );
  res.json(rows);
});

// ---- Create a binder (reviewer+) -------------------------------------------
router.post('/:caseId/binders', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const name = (req.body?.name || '').toString().trim();
  const description = req.body?.description != null ? req.body.description.toString().trim() : null;
  const assignedToRaw = req.body?.assignedTo;
  if (!name) return res.status(400).json({ error: 'A binder name is required' });

  let assignedTo: number | null = null;
  if (assignedToRaw != null && assignedToRaw !== '') {
    assignedTo = parseInt(assignedToRaw, 10);
    if (Number.isNaN(assignedTo)) return res.status(400).json({ error: 'Invalid assignee' });
    if (!(await isCaseMember(caseId, assignedTo)))
      return res.status(400).json({ error: 'Assignee must be a member of this case' });
  }

  const { rows } = await query<any>(
    `INSERT INTO binders (case_id, name, description, assigned_to, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, name, description, assigned_to, created_by, created_at, updated_at`,
    [caseId, name, description || null, assignedTo, req.user!.id]
  );
  const binder = rows[0];
  await audit({ userId: req.user!.id, caseId, action: 'binder.created', target: `binder:${binder.id}`, detail: name });
  if (assignedTo) {
    await audit({ userId: req.user!.id, caseId, action: 'binder.assigned', target: `binder:${binder.id}`, detail: `assigned_to:${assignedTo}` });
  }
  res.status(201).json(binder);
});

// ---- Binder detail + its documents (read_only+) ----------------------------
// Reuses the same document-list projection as the main document list so the
// binder contents render with identical columns. Supports limit/offset paging.
router.get('/:caseId/binders/:binderId', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const binderId = parseInt(req.params.binderId, 10);
  const binder = await loadBinder(caseId, binderId);
  if (!binder) return res.status(404).json({ error: 'Binder not found' });

  const { rows: meta } = await query<any>(
    `SELECT b.id, b.name, b.description, b.assigned_to, b.created_by, b.created_at, b.updated_at,
            au.display_name AS assignee_name,
            cu.display_name AS creator_name
     FROM binders b
     LEFT JOIN users au ON au.id=b.assigned_to
     LEFT JOIN users cu ON cu.id=b.created_by
     WHERE b.id=$1`,
    [binderId]
  );

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const total = (await query<any>(
    `SELECT count(*)::int AS total FROM binder_documents WHERE binder_id=$1`, [binderId]
  )).rows[0].total;

  const { rows: documents } = await query<any>(
    `SELECT d.id, d.control_number, d.native_type, d.native_mime, d.native_filename, d.page_count, d.has_text, d.created_at,
            d.metadata, rs.status AS review_status, bd.added_at,
            EXISTS (SELECT 1 FROM bookmarks b WHERE b.document_id=d.id AND b.user_id=$2) AS bookmarked,
            COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'colour',t.colour))
                      FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id), '[]') AS tags
     FROM binder_documents bd
     JOIN documents d ON d.id=bd.document_id
     LEFT JOIN review_states rs ON rs.document_id=d.id
     WHERE bd.binder_id=$1 AND d.case_id=$3
     ORDER BY d.control_number ASC
     LIMIT $4 OFFSET $5`,
    [binderId, req.user!.id, caseId, limit, offset]
  );

  res.json({ binder: meta[0], total, limit, offset, documents });
});

// ---- Update a binder (reviewer+) -------------------------------------------
// Reviewer+ may edit (the assignee is a reviewer; case_manager+ included).
router.patch('/:caseId/binders/:binderId', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const binderId = parseInt(req.params.binderId, 10);
  const binder = await loadBinder(caseId, binderId);
  if (!binder) return res.status(404).json({ error: 'Binder not found' });

  const sets: string[] = [];
  const params: any[] = [];
  let assignmentChanged = false;
  let newAssignee: number | null = binder.assigned_to;

  if (req.body?.name !== undefined) {
    const name = (req.body.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'A binder name is required' });
    params.push(name); sets.push(`name=$${params.length}`);
  }
  if (req.body?.description !== undefined) {
    const description = req.body.description != null ? req.body.description.toString().trim() : null;
    params.push(description || null); sets.push(`description=$${params.length}`);
  }
  if (req.body?.assignedTo !== undefined) {
    const raw = req.body.assignedTo;
    if (raw === null || raw === '') {
      newAssignee = null;
    } else {
      const a = parseInt(raw, 10);
      if (Number.isNaN(a)) return res.status(400).json({ error: 'Invalid assignee' });
      if (!(await isCaseMember(caseId, a)))
        return res.status(400).json({ error: 'Assignee must be a member of this case' });
      newAssignee = a;
    }
    assignmentChanged = newAssignee !== binder.assigned_to;
    params.push(newAssignee); sets.push(`assigned_to=$${params.length}`);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  sets.push(`updated_at=now()`);
  params.push(binderId);
  const { rows } = await query<any>(
    `UPDATE binders SET ${sets.join(', ')} WHERE id=$${params.length}
     RETURNING id, name, description, assigned_to, created_by, created_at, updated_at`,
    params
  );
  await audit({ userId: req.user!.id, caseId, action: 'binder.updated', target: `binder:${binderId}` });
  if (assignmentChanged) {
    await audit({ userId: req.user!.id, caseId, action: 'binder.assigned', target: `binder:${binderId}`, detail: newAssignee ? `assigned_to:${newAssignee}` : 'unassigned' });
  }
  res.json(rows[0]);
});

// ---- Delete a binder (case_manager+ OR the creator) ------------------------
router.delete('/:caseId/binders/:binderId', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const role = (req as any).caseRole;
  const binderId = parseInt(req.params.binderId, 10);
  const binder = await loadBinder(caseId, binderId);
  if (!binder) return res.status(404).json({ error: 'Binder not found' });

  const isManager = role === 'case_manager' || role === 'system_admin';
  if (!isManager && binder.created_by !== req.user!.id)
    return res.status(403).json({ error: 'Only the binder creator or a case manager can delete this binder' });

  // Removes the join rows via ON DELETE CASCADE; documents are NOT deleted.
  await query(`DELETE FROM binders WHERE id=$1`, [binderId]);
  await audit({ userId: req.user!.id, caseId, action: 'binder.deleted', target: `binder:${binderId}`, detail: binder.name });
  res.json({ ok: true });
});

// ---- Bulk-add documents to a binder (reviewer+) ----------------------------
// Body { documentIds: number[] }. Skips documents already present and any id
// that is not a document of this case. Returns { added, skipped }.
router.post('/:caseId/binders/:binderId/documents', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const binderId = parseInt(req.params.binderId, 10);
  const binder = await loadBinder(caseId, binderId);
  if (!binder) return res.status(404).json({ error: 'Binder not found' });

  const ids: number[] = Array.isArray(req.body?.documentIds)
    ? Array.from(new Set(req.body.documentIds.map((x: any) => parseInt(x, 10)).filter((n: number) => !Number.isNaN(n))))
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'documentIds (array) required' });

  // Only consider ids that actually belong to this case.
  const { rows: valid } = await query<any>(
    `SELECT id FROM documents WHERE case_id=$1 AND id = ANY($2::int[])`,
    [caseId, ids]
  );
  const validIds = valid.map((r) => r.id);
  const requested = ids.length;

  let added = 0;
  if (validIds.length > 0) {
    const { rowCount } = await query(
      `INSERT INTO binder_documents (binder_id, document_id, added_by)
       SELECT $1, x, $2 FROM unnest($3::int[]) AS x
       ON CONFLICT (binder_id, document_id) DO NOTHING`,
      [binderId, req.user!.id, validIds]
    );
    added = rowCount ?? 0;
  }
  const skipped = requested - added;

  await audit({ userId: req.user!.id, caseId, action: 'binder.documents_added', target: `binder:${binderId}`, detail: `added=${added} skipped=${skipped}` });
  res.json({ added, skipped, requested });
});

// ---- Bulk-remove documents from a binder (reviewer+) -----------------------
// Registered before the single-doc DELETE route; path can't collide because
// 'remove' is a sub-path of /documents.
router.post('/:caseId/binders/:binderId/documents/remove', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const binderId = parseInt(req.params.binderId, 10);
  const binder = await loadBinder(caseId, binderId);
  if (!binder) return res.status(404).json({ error: 'Binder not found' });

  const ids: number[] = Array.isArray(req.body?.documentIds)
    ? Array.from(new Set(req.body.documentIds.map((x: any) => parseInt(x, 10)).filter((n: number) => !Number.isNaN(n))))
    : [];
  if (ids.length === 0) return res.status(400).json({ error: 'documentIds (array) required' });

  const { rowCount } = await query(
    `DELETE FROM binder_documents WHERE binder_id=$1 AND document_id = ANY($2::int[])`,
    [binderId, ids]
  );
  const removed = rowCount ?? 0;
  await audit({ userId: req.user!.id, caseId, action: 'binder.document_removed', target: `binder:${binderId}`, detail: `removed=${removed}` });
  res.json({ removed });
});

// ---- Remove a single document from a binder (reviewer+) --------------------
router.delete('/:caseId/binders/:binderId/documents/:documentId', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const binderId = parseInt(req.params.binderId, 10);
  const documentId = parseInt(req.params.documentId, 10);
  const binder = await loadBinder(caseId, binderId);
  if (!binder) return res.status(404).json({ error: 'Binder not found' });

  const { rowCount } = await query(
    `DELETE FROM binder_documents WHERE binder_id=$1 AND document_id=$2`,
    [binderId, documentId]
  );
  await audit({ userId: req.user!.id, caseId, action: 'binder.document_removed', target: `binder:${binderId}`, detail: `doc:${documentId}` });
  res.json({ removed: rowCount ?? 0 });
});

export default router;
