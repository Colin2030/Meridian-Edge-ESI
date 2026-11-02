import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/auth';
import { query } from '../db';

export interface AuthedRequest extends Request {
  user?: { id: number; username: string; isSystemAdmin: boolean };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = req.cookies?.me_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired session' });
  req.user = { id: payload.uid, username: payload.username, isSystemAdmin: payload.isSystemAdmin };
  next();
}

export function requireSystemAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user?.isSystemAdmin) return res.status(403).json({ error: 'System admin only' });
  next();
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
