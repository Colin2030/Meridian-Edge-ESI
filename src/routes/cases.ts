import { Router } from 'express';
import { query } from '../db';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireCaseRole, getCaseRole } from '../middleware/auth';

const router = Router();

// List cases the user can access, with counts.
router.get('/', requireAuth, async (req: AuthedRequest, res) => {
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
});

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

// Tags
router.post('/:caseId/tags', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { name, colour } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query<any>(
    `INSERT INTO tags (case_id, name, colour) VALUES ($1,$2,$3)
     ON CONFLICT (case_id, name) DO UPDATE SET colour=EXCLUDED.colour RETURNING *`,
    [caseId, name, colour || '#64748b']
  );
  res.json(rows[0]);
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

export default router;
