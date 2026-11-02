import { Router } from 'express';
import { query } from '../db';
import { hashPassword } from '../lib/auth';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireSystemAdmin } from '../middleware/auth';

const router = Router();

// List all users (system admin)
router.get('/users', requireAuth, requireSystemAdmin, async (_req, res) => {
  const { rows } = await query<any>(
    `SELECT id, username, email, display_name, is_system_admin, active, created_at FROM users ORDER BY display_name`
  );
  res.json(rows);
});

// Create user
router.post('/users', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const { username, password, displayName, email, isSystemAdmin } = req.body || {};
  if (!username || !password || !displayName) return res.status(400).json({ error: 'username, password, displayName required' });
  try {
    const { rows } = await query<any>(
      `INSERT INTO users (username, email, display_name, password_hash, is_system_admin)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, username, display_name, is_system_admin`,
      [username, email || null, displayName, hashPassword(password), !!isSystemAdmin]
    );
    await audit({ userId: req.user!.id, action: 'user_created', target: username });
    res.json(rows[0]);
  } catch (e: any) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

// Update user (active flag / admin flag / password)
router.put('/users/:id', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const { active, isSystemAdmin, password, displayName, email } = req.body || {};
  const sets: string[] = [];
  const params: any[] = [];
  if (active !== undefined) { params.push(active); sets.push(`active=$${params.length}`); }
  if (isSystemAdmin !== undefined) { params.push(isSystemAdmin); sets.push(`is_system_admin=$${params.length}`); }
  if (displayName) { params.push(displayName); sets.push(`display_name=$${params.length}`); }
  if (email !== undefined) { params.push(email); sets.push(`email=$${params.length}`); }
  if (password) { params.push(hashPassword(password)); sets.push(`password_hash=$${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(id);
  await query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
  await audit({ userId: req.user!.id, action: 'user_updated', target: `user:${id}` });
  res.json({ ok: true });
});

// Create case (system admin)
router.post('/cases', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const { name, caseNumber, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows } = await query<any>(
    `INSERT INTO cases (name, case_number, description, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, caseNumber || null, description || null, req.user!.id]
  );
  await audit({ userId: req.user!.id, caseId: rows[0].id, action: 'case_created', target: name });
  res.json(rows[0]);
});

// Update case
router.put('/cases/:id', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, caseNumber, description, status } = req.body || {};
  await query(
    `UPDATE cases SET name=COALESCE($1,name), case_number=COALESCE($2,case_number),
      description=COALESCE($3,description), status=COALESCE($4,status) WHERE id=$5`,
    [name || null, caseNumber || null, description || null, status || null, id]
  );
  await audit({ userId: req.user!.id, caseId: id, action: 'case_updated', target: `case:${id}` });
  res.json({ ok: true });
});

export default router;
