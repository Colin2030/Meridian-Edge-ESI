import { Router } from 'express';
import { query } from '../db';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth } from '../middleware/auth';
import { generateApiToken } from '../middleware/apitoken';

// Token management API (cookie/session authenticated — used by the browser UI).
// A user may manage their OWN tokens; a system administrator may manage tokens
// for any user (create-for-user, list-all / list-by-user, revoke-any).
const router = Router();

// Shape returned to the UI — NEVER includes the raw token or its hash.
const LIST_COLS = `
  t.id, t.user_id, t.name, t.token_prefix, t.created_at, t.last_used_at, t.revoked_at,
  u.display_name AS owner_name, u.username AS owner_username,
  cb.display_name AS created_by_name`;

// ---- POST /api/tokens -------------------------------------------------------
// Create a token for the current user, or (system admin only) for another user
// via { userId }. Returns the RAW token exactly once.
router.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const me = req.user!;
  const name = (req.body?.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'A token name is required.' });

  // Determine the owning user.
  let ownerId = me.id;
  if (req.body?.userId !== undefined && req.body?.userId !== null && String(req.body.userId) !== '') {
    const requested = parseInt(req.body.userId, 10);
    if (!requested || Number.isNaN(requested)) return res.status(400).json({ error: 'Invalid userId.' });
    if (requested !== me.id && !me.isSystemAdmin) {
      return res.status(403).json({ error: 'Only a system administrator can create a token for another user.' });
    }
    ownerId = requested;
  }

  // Confirm the owner exists and is active.
  const owner = (await query<{ id: number; username: string; active: boolean }>(
    `SELECT id, username, active FROM users WHERE id=$1`, [ownerId]
  )).rows[0];
  if (!owner) return res.status(404).json({ error: 'Owner user not found.' });
  if (!owner.active) return res.status(400).json({ error: 'Cannot create a token for an inactive account.' });

  const { raw, hash, prefix } = generateApiToken();
  const ins = await query<{ id: number; created_at: Date }>(
    `INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [ownerId, name, prefix, hash, me.id]
  );
  const row = ins.rows[0];

  await audit({
    userId: me.id, action: 'token.created', target: `token:${row.id}`,
    detail: `"${name}" for ${owner.username} (prefix ${prefix}…)`,
  });

  // Raw token shown ONCE — never retrievable again.
  res.status(201).json({ id: row.id, name, token: raw, prefix, ownerId, createdAt: row.created_at });
});

// ---- GET /api/tokens --------------------------------------------------------
// A user lists their own tokens. A system admin lists all tokens, or filters by
// ?userId=. Raw tokens are never returned.
router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const me = req.user!;
  const params: any[] = [];
  let where = '';
  if (me.isSystemAdmin) {
    if (req.query.userId) {
      params.push(parseInt(req.query.userId as string, 10));
      where = `WHERE t.user_id = $1`;
    }
  } else {
    params.push(me.id);
    where = `WHERE t.user_id = $1`;
  }
  const { rows } = await query<any>(
    `SELECT ${LIST_COLS}
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN users cb ON cb.id = t.created_by
       ${where}
      ORDER BY t.created_at DESC`,
    params
  );
  res.json(rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    prefix: r.token_prefix,
    ownerName: r.owner_name,
    ownerUsername: r.owner_username,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revoked: !!r.revoked_at,
  })));
});

// ---- DELETE /api/tokens/:id — revoke ----------------------------------------
// Owner or system admin only. Idempotent (revoking an already-revoked token is a
// no-op success).
router.delete('/:id', requireAuth, async (req: AuthedRequest, res) => {
  const me = req.user!;
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid token id.' });
  const tok = (await query<{ id: number; user_id: number; name: string; token_prefix: string; revoked_at: Date | null }>(
    `SELECT id, user_id, name, token_prefix, revoked_at FROM api_tokens WHERE id=$1`, [id]
  )).rows[0];
  if (!tok) return res.status(404).json({ error: 'Token not found.' });
  if (tok.user_id !== me.id && !me.isSystemAdmin) {
    return res.status(403).json({ error: 'You can only revoke your own tokens.' });
  }
  if (tok.revoked_at) return res.json({ ok: true, alreadyRevoked: true });

  await query(`UPDATE api_tokens SET revoked_at=now() WHERE id=$1`, [id]);
  await audit({
    userId: me.id, action: 'token.revoked', target: `token:${id}`,
    detail: `"${tok.name}" (prefix ${tok.token_prefix}…)`,
  });
  res.json({ ok: true });
});

export default router;
