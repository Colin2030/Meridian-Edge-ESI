import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { query } from '../db';
import { config } from '../config';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';

const router = Router();

// Search / list documents within a case (read_only+)
router.get('/case/:caseId/documents', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const u = req.user!;
  const q = (req.query.q as string || '').trim();
  const status = (req.query.status as string || '').trim();
  const tagId = req.query.tagId ? parseInt(req.query.tagId as string, 10) : null;
  const dateFrom = (req.query.dateFrom as string || '').trim();
  const dateTo = (req.query.dateTo as string || '').trim();
  const bookmarked = (req.query.bookmarked as string) === 'true';
  const sort = (req.query.sort as string) || 'control_number';
  const dir = ((req.query.dir as string) || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const where: string[] = ['d.case_id = $1'];
  const params: any[] = [caseId];
  let rankSelect = '0 AS rank';
  if (q) {
    params.push(q);
    where.push(`d.search_tsv @@ plainto_tsquery('english', $${params.length})`);
    rankSelect = `ts_rank(d.search_tsv, plainto_tsquery('english', $${params.length})) AS rank`;
  }
  if (status) {
    params.push(status);
    where.push(`rs.status = $${params.length}`);
  }
  if (tagId) {
    params.push(tagId);
    where.push(`EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id=d.id AND dt.tag_id=$${params.length})`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`(d.metadata->>'DATE') >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`(d.metadata->>'DATE') <= $${params.length}`);
  }
  params.push(u.id);
  const bmParam = params.length;
  if (bookmarked) {
    where.push(`EXISTS (SELECT 1 FROM bookmarks b WHERE b.document_id=d.id AND b.user_id=$${bmParam})`);
  }

  const sortCol = ['control_number', 'rank', 'created_at', 'page_count'].includes(sort) ? sort : 'control_number';
  const orderBy = q && sort === 'rank' ? `rank DESC` : `d.${sortCol} ${dir}`;

  params.push(limit, offset);
  const sql = `
    SELECT d.id, d.control_number, d.native_type, d.page_count, d.has_text, d.created_at,
           d.metadata, rs.status AS review_status, ${rankSelect},
           EXISTS (SELECT 1 FROM bookmarks b WHERE b.document_id=d.id AND b.user_id=$${bmParam}) AS bookmarked,
           COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'colour',t.colour))
                     FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id), '[]') AS tags
    FROM documents d
    LEFT JOIN review_states rs ON rs.document_id=d.id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await query<any>(sql, params);

  // Slice exactly the params referenced by the WHERE clause (u.id/limit/offset may be unused there).
  const whereStr = where.join(' AND ');
  const maxWhereParam = Math.max(0, ...(whereStr.match(/\$(\d+)/g) || []).map((s) => parseInt(s.slice(1), 10)));
  const countParams = params.slice(0, maxWhereParam);
  const countSql = `SELECT count(*)::int AS total FROM documents d LEFT JOIN review_states rs ON rs.document_id=d.id WHERE ${whereStr}`;
  const total = (await query<any>(countSql, countParams)).rows[0].total;

  res.json({ total, limit, offset, documents: rows });
});

// Document detail (read_only+)
router.get('/documents/:docId', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(`SELECT * FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const doc = rows[0];
  // enforce case access
  const role = await requireAccess(req, doc.case_id);
  if (!role) return res.status(403).json({ error: 'No access to this case' });

  const pages = (await query<any>(`SELECT page_no, image_path FROM document_pages WHERE document_id=$1 ORDER BY page_no`, [docId])).rows;
  const review = (await query<any>(`SELECT rs.status, rs.reviewed_at, u.display_name AS reviewed_by FROM review_states rs LEFT JOIN users u ON u.id=rs.reviewed_by WHERE rs.document_id=$1`, [docId])).rows[0] || { status: 'unreviewed' };
  const tags = (await query<any>(`SELECT t.id, t.name, t.colour FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=$1`, [docId])).rows;
  const bookmarked = (await query<any>(`SELECT 1 FROM bookmarks WHERE document_id=$1 AND user_id=$2`, [docId, req.user!.id])).rowCount > 0;
  const comments = (await query<any>(`SELECT c.id, c.body, c.created_at, u.display_name, u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.document_id=$1 ORDER BY c.created_at ASC`, [docId])).rows;

  await audit({ userId: req.user!.id, caseId: doc.case_id, action: 'document_view', target: doc.control_number });
  res.json({
    id: doc.id, caseId: doc.case_id, controlNumber: doc.control_number,
    nativeType: doc.native_type, nativePath: doc.native_path, pageCount: doc.page_count,
    hasText: doc.has_text, extractedText: doc.extracted_text, metadata: doc.metadata,
    pages: pages.map((p) => ({ pageNo: p.page_no, url: `/api/files/${encodeURI(p.image_path)}` })),
    nativeUrl: doc.native_path ? `/api/files/${encodeURI(doc.native_path)}` : null,
    review, tags, bookmarked, comments, role,
  });
});

// Helper: check user's role for a given caseId
async function requireAccess(req: AuthedRequest, caseId: number): Promise<string | null> {
  const u = req.user!;
  if (u.isSystemAdmin) return 'system_admin';
  const { rows } = await query<any>(`SELECT role FROM case_memberships WHERE user_id=$1 AND case_id=$2`, [u.id, caseId]);
  return rows.length ? rows[0].role : null;
}

function canReview(role: string | null): boolean {
  return role === 'system_admin' || role === 'case_manager' || role === 'reviewer';
}

// Set review state (reviewer+)
router.put('/documents/:docId/review', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { status } = req.body || {};
  const valid = ['unreviewed', 'in_review', 'responsive', 'non_responsive', 'privileged', 'further_review'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const { rows } = await query<any>(`SELECT case_id, control_number FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted to change review state' });
  await query(
    `INSERT INTO review_states (document_id, case_id, status, reviewed_by, reviewed_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (document_id) DO UPDATE SET status=EXCLUDED.status, reviewed_by=EXCLUDED.reviewed_by, reviewed_at=now()`,
    [docId, rows[0].case_id, status, req.user!.id]
  );
  await audit({ userId: req.user!.id, caseId: rows[0].case_id, action: 'review_state_change', target: rows[0].control_number, detail: status });
  res.json({ ok: true, status });
});

// Toggle bookmark (read_only+)
router.post('/documents/:docId/bookmark', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!role) return res.status(403).json({ error: 'No access' });
  const existing = await query(`SELECT 1 FROM bookmarks WHERE document_id=$1 AND user_id=$2`, [docId, req.user!.id]);
  if (existing.rowCount) {
    await query(`DELETE FROM bookmarks WHERE document_id=$1 AND user_id=$2`, [docId, req.user!.id]);
    res.json({ bookmarked: false });
  } else {
    await query(`INSERT INTO bookmarks (user_id, document_id, case_id) VALUES ($1,$2,$3)`, [req.user!.id, docId, rows[0].case_id]);
    res.json({ bookmarked: true });
  }
});

// Add/remove tag on document (reviewer+)
router.post('/documents/:docId/tags', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { tagId } = req.body || {};
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted to tag' });
  await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [docId, tagId]);
  await audit({ userId: req.user!.id, caseId: rows[0].case_id, action: 'tag_add', target: `doc:${docId}`, detail: `tag:${tagId}` });
  res.json({ ok: true });
});

router.delete('/documents/:docId/tags/:tagId', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted' });
  await query(`DELETE FROM document_tags WHERE document_id=$1 AND tag_id=$2`, [docId, req.params.tagId]);
  res.json({ ok: true });
});

// Comments (reviewer+ to post; read_only cannot comment)
router.post('/documents/:docId/comments', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted to comment' });
  const ins = await query<any>(
    `INSERT INTO comments (document_id, case_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [docId, rows[0].case_id, req.user!.id, body.trim()]
  );
  await audit({ userId: req.user!.id, caseId: rows[0].case_id, action: 'comment_add', target: `doc:${docId}` });
  res.json({ id: ins.rows[0].id, createdAt: ins.rows[0].created_at });
});

// Bookmarks list for a case
router.get('/case/:caseId/bookmarks', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT d.id, d.control_number, d.native_type, d.page_count, d.metadata, rs.status AS review_status, b.created_at AS bookmarked_at
     FROM bookmarks b JOIN documents d ON d.id=b.document_id LEFT JOIN review_states rs ON rs.document_id=d.id
     WHERE b.user_id=$1 AND b.case_id=$2 ORDER BY b.created_at DESC`,
    [req.user!.id, caseId]
  );
  res.json(rows);
});

export default router;
