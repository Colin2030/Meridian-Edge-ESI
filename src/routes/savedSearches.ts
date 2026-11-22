import { Router } from 'express';
import { query } from '../db';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';

// ---------------------------------------------------------------------------
// Saved searches — per-user, per-case. A user can save the current search /
// filter state (which may be long or complex) and re-run it later with one
// click. Strictly view-only: this persists a query payload, nothing else.
//
// Permission model mirrors the rest of the case: requireCaseRole('read_only')
// gates access to the case, and every query is additionally scoped to the
// calling user's own id, so a user only ever sees / applies / deletes their own
// saved searches on cases they can access.
// ---------------------------------------------------------------------------

const router = Router();

const MAX_NAME_LEN = 120;
const MAX_PAYLOAD_BYTES = 8 * 1024; // generous ceiling for a filter payload

// List the current user's saved searches for a case (newest first).
router.get('/:caseId/saved-searches', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const u = req.user!;
  const rows = (await query<any>(
    `SELECT id, name, payload, created_at
       FROM saved_searches
      WHERE user_id=$1 AND case_id=$2
      ORDER BY created_at DESC`,
    [u.id, caseId]
  )).rows;
  res.json({ savedSearches: rows });
});

// Create a saved search for the current user on this case.
router.post('/:caseId/saved-searches', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const u = req.user!;
  const name = String(req.body?.name ?? '').trim();
  const payload = req.body?.payload ?? {};
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  if (name.length > MAX_NAME_LEN) return res.status(400).json({ error: `Name must be ${MAX_NAME_LEN} characters or fewer.` });
  if (typeof payload !== 'object' || Array.isArray(payload) || payload === null) {
    return res.status(400).json({ error: 'Invalid search payload.' });
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    return res.status(400).json({ error: 'Search payload is too large.' });
  }
  const row = (await query<any>(
    `INSERT INTO saved_searches (user_id, case_id, name, payload)
     VALUES ($1,$2,$3,$4::jsonb)
     RETURNING id, name, payload, created_at`,
    [u.id, caseId, name, JSON.stringify(payload)]
  )).rows[0];
  await audit({ userId: u.id, caseId, action: 'saved_search.create', target: name });
  res.status(201).json({ savedSearch: row });
});

// Delete one of the current user's saved searches.
router.delete('/:caseId/saved-searches/:id', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const u = req.user!;
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) return res.status(400).json({ error: 'Invalid id.' });
  // Scoped to owner — a user can only delete their own saved search.
  const r = await query<any>(
    `DELETE FROM saved_searches WHERE id=$1 AND user_id=$2 AND case_id=$3 RETURNING name`,
    [id, u.id, caseId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Saved search not found.' });
  await audit({ userId: u.id, caseId, action: 'saved_search.delete', target: r.rows[0].name });
  res.json({ ok: true });
});

export default router;
