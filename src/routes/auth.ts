import { Router } from 'express';
import { query } from '../db';
import { verifyPassword, signToken } from '../lib/auth';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { config } from '../config';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const { rows } = await query<any>(`SELECT * FROM users WHERE username=$1`, [username]);
  if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
    await audit({ action: 'login_failed', target: username });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const u = rows[0];
  // Block deactivated accounts with a clear message (credentials already verified).
  if (!u.active) {
    await audit({ userId: u.id, action: 'login_blocked_inactive', target: username });
    return res.status(403).json({ error: 'This account is inactive. Please contact a system administrator.' });
  }
  const token = signToken({ uid: u.id, username: u.username, isSystemAdmin: u.is_system_admin });
  res.cookie('me_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: 12 * 3600 * 1000,
  });
  await audit({ userId: u.id, action: 'login', target: u.username });
  res.json({ id: u.id, username: u.username, displayName: u.display_name, isSystemAdmin: u.is_system_admin });
});

router.post('/logout', requireAuth, async (req: AuthedRequest, res) => {
  await audit({ userId: req.user!.id, action: 'logout' });
  res.clearCookie('me_session');
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const { rows } = await query<any>(`SELECT id, username, email, display_name, is_system_admin FROM users WHERE id=$1`, [req.user!.id]);
  if (!rows.length) return res.status(401).json({ error: 'User not found' });
  const u = rows[0];
  res.json({ id: u.id, username: u.username, email: u.email, displayName: u.display_name, isSystemAdmin: u.is_system_admin });
});

export default router;
