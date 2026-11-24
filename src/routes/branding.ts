import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getLoginLogo } from '../lib/settings';

// PUBLIC (no-auth) branding endpoints. The login page is pre-authentication, so the
// custom login logo and the flag telling the page whether one is set must both load
// without a session. This is cosmetic branding only — it exposes a single admin-
// uploaded image and nothing about cases, documents or any ESI data.
const router = Router();

// Resolve the absolute on-disk path of the stored logo, guarding against any path
// escaping the uploads root. Returns null if unset or missing.
function resolveLogoPath(storedPath: string): string | null {
  const abs = path.resolve(config.uploadsDir, storedPath);
  const root = path.resolve(config.uploadsDir) + path.sep;
  if (!abs.startsWith(root)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

// Tiny JSON describing whether a custom login logo is set (and its public URL), so
// Login.tsx knows whether to use the custom logo or the bundled default.
router.get('/branding', async (_req, res) => {
  // Never cache at the CDN/edge for long — a branding change should show promptly.
  res.set('Cache-Control', 'no-cache');
  try {
    const logo = await getLoginLogo();
    if (!logo || !resolveLogoPath(logo.storedPath)) {
      return res.json({ loginLogo: null });
    }
    return res.json({
      loginLogo: {
        url: '/api/branding/login-logo',
        mime: logo.mime,
        filename: logo.originalFilename,
        uploadedAt: logo.uploadedAt,
      },
    });
  } catch {
    // Degrade gracefully: if the settings table is unreachable, behave as "no custom logo".
    return res.json({ loginLogo: null });
  }
});

// Stream the current custom login logo as a static image blob. 404 when none is set
// so the frontend falls back to the bundled default.
router.get('/branding/login-logo', async (_req, res) => {
  try {
    const logo = await getLoginLogo();
    if (!logo) return res.status(404).end();
    const abs = resolveLogoPath(logo.storedPath);
    if (!abs) return res.status(404).end();
    res.set('Cache-Control', 'no-cache');
    res.type(logo.mime || 'application/octet-stream');
    // Served as a static blob via <img>; browsers never execute scripts in an
    // image-loaded SVG, and helmet's CSP (img-src 'self') already applies.
    return res.sendFile(abs);
  } catch {
    return res.status(404).end();
  }
});

export default router;
