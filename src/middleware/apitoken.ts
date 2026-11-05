import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { AuthedRequest } from './auth';
import { assertLicenceAllowsAccess } from '../lib/license';

// ---- Token format & hashing -------------------------------------------------
// Raw token: me_live_<43-char base64url of 32 random bytes>. High entropy (256
// bits). We store only a SHA-256 hash of the full raw token plus a short prefix
// for display; the raw value is returned to the caller exactly once.
export const TOKEN_LIVE_PREFIX = 'me_live_';
const PREFIX_DISPLAY_LEN = 12; // e.g. "me_live_ab12"

export function generateApiToken(): { raw: string; hash: string; prefix: string } {
  const raw = TOKEN_LIVE_PREFIX + crypto.randomBytes(32).toString('base64url');
  const hash = hashApiToken(raw);
  const prefix = raw.slice(0, PREFIX_DISPLAY_LEN);
  return { raw, hash, prefix };
}

export function hashApiToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

// ---- Throttled last_used_at update ------------------------------------------
// Avoid a write on every single call: only bump last_used_at if it is null or
// older than this interval. Keeps hot-path reads cheap while still giving admins
// a useful "last used" signal.
const LAST_USED_THROTTLE_MS = 60 * 1000;

// ---- requireApiToken --------------------------------------------------------
// Reads `Authorization: Bearer <token>`, hashes it, finds an active (non-revoked)
// api_tokens row, loads the owning user, and sets req.user EXACTLY like
// requireAuth so downstream requireCaseRole / requireCanCreateCases work
// unchanged. The token acts AS its owning user — all per-case RBAC applies.
export async function requireApiToken(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
  if (!m) return res.status(401).json({ error: 'Missing API token. Supply an Authorization: Bearer <token> header.' });
  const raw = m[1].trim();
  if (!raw) return res.status(401).json({ error: 'Missing API token.' });

  const hash = hashApiToken(raw);
  try {
    const { rows } = await query<{
      id: number; user_id: number; revoked_at: Date | null; last_used_at: Date | null;
      username: string; is_system_admin: boolean; active: boolean;
    }>(
      `SELECT t.id, t.user_id, t.revoked_at, t.last_used_at,
              u.username, u.is_system_admin, u.active
         FROM api_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1`,
      [hash]
    );
    if (!rows.length) return res.status(401).json({ error: 'Invalid API token.' });
    const row = rows[0];
    if (row.revoked_at) return res.status(401).json({ error: 'This API token has been revoked.' });
    if (!row.active) return res.status(403).json({ error: 'The account that owns this token is inactive.' });

    // Set req.user exactly like requireAuth so downstream RBAC is identical.
    req.user = { id: row.user_id, username: row.username, isSystemAdmin: row.is_system_admin };
    (req as any).apiTokenId = row.id;

    // Commercial licence gate — consistent with the cookie-session block. Token
    // calls act as their owning user; non-admin owners are blocked when there is
    // no valid licence. System admins always pass.
    const lic = await assertLicenceAllowsAccess(req.user);
    if (!lic.allowed) {
      return res.status(403).json({ error: lic.reason || 'Your licence does not permit access. Please contact your administrator.', licenceExpired: true });
    }

    // Throttled last_used_at bump (fire-and-forget; never blocks the request).
    const now = Date.now();
    const last = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (now - last > LAST_USED_THROTTLE_MS) {
      query(`UPDATE api_tokens SET last_used_at=now() WHERE id=$1`, [row.id]).catch(() => { /* ignore */ });
    }
    next();
  } catch (e) {
    next(e);
  }
}
