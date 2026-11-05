import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth';
import { query } from '../db';
import { assertLicenceAllowsAccess } from '../lib/license';

export interface AuthedRequest extends Request {
  user?: { id: number; username: string; isSystemAdmin: boolean };
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.me_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired session' });
  try {
    // Re-check the account on every request so that a deactivation or a role
    // change (e.g. demotion) takes effect immediately for existing sessions,
    // rather than only at next login. One indexed primary-key lookup.
    const { rows } = await query<{ active: boolean; is_system_admin: boolean; username: string }>(
      `SELECT active, is_system_admin, username FROM users WHERE id=$1`,
      [payload.uid]
    );
    if (!rows.length) return res.status(401).json({ error: 'User not found' });
    if (!rows[0].active) {
      res.clearCookie('me_session');
      return res.status(403).json({ error: 'This account is inactive. Please contact a system administrator.' });
    }
    req.user = { id: payload.uid, username: rows[0].username, isSystemAdmin: rows[0].is_system_admin };

    // Commercial licence gate. System admins ALWAYS pass (so they can log in and
    // upload a renewal). Everyone else is blocked when there is no valid,
    // in-window licence. Evaluated AFTER the user is identified so admins bypass.
    const lic = await assertLicenceAllowsAccess(req.user);
    if (!lic.allowed) {
      return res.status(403).json({ error: lic.reason || 'Your licence does not permit access. Please contact your administrator.', licenceExpired: true });
    }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireSystemAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user?.isSystemAdmin) return res.status(403).json({ error: 'System admin only' });
  next();
}

// Allows the request only if the user may create cases: either a system
// administrator (implicitly always permitted) or a user whose global
// `can_create_cases` flag is set. Used to gate case creation, which is a global
// action and cannot be scoped by a per-case role.
export async function requireCanCreateCases(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (req.user.isSystemAdmin) return next();
  try {
    const { rows } = await query<{ can_create_cases: boolean }>(
      `SELECT can_create_cases FROM users WHERE id=$1`,
      [req.user.id]
    );
    if (rows.length && rows[0].can_create_cases) return next();
    return res.status(403).json({ error: 'You do not have permission to create cases' });
  } catch (e) {
    next(e);
  }
}

export type CaseRole = 'case_manager' | 'reviewer' | 'read_only';

// Returns the effective role of the user within a case, or null if no access.
export async function getCaseRole(userId: number, isSystemAdmin: boolean, caseId: number): Promise<CaseRole | 'system_admin' | null> {
  if (isSystemAdmin) return 'system_admin';
  const { rows } = await query<{ role: CaseRole }>(
    `SELECT role FROM case_memberships WHERE user_id=$1 AND case_id=$2`,
    [userId, caseId]
  );
  return rows.length ? rows[0].role : null;
}

const RANK: Record<string, number> = {
  read_only: 1,
  reviewer: 2,
  case_manager: 3,
  system_admin: 4,
};

// Middleware factory: ensures req.user has at least `min` role in :caseId param.
export function requireCaseRole(min: CaseRole) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const caseId = parseInt(req.params.caseId || req.body.caseId || req.query.caseId, 10);
    if (!caseId || Number.isNaN(caseId)) return res.status(400).json({ error: 'caseId required' });
    const role = await getCaseRole(req.user!.id, req.user!.isSystemAdmin, caseId);
    if (!role) return res.status(403).json({ error: 'No access to this case' });
    if (RANK[role] < RANK[min]) return res.status(403).json({ error: 'Insufficient permissions for this case' });
    (req as any).caseRole = role;
    (req as any).caseId = caseId;
    next();
  };
}
