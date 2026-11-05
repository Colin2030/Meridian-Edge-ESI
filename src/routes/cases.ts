import { Router } from 'express';
import ExcelJS from 'exceljs';
import { query, withTx } from '../db';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireCaseRole, getCaseRole, requireCanCreateCases } from '../middleware/auth';
import { fileTypeExtSql } from '../lib/fileType';

const router = Router();

// List cases the user can access, with counts.
// Exported so the token-auth /api/v1 route returns the IDENTICAL case list.
export const listCasesHandler = async (req: AuthedRequest, res: any) => {
  const u = req.user!;
  const params: any[] = [];
  let whereCase = '';
  if (!u.isSystemAdmin) {
    params.push(u.id);
    whereCase = `WHERE c.id IN (SELECT case_id FROM case_memberships WHERE user_id=$1)`;
  }
  const { rows } = await query<any>(
    `SELECT c.id, c.name, c.case_number, c.description, c.status, c.created_at,
            (SELECT count(*) FROM documents d WHERE d.case_id=c.id)::int AS doc_count,
            (SELECT count(*) FROM review_states r WHERE r.case_id=c.id AND r.status NOT IN ('unreviewed'))::int AS reviewed_count,
            (SELECT count(*) FROM bookmarks b WHERE b.case_id=c.id AND b.user_id=$${u.isSystemAdmin ? 1 : 2})::int AS bookmark_count
     FROM cases c ${whereCase} ORDER BY c.created_at DESC`,
    u.isSystemAdmin ? [u.id] : [u.id, u.id]
  );
  // attach role
  const out = [];
  for (const c of rows) {
    const role = await getCaseRole(u.id, u.isSystemAdmin, c.id);
    out.push({ ...c, role });
  }
  res.json(out);
};
router.get('/', requireAuth, listCasesHandler);

// Create a case. Open to system administrators (always) and to any user granted
// the global `can_create_cases` capability. A non-admin creator is automatically
// enrolled as the case_manager of the new case so they can immediately add data
// and manage it. System admins already see every case, so a membership row is
// not required for them, but we add one anyway when they are not already a member
// — it is harmless and keeps the "creator manages their case" invariant simple.
export const createCaseHandler = async (req: AuthedRequest, res: any) => {
  const { name, caseNumber, description } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const created = await withTx(async (q) => {
    const { rows } = await q(
      `INSERT INTO cases (name, case_number, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(name).trim(), caseNumber || null, description || null, req.user!.id]
    );
    const row = rows[0];
    // Make the creator a case_manager of their new case (idempotent).
    await q(
      `INSERT INTO case_memberships (user_id, case_id, role) VALUES ($1,$2,'case_manager')
       ON CONFLICT (user_id, case_id) DO NOTHING`,
      [req.user!.id, row.id]
    );
    return row;
  });
  await audit({ userId: req.user!.id, caseId: created.id, action: 'case_created', target: created.name });
  res.status(201).json(created);
};
router.post('/', requireAuth, requireCanCreateCases, createCaseHandler);

// Case detail
router.get('/:caseId', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(`SELECT * FROM cases WHERE id=$1`, [caseId]);
  if (!rows.length) return res.status(404).json({ error: 'Case not found' });
  const tags = (await query(`SELECT * FROM tags WHERE case_id=$1 ORDER BY name`, [caseId])).rows;
  const folders = (await query(`SELECT * FROM folders WHERE case_id=$1 ORDER BY name`, [caseId])).rows;
  const statusCounts = (await query(
    `SELECT status, count(*)::int AS n FROM review_states WHERE case_id=$1 GROUP BY status`, [caseId]
  )).rows;
  res.json({ ...rows[0], role: (req as any).caseRole, tags, folders, statusCounts });
});

// ---- Early Case Assessment (ECA) metrics -----------------------------------
// Read-only aggregate metrics for the case landing page. All counts are grouped
// aggregates over already-indexed data (no per-row loops, no ESI processing).
// RBAC: any case member (read_only+). Audited as 'eca_view'.
router.get('/:caseId/eca', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const caseRow = (await query<any>(`SELECT * FROM cases WHERE id=$1`, [caseId])).rows[0];
  if (!caseRow) return res.status(404).json({ error: 'Case not found' });

  // Headline counts in one pass over documents.
  // File extension derived from the original filename (metadata "File Name"):
  // strip any extracted-row child suffix (name.csv_row_N -> name.csv), then take
  // the final extension lowercased. The [^.] guard requires a non-dot character
  // before the final dot, so leading-dot dotfiles (e.g. .gitignore) yield NULL
  // rather than a spurious extension. NULL => 'Unknown' via COALESCE below.
  const extExpr = fileTypeExtSql();
  const totals = (await query<any>(
    `SELECT count(*)::int AS total_documents,
            count(*) FILTER (WHERE ${extExpr} = 'eml')::int AS email_count,
            count(DISTINCT NULLIF(trim(metadata->>'CUSTODIAN'), ''))::int AS custodian_count
     FROM documents WHERE case_id=$1`, [caseId]
  )).rows[0];
  const totalDocuments = totals.total_documents;

  // Custodian breakdown (non-empty, trimmed), most documents first.
  const custodians = (await query<any>(
    `SELECT trim(metadata->>'CUSTODIAN') AS custodian, count(*)::int AS doc_count
     FROM documents
     WHERE case_id=$1 AND NULLIF(trim(metadata->>'CUSTODIAN'), '') IS NOT NULL
     GROUP BY trim(metadata->>'CUSTODIAN')
     ORDER BY count(*) DESC, custodian ASC`, [caseId]
  )).rows;

  // File-type breakdown by extension derived from the original filename, most
  // documents first. Documents with no usable extension classify as 'Unknown'.
  const fileTypes = (await query<any>(
    `SELECT COALESCE(${extExpr}, 'Unknown') AS file_type, count(*)::int AS count
     FROM documents WHERE case_id=$1
     GROUP BY COALESCE(${extExpr}, 'Unknown')
     ORDER BY count(*) DESC, file_type ASC`, [caseId]
  )).rows;

  // Tag summary: every tag in the case with its document count (incl. zero), so
  // the structure (and nesting via parent_id) is visible on the ECA page.
  const tagSummary = (await query<any>(
    `SELECT t.id AS "tagId", t.name, t.colour, t.parent_id AS "parentId",
            (SELECT count(*)::int FROM document_tags dt JOIN documents d ON d.id=dt.document_id
             WHERE dt.tag_id=t.id AND d.case_id=$1) AS doc_count
     FROM tags t WHERE t.case_id=$1
     ORDER BY t.name`, [caseId]
  )).rows;

  // Status summary: explicit review statuses (excluding any stored 'unreviewed'),
  // then compute Unreviewed = total - documents that have a real review status.
  // This is correct whether or not the data stores explicit 'unreviewed' rows.
  const rawStatuses = (await query<any>(
    `SELECT status, count(DISTINCT document_id)::int AS n
     FROM review_states WHERE case_id=$1 AND status <> 'unreviewed'
     GROUP BY status`, [caseId]
  )).rows as { status: string; n: number }[];
  const reviewedTotal = rawStatuses.reduce((s, r) => s + r.n, 0);
  const STATUS_LABELS: Record<string, string> = {
    unreviewed: 'Unreviewed', in_review: 'In review', responsive: 'Responsive',
    non_responsive: 'Non-responsive', privileged: 'Privileged', further_review: 'Further review',
  };
  // Canonical display order; unknown statuses appended afterwards.
  const ORDER = ['unreviewed', 'in_review', 'responsive', 'non_responsive', 'privileged', 'further_review'];
  const byStatus = new Map(rawStatuses.map((r) => [r.status, r.n]));
  const statusSummary: { status: string; label: string; count: number }[] = [];
  const unreviewed = Math.max(0, totalDocuments - reviewedTotal);
  byStatus.set('unreviewed', unreviewed);
  for (const s of ORDER) {
    if (s === 'unreviewed' || byStatus.has(s)) {
      statusSummary.push({ status: s, label: STATUS_LABELS[s] || s, count: byStatus.get(s) || 0 });
    }
  }
  for (const [s, n] of byStatus) {
    if (!ORDER.includes(s)) statusSummary.push({ status: s, label: STATUS_LABELS[s] || s, count: n });
  }

  await audit({ userId: req.user!.id, caseId, action: 'eca_view', target: `case:${caseId}` });

  res.json({
    case: {
      id: caseRow.id, name: caseRow.name, case_number: caseRow.case_number,
      description: caseRow.description, status: caseRow.status, created_at: caseRow.created_at,
    },
    role: (req as any).caseRole,
    metrics: {
      total_documents: totalDocuments,
      email_count: totals.email_count,
      custodian_count: totals.custodian_count,
    },
    custodians,
    file_types: fileTypes,
    tag_summary: tagSummary,
    status_summary: statusSummary,
  });
});

// Edit a case's editable metadata (name + case_number/description/status).
// Permission: system_admin (global) OR case_manager on that case.
// requireCaseRole('case_manager') allows exactly those two and rejects
// reviewer / read_only with 403.
router.put('/:caseId', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const body = req.body || {};

  // Load current values so we can validate and audit old -> new.
  const cur = (await query<any>(`SELECT name, case_number, description, status FROM cases WHERE id=$1`, [caseId])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Case not found' });

  // Build the new values. A field is only changed when present in the body.
  const next: any = { ...cur };

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return res.status(400).json({ error: 'Case name cannot be empty' });
    next.name = name;
  }
  if (body.caseNumber !== undefined) next.case_number = body.caseNumber === null ? null : String(body.caseNumber).trim() || null;
  if (body.description !== undefined) next.description = body.description === null ? null : String(body.description);
  if (body.status !== undefined) {
    const status = String(body.status).trim();
    const allowed = ['open', 'closed', 'archived'];
    if (status && !allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    if (status) next.status = status;
  }

  await query(
    `UPDATE cases SET name=$1, case_number=$2, description=$3, status=$4 WHERE id=$5`,
    [next.name, next.case_number, next.description, next.status, caseId]
  );

  // Audit only the fields that actually changed, as "field: old -> new".
  const changes: string[] = [];
  for (const [k, label] of [['name', 'name'], ['case_number', 'case_number'], ['description', 'description'], ['status', 'status']] as const) {
    if ((cur[k] ?? null) !== (next[k] ?? null)) changes.push(`${label}: "${cur[k] ?? ''}" -> "${next[k] ?? ''}"`);
  }
  await audit({
    userId: req.user!.id,
    caseId,
    action: 'case.updated',
    target: `case:${caseId}`,
    detail: changes.length ? changes.join('; ') : 'no changes',
  });

  const updated = (await query<any>(`SELECT * FROM cases WHERE id=$1`, [caseId])).rows[0];
  res.json(updated);
});

// Members of a case (manager+)
router.get('/:caseId/members', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT m.user_id, m.role, u.username, u.display_name, u.email
     FROM case_memberships m JOIN users u ON u.id=m.user_id WHERE m.case_id=$1 ORDER BY u.display_name`,
    [caseId]
  );
  res.json(rows);
});

router.post('/:caseId/members', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { userId, role } = req.body || {};
  if (!userId || !['case_manager', 'reviewer', 'read_only'].includes(role))
    return res.status(400).json({ error: 'userId and valid role required' });
  await query(
    `INSERT INTO case_memberships (user_id, case_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, case_id) DO UPDATE SET role=EXCLUDED.role`,
    [userId, caseId, role]
  );
  await audit({ userId: req.user!.id, caseId, action: 'member_assigned', target: `user:${userId}`, detail: role });
  res.json({ ok: true });
});

router.delete('/:caseId/members/:userId', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  await query(`DELETE FROM case_memberships WHERE case_id=$1 AND user_id=$2`, [caseId, req.params.userId]);
  await audit({ userId: req.user!.id, caseId, action: 'member_removed', target: `user:${req.params.userId}` });
  res.json({ ok: true });
});

// ---- Tags (hierarchical / nested) ------------------------------------------

// List a case's tags as a flat list (with parent_id). Any case member may read
// tags (needed for tagging & filtering); the frontend builds the tree.
router.get('/:caseId/tags', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT id, case_id, name, colour, parent_id FROM tags WHERE case_id=$1 ORDER BY name`, [caseId]
  );
  res.json(rows);
});

// Create a tag, optionally nested under a parent tag (same case).
router.post('/:caseId/tags', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { name, colour } = req.body || {};
  const parentId = req.body?.parentId ?? req.body?.parent_id ?? null;
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (!cleanName) return res.status(400).json({ error: 'Tag name is required' });

  // A parent, if given, must be an existing tag in THIS case.
  if (parentId !== null && parentId !== undefined) {
    const p = (await query<any>(`SELECT id FROM tags WHERE id=$1 AND case_id=$2`, [parentId, caseId])).rows[0];
    if (!p) return res.status(400).json({ error: 'Parent tag not found in this case' });
  }

  try {
    const { rows } = await query<any>(
      `INSERT INTO tags (case_id, name, colour, parent_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (case_id, name) DO UPDATE SET colour=EXCLUDED.colour, parent_id=EXCLUDED.parent_id
       RETURNING *`,
      [caseId, cleanName, colour || '#3b6ea5', parentId ?? null]
    );
    await audit({
      userId: req.user!.id, caseId, action: 'tag.created', target: `tag:${rows[0].id}`,
      detail: parentId ? `"${cleanName}" under parent tag ${parentId}` : `"${cleanName}" (top-level)`,
    });
    res.json(rows[0]);
  } catch (e: any) {
    throw e;
  }
});

// Rename and/or move a tag to another parent (reparent). Prevents cycles.
router.put('/:caseId/tags/:tagId', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const tagId = parseInt(req.params.tagId, 10);
  const tag = (await query<any>(`SELECT * FROM tags WHERE id=$1 AND case_id=$2`, [tagId, caseId])).rows[0];
  if (!tag) return res.status(404).json({ error: 'Tag not found in this case' });

  const body = req.body || {};
  const next: any = { name: tag.name, colour: tag.colour, parent_id: tag.parent_id };

  if (body.name !== undefined) {
    const nm = String(body.name).trim();
    if (!nm) return res.status(400).json({ error: 'Tag name cannot be empty' });
    next.name = nm;
  }
  if (body.colour !== undefined && body.colour) next.colour = String(body.colour);

  const hasParentChange = body.parentId !== undefined || body.parent_id !== undefined;
  if (hasParentChange) {
    const newParent = body.parentId ?? body.parent_id ?? null;
    if (newParent === null) {
      next.parent_id = null;
    } else {
      const np = parseInt(newParent, 10);
      if (np === tagId) return res.status(400).json({ error: 'A tag cannot be its own parent' });
      const p = (await query<any>(`SELECT id FROM tags WHERE id=$1 AND case_id=$2`, [np, caseId])).rows[0];
      if (!p) return res.status(400).json({ error: 'Parent tag not found in this case' });
      // Cycle check: new parent must not be the tag itself or any of its descendants.
      const desc = (await query<any>(
        `WITH RECURSIVE sub AS (
           SELECT id FROM tags WHERE id=$1
           UNION ALL
           SELECT t.id FROM tags t JOIN sub ON t.parent_id = sub.id
         ) SELECT id FROM sub`, [tagId]
      )).rows.map((r) => r.id);
      if (desc.includes(np)) return res.status(400).json({ error: 'Cannot move a tag under one of its own sub-tags' });
      next.parent_id = np;
    }
  }

  try {
    await query(`UPDATE tags SET name=$1, colour=$2, parent_id=$3 WHERE id=$4`, [next.name, next.colour, next.parent_id, tagId]);
  } catch (e: any) {
    if (e.code === '23505') return res.status(409).json({ error: 'A tag with that name already exists in this case' });
    throw e;
  }
  await audit({ userId: req.user!.id, caseId, action: 'tag.updated', target: `tag:${tagId}`, detail: `name="${next.name}", parent=${next.parent_id ?? 'none'}` });
  const updated = (await query<any>(`SELECT * FROM tags WHERE id=$1`, [tagId])).rows[0];
  res.json(updated);
});

// Delete a tag and its whole subtree (ON DELETE CASCADE handles children and
// the document_tags rows for every removed tag).
router.delete('/:caseId/tags/:tagId', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const tagId = parseInt(req.params.tagId, 10);
  const tag = (await query<any>(`SELECT * FROM tags WHERE id=$1 AND case_id=$2`, [tagId, caseId])).rows[0];
  if (!tag) return res.status(404).json({ error: 'Tag not found in this case' });

  // Count the subtree for the audit detail before removing it.
  const subCount = (await query<any>(
    `WITH RECURSIVE sub AS (
       SELECT id FROM tags WHERE id=$1
       UNION ALL
       SELECT t.id FROM tags t JOIN sub ON t.parent_id = sub.id
     ) SELECT count(*)::int AS n FROM sub`, [tagId]
  )).rows[0].n;

  await query(`DELETE FROM tags WHERE id=$1`, [tagId]);
  await audit({ userId: req.user!.id, caseId, action: 'tag.deleted', target: `tag:${tagId}`, detail: `"${tag.name}" (${subCount} tag(s) incl. sub-tags removed)` });
  res.json({ ok: true, removed: subCount });
});

// Folders
router.post('/:caseId/folders', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { name, parentId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query<any>(
    `INSERT INTO folders (case_id, name, parent_id) VALUES ($1,$2,$3) RETURNING *`,
    [caseId, name, parentId || null]
  );
  res.json(rows[0]);
});

// Audit log (manager+)
router.get('/:caseId/audit', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
     WHERE a.case_id=$1 ORDER BY a.created_at DESC LIMIT 200`, [caseId]
  );
  res.json(rows);
});

// ---- CSV escaping helper ----------------------------------------------------
// Quote any field containing a comma, double-quote, CR or LF; double embedded quotes.
function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Audit log CSV export (same RBAC as the audit view). Exports the FULL set of
// audit entries for the case (no pagination limit) so the export is complete for
// forensic purposes. The export is itself recorded as an auditable event.
router.get('/:caseId/audit/export.csv', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;

  // Case number for the filename (fall back to the id).
  const caseRow = (await query<any>(`SELECT case_number FROM cases WHERE id=$1`, [caseId])).rows[0];
  const caseRef = (caseRow?.case_number || String(caseId)).replace(/[^A-Za-z0-9._-]+/g, '-');

  // Same selection/ordering as the audit view, but without the LIMIT so the
  // whole filtered result set is exported.
  const { rows } = await query<any>(
    `SELECT a.created_at, a.action, a.target, a.detail, u.display_name, u.username
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.case_id = $1 ORDER BY a.created_at DESC`, [caseId]
  );

  const header = ['Timestamp (UTC)', 'User', 'Username', 'Action', 'Target', 'Detail'];
  const lines: string[] = [header.map(csvField).join(',')];
  for (const r of rows) {
    const ts = r.created_at ? new Date(r.created_at).toISOString() : '';
    lines.push([
      csvField(ts),
      csvField(r.display_name || ''),
      csvField(r.username || ''),
      csvField(r.action || ''),
      csvField(r.target || ''),
      csvField(r.detail || ''),
    ].join(','));
  }
  // CRLF line endings for maximum spreadsheet compatibility; UTF-8 BOM so Excel
  // detects the encoding.
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';

  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = `audit-log-${caseRef}-${ymd}.csv`;

  // Exporting the audit trail is itself an auditable event.
  await audit({
    userId: req.user!.id, caseId, action: 'audit.exported',
    target: `case:${caseId}`,
    detail: `Exported ${rows.length} audit entr${rows.length === 1 ? 'y' : 'ies'} as CSV (${filename})`,
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// ============================================================================
// REPORT BUILDER — production-request document list, filtered by applied tags
// ============================================================================
// Purpose: a reviewer builds a list of documents keyed on Doc ID (control
// number) from the tags they have applied (e.g. everything tagged 'Relevant')
// and sends it to the forensics / eDiscovery team to produce the native files.
// This is a reporting feature over already-reviewed data — it does not process
// or alter ESI.

interface ReportRow {
  docName: string; docId: string; doctype: string; custodian: string; comments: string; tags: string;
}

// Resolve the ?tags= parameter (comma-separated tag ids OR names) to the tag ids
// that actually belong to this case. Returns the resolved ids and their names.
async function resolveReportTags(caseId: number, tagsParam: string | undefined): Promise<{ ids: number[]; names: string[] }> {
  const raw = (tagsParam || '').trim();
  if (!raw) return { ids: [], names: [] };
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { ids: [], names: [] };

  const caseTags = (await query<{ id: number; name: string }>(
    `SELECT id, name FROM tags WHERE case_id=$1`, [caseId]
  )).rows;
  const byId = new Map(caseTags.map((t) => [t.id, t]));
  const byName = new Map(caseTags.map((t) => [t.name.toLowerCase(), t]));

  const ids: number[] = [];
  const names: string[] = [];
  for (const tok of tokens) {
    let match: { id: number; name: string } | undefined;
    if (/^\d+$/.test(tok)) match = byId.get(parseInt(tok, 10));
    if (!match) match = byName.get(tok.toLowerCase());
    if (match && !ids.includes(match.id)) { ids.push(match.id); names.push(match.name); }
  }
  return { ids, names };
}

// Build the report rows for a case, optionally filtered by tag ids / match mode.
async function buildReportRows(caseId: number, tagIds: number[], match: 'any' | 'all'): Promise<ReportRow[]> {
  const params: any[] = [caseId];
  let filterSql = '';
  if (tagIds.length) {
    params.push(tagIds);
    const tagsIdx = params.length; // $2
    if (match === 'all') {
      params.push(tagIds.length);
      const cntIdx = params.length; // $3
      filterSql = `AND (SELECT count(DISTINCT dt.tag_id) FROM document_tags dt
                         WHERE dt.document_id = d.id AND dt.tag_id = ANY($${tagsIdx}::int[])) = $${cntIdx}`;
    } else {
      filterSql = `AND EXISTS (SELECT 1 FROM document_tags dt
                                WHERE dt.document_id = d.id AND dt.tag_id = ANY($${tagsIdx}::int[]))`;
    }
  }

  // Doc Name: prefer metadata FILENAME, then SUBJECT, then control_number.
  // Comments: "<author>: <text>" for every comment, oldest first, joined by "; ".
  // Tags: ALL tag names applied to the document (not just the selected ones).
  const sql = `
    SELECT d.control_number AS doc_id,
           COALESCE(NULLIF(d.metadata->>'FILENAME',''), NULLIF(d.metadata->>'SUBJECT',''), d.control_number) AS doc_name,
           COALESCE(d.metadata->>'DOCTYPE','') AS doctype,
           COALESCE(d.metadata->>'CUSTODIAN','') AS custodian,
           COALESCE((SELECT string_agg(u.display_name || ': ' || c.body, '; ' ORDER BY c.created_at, c.id)
                       FROM comments c JOIN users u ON u.id = c.user_id
                      WHERE c.document_id = d.id), '') AS comments,
           COALESCE((SELECT string_agg(t.name, ', ' ORDER BY t.name)
                       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
                      WHERE dt.document_id = d.id), '') AS tags
      FROM documents d
     WHERE d.case_id = $1
       ${filterSql}
     ORDER BY d.control_number ASC`;

  const { rows } = await query<any>(sql, params);
  return rows.map((r) => ({
    docName: r.doc_name || '', docId: r.doc_id || '', doctype: r.doctype || '',
    custodian: r.custodian || '', comments: r.comments || '', tags: r.tags || '',
  }));
}

// The six report columns, in the required order.
const REPORT_HEADERS = ['Doc Name', 'Doc ID', 'DOCTYPE', 'Custodian', 'Comments', 'Tags'];

// List the case's tags with a per-tag applied-document count, for the report
// builder UI (so it can show "Relevant (12)"). Any case member may read.
router.get('/:caseId/reports/tags', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT t.id, t.name, t.colour, t.parent_id,
            (SELECT count(*)::int FROM document_tags dt JOIN documents d ON d.id = dt.document_id
              WHERE dt.tag_id = t.id AND d.case_id = $1) AS doc_count
       FROM tags t WHERE t.case_id = $1
      ORDER BY t.name`, [caseId]
  );
  const total = (await query<any>(`SELECT count(*)::int AS n FROM documents WHERE case_id=$1`, [caseId])).rows[0].n;
  res.json({ tags: rows, totalDocuments: total });
});

// Export the production-request document list, filtered by applied tags.
// RBAC: reviewer or above (the intended users; case_manager/admin inherit).
// Query: ?tags=<id|name,...>&match=any|all&format=csv|xlsx
router.get('/:caseId/reports/documents', requireAuth, requireCaseRole('reviewer'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const fmtRaw = String(req.query.format || 'csv').toLowerCase();
  const format: 'csv' | 'xlsx' | 'json' = fmtRaw === 'xlsx' ? 'xlsx' : fmtRaw === 'json' ? 'json' : 'csv';
  const match: 'any' | 'all' = String(req.query.match || 'any').toLowerCase() === 'all' ? 'all' : 'any';

  // Resolve the tag filter. If a tags param was supplied but matched no real
  // tags in the case, that is a client error (avoid silently exporting all docs).
  const tagsParam = req.query.tags as string | undefined;
  const { ids: tagIds, names: tagNames } = await resolveReportTags(caseId, tagsParam);
  if (tagsParam && tagsParam.trim() && tagIds.length === 0) {
    return res.status(400).json({ error: 'None of the requested tags exist in this case.' });
  }

  const rows = await buildReportRows(caseId, tagIds, match);

  // JSON preview — used by the report builder UI to show an accurate document
  // count (and a small preview) before exporting. Not a file export, so it is
  // NOT recorded as a report.exported audit event.
  if (format === 'json') {
    return res.json({ count: rows.length, columns: REPORT_HEADERS, rows });
  }

  // Case number for the filename (fall back to the id).
  const caseRow = (await query<any>(`SELECT case_number FROM cases WHERE id=$1`, [caseId])).rows[0];
  const caseRef = (caseRow?.case_number || String(caseId)).replace(/[^A-Za-z0-9._-]+/g, '-');
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = `production-list-${caseRef}-${ymd}`;

  const filterLabel = tagIds.length
    ? `tags [${tagNames.join(', ')}] (match ${match})`
    : 'all documents (no tag filter)';

  // Record the export — it is a forensic product.
  await audit({
    userId: req.user!.id, caseId, action: 'report.exported',
    target: `case:${caseId}`,
    detail: `Production list — ${filterLabel}, format ${format.toUpperCase()}, ${rows.length} document(s)`,
  });

  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Meridian Edge';
    wb.created = new Date();
    const ws = wb.addWorksheet('Document List', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Doc Name', key: 'docName', width: 40 },
      { header: 'Doc ID', key: 'docId', width: 16 },
      { header: 'DOCTYPE', key: 'doctype', width: 14 },
      { header: 'Custodian', key: 'custodian', width: 22 },
      { header: 'Comments', key: 'comments', width: 60 },
      { header: 'Tags', key: 'tags', width: 26 },
    ];
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: 'middle' };
    for (const r of rows) ws.addRow(r);
    // Wrap the free-text comments column for readability.
    ws.getColumn('comments').alignment = { wrapText: true, vertical: 'top' };

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    return res.send(Buffer.from(buf));
  }

  // CSV — same conventions as the audit export (BOM, CRLF, RFC-4180 escaping).
  const lines: string[] = [REPORT_HEADERS.map(csvField).join(',')];
  for (const r of rows) {
    lines.push([r.docName, r.docId, r.doctype, r.custodian, r.comments, r.tags].map(csvField).join(','));
  }
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
  res.send(csv);
});

export default router;
