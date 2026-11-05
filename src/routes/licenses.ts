import { Router } from 'express';
import { query, withTx } from '../db';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireSystemAdmin } from '../middleware/auth';
import {
  parseLicence, verifyLicence, getLicenceStatus, refreshLicenceCache,
} from '../lib/license';
import { LICENSE_PUBLIC_KEY_FINGERPRINT } from '../lib/licensePublicKey';

// Licence administration — system-admin only. Mounted under /api/admin.
const router = Router();

// GET /api/admin/licence — current licence status (+ public key fingerprint).
router.get('/licence', requireAuth, requireSystemAdmin, async (_req, res) => {
  const status = await getLicenceStatus();
  res.json({ ...status, publicKeyFingerprint: LICENSE_PUBLIC_KEY_FINGERPRINT });
});

// GET /api/admin/licence/history — installed licences, newest first.
router.get('/licence/history', requireAuth, requireSystemAdmin, async (_req, res) => {
  const { rows } = await query<any>(
    `SELECT l.id, l.licence_id, l.customer, l.seats, l.issued_at, l.valid_from, l.expires_at,
            l.notes, l.active, l.installed_at, u.display_name AS installed_by_name
       FROM licences l LEFT JOIN users u ON u.id = l.installed_by
      ORDER BY l.installed_at DESC, l.id DESC`
  );
  res.json(rows.map((r) => ({
    id: r.id,
    licenceId: r.licence_id,
    customer: r.customer,
    seats: r.seats,
    issuedAt: r.issued_at,
    validFrom: r.valid_from,
    expiresAt: r.expires_at,
    notes: r.notes,
    active: r.active,
    installedAt: r.installed_at,
    installedByName: r.installed_by_name,
  })));
});

// POST /api/admin/licence — upload a licence file (JSON body { licence: "<text>" }).
// Parse + verify; if invalid, 400 with the reason. If authentic, store, mark
// active (deactivating any previous active licence), refresh the cache and
// return the new status. Note: an authentic-but-expired licence is REJECTED on
// upload (you cannot install an already-dead licence), with a clear reason.
router.post('/licence', requireAuth, requireSystemAdmin, async (req: AuthedRequest, res) => {
  const text = (req.body?.licence ?? req.body?.file ?? '').toString();
  if (!text.trim()) return res.status(400).json({ error: 'No licence file provided.' });

  let env;
  try {
    env = parseLicence(text);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || 'Could not read the licence file.' });
  }

  const check = verifyLicence(env);
  if (!check.valid) return res.status(400).json({ error: check.reason || 'Licence is invalid.' });

  const p = env.payload;
  const until = Date.parse(p.expiresAt);
  // We accept an AUTHENTIC licence even if it is already expired (the admin may
  // be re-installing a known licence, or diagnosing). The status will clearly
  // report it as expired, and non-admin access is blocked accordingly — expiry
  // is enforced at access time, not refused at install time.

  await withTx(async (q) => {
    await q(`UPDATE licences SET active=FALSE WHERE active=TRUE`);
    await q(
      `INSERT INTO licences
         (licence_id, customer, seats, issued_at, valid_from, expires_at, notes, raw_licence, signature, installed_by, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)`,
      [p.licenceId, p.customer, p.seats, p.issuedAt, p.validFrom, p.expiresAt, p.notes || null, text.trim(), env.signature, req.user!.id]
    );
  });

  await refreshLicenceCache();
  await audit({
    userId: req.user!.id,
    action: 'licence.installed',
    target: `licence:${p.licenceId}`,
    detail: `${p.customer}, ${p.seats} seats, expires ${new Date(until).toISOString().slice(0, 10)}`,
  });

  const status = await getLicenceStatus();
  res.json({ ...status, publicKeyFingerprint: LICENSE_PUBLIC_KEY_FINGERPRINT });
});

export default router;
