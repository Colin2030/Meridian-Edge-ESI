import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import multer from 'multer';
import { config } from '../config';
import { query } from '../db';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';
import { runImport } from '../lib/ingest';
import { audit } from '../lib/audit';

const router = Router();

const IMPORTS_ROOT = path.join(config.uploadsDir, 'imports');

// ---- Multer: stage uploads on disk under a per-case incoming dir -------------
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    // Called once per file — reuse one stable dir for the whole request so DAT/OPT/images land together.
    let dir: string | undefined = (req as any)._stageDir;
    if (!dir) {
      const caseId = parseInt((req.params as any).caseId, 10);
      dir = path.join(IMPORTS_ROOT, String(caseId), `_incoming_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      fs.mkdirSync(dir, { recursive: true });
      (req as any)._stageDir = dir;
    }
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    // Preserve original name but strip any path components (security).
    cb(null, path.basename(file.originalname));
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 512 * 1024 * 1024, files: 2000 }, // nginx vhost allows 512m bodies
});

const IMAGE_EXTS = new Set(['.tif', '.tiff', '.pdf']);

/** Recursively collect all files under a directory. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Flatten image files (tiff/pdf) into a single images/ dir so basename resolution works regardless of archive nesting. */
function flattenImages(files: string[], imagesDir: string): { copied: number; collisions: string[] } {
  fs.mkdirSync(imagesDir, { recursive: true });
  let copied = 0;
  const collisions: string[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const dest = path.join(imagesDir, path.basename(f));
    if (fs.existsSync(dest)) { collisions.push(path.basename(f)); continue; }
    fs.copyFileSync(f, dest);
    copied++;
  }
  return { copied, collisions };
}

// ---- Background job: run the existing ingest pipeline ------------------------
function startIngestJob(args: {
  importId: number; caseId: number; datPath: string; optPath?: string; imagesDir: string;
  importedBy: number; setName: string; ocr: boolean;
}) {
  const warnings: string[] = [];
  const missing: string[] = [];
  const opts = {
    caseId: args.caseId,
    datPath: args.datPath,
    optPath: args.optPath,
    imagesDir: args.imagesDir,
    importedBy: args.importedBy,
    setName: args.setName,
    ocr: args.ocr,
    setId: args.importId,
    log: (m: string) => {
      const mm = m.trim();
      if (mm.startsWith('! missing image')) { missing.push(mm.replace(/^!\s*/, '')); }
      else if (mm.startsWith('!')) { warnings.push(mm.replace(/^!\s*/, '')); }
    },
  };
  // Fire-and-forget; errors are captured onto the import row.
  (async () => {
    try {
      const res = await runImport(opts);
      let note: string | null = null;
      if (missing.length) {
        const sample = missing.slice(0, 8).join('; ');
        note = `Completed with ${missing.length} missing image reference(s): ${sample}${missing.length > 8 ? ' …' : ''}`;
      }
      await query(`UPDATE loadfile_imports SET error=$2 WHERE id=$1`, [args.importId, note]);
      await audit({
        userId: args.importedBy, caseId: args.caseId, action: 'import.completed',
        target: `import:${args.importId}`,
        detail: `${res.docCount} documents, ${res.pageCount} pages (${args.setName})${note ? ' — ' + note : ''}`,
      });
    } catch (e: any) {
      const msg = (e?.message || String(e)).slice(0, 500);
      await query(`UPDATE loadfile_imports SET status='failed', phase='failed', error=$2 WHERE id=$1`, [args.importId, msg]);
      await audit({
        userId: args.importedBy, caseId: args.caseId, action: 'import.failed',
        target: `import:${args.importId}`, detail: msg,
      });
    }
  })();
}

// ---- POST /api/cases/:caseId/imports — upload + kick ingest ------------------
// RBAC: case_manager or above on the case (system_admin passes globally).
router.post('/:caseId/imports', requireAuth, requireCaseRole('case_manager'), upload.any(), async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const stageDir: string = (req as any)._stageDir;
  const uploaded = (req.files as Express.Multer.File[]) || [];
  const cleanup = () => { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ } };

  if (!stageDir || uploaded.length === 0) {
    if (stageDir) cleanup();
    return res.status(400).json({ error: 'No files were uploaded.' });
  }

  const originalFiles = uploaded.map((f) => ({ name: f.originalname, size: f.size }));

  // Expand any uploaded .zip archives into an extracted/ subdir.
  let sourceKind: 'zip' | 'files' = 'files';
  const extractedDir = path.join(stageDir, '_extracted');
  for (const f of uploaded) {
    if (path.extname(f.originalname).toLowerCase() === '.zip') {
      sourceKind = 'zip';
      fs.mkdirSync(extractedDir, { recursive: true });
      try {
        execFileSync('unzip', ['-o', '-qq', f.path, '-d', extractedDir], { stdio: 'ignore' });
      } catch {
        cleanup();
        return res.status(400).json({ error: `Could not read the ZIP archive "${f.originalname}". Please check it is a valid .zip.` });
      }
    }
  }

  // Gather every candidate file (direct uploads + anything extracted from zips).
  const allFiles = walk(stageDir).filter((p) => !p.endsWith('.zip'));

  const datFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.dat');
  const optFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.opt');

  if (datFiles.length === 0) {
    cleanup();
    return res.status(400).json({ error: 'No .DAT loadfile found in the upload. A Concordance .DAT metadata file is required.' });
  }
  const datPath = datFiles[0];
  const optPath = optFiles.length ? optFiles[0] : undefined;

  // Flatten TIFF/PDF images into images/ for reliable basename resolution.
  const imagesDir = path.join(stageDir, '_images');
  const { copied, collisions } = flattenImages(allFiles, imagesDir);
  if (copied === 0 && !optPath) {
    // No images and no OPT — nothing renderable. Still allow (metadata-only) but warn.
  }

  const ocr = req.query.ocr === 'true' || config.enableOcr;
  const setName = (req.body?.name as string)?.trim() || path.basename(datPath);

  // Create the import row up front (status 'pending') so the UI can poll immediately.
  const ins = await query<{ id: number }>(
    `INSERT INTO loadfile_imports (case_id, name, dat_filename, opt_filename, imported_by, status, phase, source_kind, original_files)
     VALUES ($1,$2,$3,$4,$5,'pending','parsing',$6,$7) RETURNING id`,
    [caseId, setName, path.basename(datPath), optPath ? path.basename(optPath) : null, req.user!.id, sourceKind, JSON.stringify(originalFiles)]
  );
  const importId = ins.rows[0].id;

  await audit({
    userId: req.user!.id, caseId, action: 'import.started',
    target: `import:${importId}`,
    detail: `${setName} — DAT=${path.basename(datPath)}${optPath ? ', OPT=' + path.basename(optPath) : ', no OPT'}, ${copied} image file(s)${collisions.length ? ', ' + collisions.length + ' name collision(s) skipped' : ''}`,
  });

  startIngestJob({
    importId, caseId, datPath, optPath, imagesDir,
    importedBy: req.user!.id, setName, ocr,
  });

  res.status(202).json({
    importId,
    status: 'pending',
    datFile: path.basename(datPath),
    optFile: optPath ? path.basename(optPath) : null,
    imageCount: copied,
    collisions,
  });
});

// ---- GET /api/cases/:caseId/imports/:importId — status ----------------------
router.get('/:caseId/imports/:importId', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const importId = parseInt(req.params.importId, 10);
  const { rows } = await query(
    `SELECT i.id, i.name, i.dat_filename, i.opt_filename, i.status, i.phase,
            i.docs_total, i.docs_done, i.pages_done, i.doc_count, i.page_count,
            i.error, i.source_kind, i.imported_at, u.display_name AS imported_by_name
       FROM loadfile_imports i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.id=$1 AND i.case_id=$2`,
    [importId, caseId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  res.json(rows[0]);
});

// ---- GET /api/cases/:caseId/imports — history list --------------------------
router.get('/:caseId/imports', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const { rows } = await query(
    `SELECT i.id, i.name, i.dat_filename, i.opt_filename, i.status, i.phase,
            i.doc_count, i.page_count, i.error, i.source_kind, i.imported_at,
            u.display_name AS imported_by_name
       FROM loadfile_imports i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.case_id=$1
      ORDER BY i.imported_at DESC`,
    [caseId]
  );
  res.json(rows);
});

export default router;
