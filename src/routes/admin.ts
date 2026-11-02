import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { query, withTx } from '../db';
import { config } from '../config';
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

// ---- User administration (system admin only, global) -----------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadUser(id: number) {
  const { rows } = await query<any>(
    `SELECT id, username, email, display_name, is_system_admin, active FROM users WHERE id=$1`,
    [id]
  );
  return rows[0] || null;
}

// Count of OTHER active system admins (excludes the given user id).
async function otherActiveAdmins(excludeId: number): Promise<number> {
  const { rows } = await query<any>(
    `SELECT count(*)::int AS n FROM users WHERE is_system_admin=TRUE AND active=TRUE AND id<>$1`,
    [excludeId]
  );
  return rows[0].n;
}

function tempPassword(len = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*';
  let out = '';
  const buf = require('crypto').randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

// Edit a user's profile: display_name, username, email. Audits each field old->new.
router.put('/users/:id', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });
  const cur = await loadUser(id);
  if (!cur) return res.status(404).json({ error: 'User not found' });

  const { displayName, username, email } = req.body || {};
  const sets: string[] = [];
  const params: any[] = [];
  const changes: string[] = [];

  if (displayName !== undefined) {
    const v = String(displayName).trim();
    if (!v) return res.status(400).json({ error: 'Display name cannot be empty' });
    if (v !== cur.display_name) { params.push(v); sets.push(`display_name=$${params.length}`); changes.push(`name "${cur.display_name}" -> "${v}"`); }
  }
  if (username !== undefined) {
    const v = String(username).trim();
    if (!v) return res.status(400).json({ error: 'Username cannot be empty' });
    if (v !== cur.username) {
      const dup = await query<any>(`SELECT 1 FROM users WHERE lower(username)=lower($1) AND id<>$2`, [v, id]);
      if (dup.rows.length) return res.status(409).json({ error: `Username "${v}" is already taken` });
      params.push(v); sets.push(`username=$${params.length}`); changes.push(`username "${cur.username}" -> "${v}"`);
    }
  }
  if (email !== undefined) {
    const raw = email === null ? '' : String(email).trim();
    const v = raw || null;
    if (v && !EMAIL_RE.test(v)) return res.status(400).json({ error: 'Email address is not valid' });
    if (v !== cur.email) { params.push(v); sets.push(`email=$${params.length}`); changes.push(`email "${cur.email || '—'}" -> "${v || '—'}"`); }
  }

  if (!sets.length) return res.json(await loadUser(id));
  params.push(id);
  try {
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
  } catch (e: any) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username is already taken' });
    throw e;
  }
  await audit({ userId: req.user!.id, action: 'user.updated', target: `user:${id}`, detail: `${cur.username}: ${changes.join('; ')}` });
  res.json(await loadUser(id));
});

// Reset a user's password. Mode (a) explicit newPassword; mode (b) generate=true
// returns a strong temporary password ONCE in the response body.
router.post('/users/:id/reset-password', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });
  const cur = await loadUser(id);
  if (!cur) return res.status(404).json({ error: 'User not found' });

  const { newPassword, generate } = req.body || {};
  let pw: string;
  let generated = false;
  if (generate) {
    pw = tempPassword();
    generated = true;
  } else {
    pw = String(newPassword || '');
    if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword(pw), id]);
  // NB: never audit/log the password value itself.
  await audit({ userId: req.user!.id, action: 'user.password_reset', target: `user:${id}`, detail: `${cur.username}${generated ? ' (temporary password generated)' : ''}` });
  res.json(generated ? { ok: true, temporaryPassword: pw } : { ok: true });
});

// Change global role: promote/demote system administrator. Guards against
// self-demotion and demoting the last remaining active system admin.
router.put('/users/:id/role', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });
  const cur = await loadUser(id);
  if (!cur) return res.status(404).json({ error: 'User not found' });
  const { isSystemAdmin } = req.body || {};
  if (typeof isSystemAdmin !== 'boolean') return res.status(400).json({ error: 'isSystemAdmin (boolean) required' });

  if (cur.is_system_admin && !isSystemAdmin) {
    // Demotion guards
    if (id === req.user!.id) return res.status(400).json({ error: 'You cannot remove your own system administrator access' });
    if ((await otherActiveAdmins(id)) === 0) return res.status(400).json({ error: 'Cannot demote the last active system administrator' });
  }
  if (cur.is_system_admin === isSystemAdmin) return res.json(await loadUser(id));

  await query(`UPDATE users SET is_system_admin=$1 WHERE id=$2`, [isSystemAdmin, id]);
  await audit({ userId: req.user!.id, action: 'user.role_changed', target: `user:${id}`, detail: `${cur.username}: system_admin ${cur.is_system_admin} -> ${isSystemAdmin}` });
  res.json(await loadUser(id));
});

// Activate / deactivate a user. A deactivated user is blocked from logging in
// (and rejected on the next request). Guards against self-deactivation and
// deactivating the last remaining active system admin.
router.put('/users/:id/active', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid user id' });
  const cur = await loadUser(id);
  if (!cur) return res.status(404).json({ error: 'User not found' });
  const { active } = req.body || {};
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });

  if (cur.active && !active) {
    // Deactivation guards
    if (id === req.user!.id) return res.status(400).json({ error: 'You cannot deactivate your own account' });
    if (cur.is_system_admin && (await otherActiveAdmins(id)) === 0) return res.status(400).json({ error: 'Cannot deactivate the last active system administrator' });
  }
  if (cur.active === active) return res.json(await loadUser(id));

  await query(`UPDATE users SET active=$1 WHERE id=$2`, [active, id]);
  await audit({ userId: req.user!.id, action: active ? 'user.activated' : 'user.deactivated', target: `user:${id}`, detail: cur.username });
  res.json(await loadUser(id));
});

// ---- A user's case memberships (managed from the user side) -----------------
router.get('/users/:id/memberships', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await query<any>(
    `SELECT m.case_id, m.role, c.name AS case_name, c.case_number
     FROM case_memberships m JOIN cases c ON c.id=m.case_id
     WHERE m.user_id=$1 ORDER BY c.name`,
    [id]
  );
  res.json(rows);
});

const CASE_ROLES = ['case_manager', 'reviewer', 'read_only'];

router.post('/users/:id/memberships', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = await loadUser(id);
  if (!cur) return res.status(404).json({ error: 'User not found' });
  const caseId = parseInt(req.body?.caseId, 10);
  const role = req.body?.role;
  if (!caseId || Number.isNaN(caseId) || !CASE_ROLES.includes(role))
    return res.status(400).json({ error: 'caseId and a valid role (case_manager / reviewer / read_only) required' });
  const c = (await query<any>(`SELECT id, name FROM cases WHERE id=$1`, [caseId])).rows[0];
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const existing = (await query<any>(`SELECT role FROM case_memberships WHERE user_id=$1 AND case_id=$2`, [id, caseId])).rows[0];
  await query(
    `INSERT INTO case_memberships (user_id, case_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, case_id) DO UPDATE SET role=EXCLUDED.role`,
    [id, caseId, role]
  );
  await audit({
    userId: req.user!.id, caseId, action: existing ? 'member_role_changed' : 'member_assigned',
    target: `user:${id}`,
    detail: existing ? `${cur.username} on "${c.name}": ${existing.role} -> ${role}` : `${cur.username} added to "${c.name}" as ${role}`,
  });
  res.json({ ok: true });
});

router.delete('/users/:id/memberships/:caseId', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  const caseId = parseInt(req.params.caseId, 10);
  const cur = await loadUser(id);
  const c = (await query<any>(`SELECT name FROM cases WHERE id=$1`, [caseId])).rows[0];
  await query(`DELETE FROM case_memberships WHERE user_id=$1 AND case_id=$2`, [id, caseId]);
  await audit({ userId: req.user!.id, caseId, action: 'member_removed', target: `user:${id}`, detail: `${cur?.username || id} removed from "${c?.name || caseId}"` });
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

// Delete a case and ALL of its data. DESTRUCTIVE — system_admin ONLY.
// A case_manager must NOT be able to delete a case, so this lives on the
// admin router behind requireSystemAdmin (not requireCaseRole).
router.delete('/cases/:id', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid case id' });

  const c = (await query<any>(`SELECT id, name, case_number FROM cases WHERE id=$1`, [id])).rows[0];
  if (!c) return res.status(404).json({ error: 'Case not found' });
  const docCount = (await query<any>(`SELECT count(*)::int AS n FROM documents WHERE case_id=$1`, [id])).rows[0].n;

  // Write the audit row FIRST, while the case still exists (so the case_id FK is
  // valid). The DB cascade will then set audit_log.case_id to NULL for this row
  // (ON DELETE SET NULL), but the case identity is preserved in target/detail so
  // the deletion is permanently recorded.
  await audit({
    userId: req.user!.id,
    caseId: id,
    action: 'case.deleted',
    target: `case:${id}`,
    detail: `Deleted case "${c.name}"${c.case_number ? ` (${c.case_number})` : ''} with ${docCount} document(s) and all review work`,
  });

  // DB cleanup in a single transaction. Every dependent table references
  // cases(id) or documents(id) with ON DELETE CASCADE, so deleting the case row
  // removes: case_memberships, loadfile_imports, documents -> (document_pages,
  // review_states, bookmarks, document_tags, document_folders, comments),
  // review_states, bookmarks, tags (+ nested subtree + their document_tags),
  // folders (+ document_folders), comments. audit_log.case_id is SET NULL.
  await withTx(async (q) => {
    await q(`DELETE FROM cases WHERE id=$1`, [id]);
  });

  // On-disk cleanup: rendered/native page images and any staged import files.
  for (const dir of [path.join(config.uploadsDir, `case-${id}`), path.join(config.uploadsDir, 'imports', String(id))]) {
    try {
      // Guard against path escaping the uploads root.
      const abs = path.resolve(dir);
      if (abs.startsWith(path.resolve(config.uploadsDir) + path.sep)) {
        fs.rmSync(abs, { recursive: true, force: true });
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`case delete: failed to remove ${dir}`, e);
    }
  }

  res.json({ ok: true, deleted: { id, name: c.name, documents: docCount } });
});

export default router;
