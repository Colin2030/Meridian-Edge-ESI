import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { query } from '../db';
import { AuthedRequest, requireAuth } from '../middleware/auth';

const router = Router();

// Serve rendered page images / native files, enforcing case access.
// Paths look like: case-<id>/rendered/... or case-<id>/native/...
router.get('/files/*', requireAuth, async (req: AuthedRequest, res) => {
  const rel = decodeURIComponent((req.params as any)[0] || '');
  // prevent traversal
  const abs = path.normalize(path.join(config.uploadsDir, rel));
  if (!abs.startsWith(config.uploadsDir + path.sep)) return res.status(400).json({ error: 'bad path' });
  const m = rel.match(/^case-(\d+)[/\\]/);
  if (!m) return res.status(400).json({ error: 'bad path' });
  const caseId = parseInt(m[1], 10);
  const u = req.user!;
  if (!u.isSystemAdmin) {
    const access = await query(`SELECT 1 FROM case_memberships WHERE user_id=$1 AND case_id=$2`, [u.id, caseId]);
    if (!access.rowCount) return res.status(403).json({ error: 'No access to this case' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file not found' });
  res.sendFile(abs);
});

export default router;
