import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import multer from 'multer';
import { config } from '../config';
import { query } from '../db';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';
import { runImport, runEdrmImport } from '../lib/ingest';
import { isEdrmXml } from '../lib/loadfile';
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
// Exported so the versioned public API (/api/v1) can reuse the exact same
// multipart staging (one stable per-request dir for DAT/OPT/images together).
// Forensic ESI deliveries are routinely multi-GB. The per-file size cap is
// driven by config.maxUploadBytes (env MAX_UPLOAD_BYTES): when 0 (the default)
// we omit `fileSize` entirely so multer applies NO per-file cap and streams the
// upload to disk (diskStorage), bounded only by available disk space on the
// imports staging dir. A positive value enforces a hard byte cap.
// The per-request FILE COUNT cap is config.maxUploadFiles (env MAX_UPLOAD_FILES,
// default 2000) — the only application-level per-request cap enforced here.
export const upload = multer({
  storage,
  limits: config.maxUploadBytes > 0
    ? { fileSize: config.maxUploadBytes, files: config.maxUploadFiles }
    : { files: config.maxUploadFiles },
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

/**
 * Detect an EDRM XML 1.2 loadfile among the candidate files. Returns the path of
 * the first `.xml` whose content sniffs as EDRM XML (checked cheaply from the file
 * head), or null when none is present. Used to autodetect EDRM vs Concordance DAT.
 */
function detectEdrmXml(files: string[]): string | null {
  for (const f of files) {
    if (path.extname(f).toLowerCase() !== '.xml') continue;
    let head = '';
    try {
      const fd = fs.openSync(f, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch { continue; }
    if (isEdrmXml(head)) return f;
  }
  return null;
}

// ---- Background job: run the EDRM XML ingest pipeline ------------------------
function startEdrmJob(args: {
  importId: number; caseId: number; xmlPath: string; sourceRoot: string;
  importedBy: number; setName: string;
}) {
  const warnings: string[] = [];
  const missing: string[] = [];
  const opts = {
    caseId: args.caseId,
    xmlPath: args.xmlPath,
    sourceRoot: args.sourceRoot,
    importedBy: args.importedBy,
    setName: args.setName,
    setId: args.importId,
    log: (m: string) => {
      const mm = m.trim();
      if (mm.startsWith('! missing native')) { missing.push(mm.replace(/^!\s*/, '')); }
      else if (mm.startsWith('!')) { warnings.push(mm.replace(/^!\s*/, '')); }
    },
  };
  // Fire-and-forget; errors are captured onto the import row.
  (async () => {
    try {
      const res = await runEdrmImport(opts);
      const notes: string[] = [];
      if (missing.length) {
        const sample = missing.slice(0, 8).join('; ');
        notes.push(`Completed with ${missing.length} missing native file reference(s): ${sample}${missing.length > 8 ? ' …' : ''}`);
      }
      if (res.overwritten.length) {
        const sample = res.overwritten.slice(0, 8).join('; ');
        notes.push(`${res.overwritten.length} document(s) re-used a control number already present in this case and were updated in place (chunk/import overlap): ${sample}${res.overwritten.length > 8 ? ' …' : ''}`);
      }
      const note: string | null = notes.length ? notes.join(' | ') : null;
      await query(`UPDATE loadfile_imports SET error=$2 WHERE id=$1`, [args.importId, note]);
      await audit({
        userId: args.importedBy, caseId: args.caseId, action: 'import.completed',
        target: `import:${args.importId}`,
        detail: `${res.docCount} documents (EDRM XML, ${args.setName})${note ? ' — ' + note : ''}`,
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

// ---- Server-side path validation (network / folder location source) ---------
// Resolves symlinks and `..`, confirms the path exists and is readable, and
// enforces that the *real* path sits within one of config.ingestAllowedRoots so
// the server cannot be tricked into reading arbitrary files (e.g. /etc).
type PathCheck =
  | { ok: true; sourceRoot: string; datFileHint?: string }
  | { ok: false; status: number; error: string };

function validateIngestPath(input: string): PathCheck {
  const raw = (input || '').trim();
  if (!raw) return { ok: false, status: 400, error: 'Please provide a folder path on the server.' };
  if (!path.isAbsolute(raw)) {
    return { ok: false, status: 400, error: 'The path must be an absolute path (for example /mnt/esi-shares/operation-kingfisher).' };
  }

  // Normalise and resolve the real path (follows symlinks, collapses `..`).
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(raw));
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { ok: false, status: 400, error: 'Path not found. Check the location exists and is mounted on the Meridian Edge server.' };
    if (e?.code === 'EACCES') return { ok: false, status: 400, error: 'Path not readable by the server. Check the mount permissions for the Meridian Edge service account.' };
    return { ok: false, status: 400, error: 'That path could not be read by the server.' };
  }

  // Security: the resolved real path must be inside an allowed root.
  const roots = config.ingestAllowedRoots;
  const allowed = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!allowed) {
    return { ok: false, status: 400, error: 'That location is not within an allowed ingest root. Ask an administrator to add it to INGEST_ALLOWED_ROOTS.' };
  }

  // Confirm readability and whether it is a file or directory.
  let stat: fs.Stats;
  try {
    fs.accessSync(real, fs.constants.R_OK);
    stat = fs.statSync(real);
  } catch (e: any) {
    if (e?.code === 'EACCES') return { ok: false, status: 400, error: 'Path not readable by the server. Check the mount permissions for the Meridian Edge service account.' };
    return { ok: false, status: 400, error: 'Path not found or not readable by the server.' };
  }

  if (stat.isDirectory()) {
    return { ok: true, sourceRoot: real };
  }
  if (stat.isFile()) {
    // A direct path to a .DAT (or any file) — use its parent dir as the source root.
    if (path.extname(real).toLowerCase() === '.dat') {
      return { ok: true, sourceRoot: path.dirname(real), datFileHint: real };
    }
    return { ok: true, sourceRoot: path.dirname(real) };
  }
  return { ok: false, status: 400, error: 'The path is neither a folder nor a file the server can read.' };
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
      const notes: string[] = [];
      if (missing.length) {
        const sample = missing.slice(0, 8).join('; ');
        notes.push(`Completed with ${missing.length} missing image reference(s): ${sample}${missing.length > 8 ? ' …' : ''}`);
      }
      if (res.overwritten.length) {
        const sample = res.overwritten.slice(0, 8).join('; ');
        notes.push(`${res.overwritten.length} document(s) re-used a control number already present in this case and were updated in place (chunk/import overlap): ${sample}${res.overwritten.length > 8 ? ' …' : ''}`);
      }
      const note: string | null = notes.length ? notes.join(' | ') : null;
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
// Exported handler so both the cookie route and the token-auth /api/v1 route
// run the IDENTICAL ingest kickoff.
export const uploadImportHandler = async (req: AuthedRequest, res: any) => {
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

  // ---- Autodetect EDRM XML 1.2 loadfile (third format alongside DAT/OPT) -----
  // If an EDRM XML loadfile is present, dispatch to the EDRM pipeline. Native
  // files are resolved relative to the folder containing the XML (its natives/
  // companion), so ZIP uploads — which preserve the directory tree — carry the
  // natives across intact.
  const edrmXmlPath = detectEdrmXml(allFiles);
  if (edrmXmlPath) {
    const sourceRoot = path.dirname(edrmXmlPath);
    const setName = (req.body?.name as string)?.trim() || path.basename(edrmXmlPath);
    const ins = await query<{ id: number }>(
      `INSERT INTO loadfile_imports (case_id, name, xml_filename, imported_by, status, phase, source_kind, original_files)
       VALUES ($1,$2,$3,$4,'pending','parsing','edrm',$5) RETURNING id`,
      [caseId, setName, path.basename(edrmXmlPath), req.user!.id, JSON.stringify(originalFiles)]
    );
    const importId = ins.rows[0].id;
    await audit({
      userId: req.user!.id, caseId, action: 'import.started',
      target: `import:${importId}`,
      detail: `${setName} — EDRM XML=${path.basename(edrmXmlPath)}`,
    });
    startEdrmJob({ importId, caseId, xmlPath: edrmXmlPath, sourceRoot, importedBy: req.user!.id, setName });
    return res.status(202).json({
      importId,
      status: 'pending',
      format: 'edrm',
      xmlFile: path.basename(edrmXmlPath),
    });
  }

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
};
router.post('/:caseId/imports', requireAuth, requireCaseRole('case_manager'), upload.any(), uploadImportHandler);

// ---- POST /api/cases/:caseId/imports/path — ingest from a network/folder location
// RBAC identical to the upload route (case_manager or above; system_admin global).
// Reads an already-processed Concordance loadfile from a server-reachable path
// (mounted SMB/NFS share or BLOB storage mounted as a path) instead of a browser
// upload. Reuses the exact same walk/flattenImages/startIngestJob pipeline.
export const pathImportHandler = async (req: AuthedRequest, res: any) => {
  const caseId = parseInt(req.params.caseId, 10);

  // 1. Validate the server-side path (absolute, exists, readable, within an allowed root).
  const check = validateIngestPath(req.body?.path);
  if (!check.ok) {
    return res.status(check.status).json({ error: check.error });
  }
  const { sourceRoot, datFileHint } = check;

  // 2. Local staging dir so copied images live on local disk for rendering.
  const stageDir = path.join(IMPORTS_ROOT, String(caseId), `_incoming_path_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(stageDir, { recursive: true });
  const cleanup = () => { try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ } };

  try {
    // 3. Walk the source location and locate the loadfile (reuse existing helpers).
    const allFiles = walk(sourceRoot);

    // ---- Autodetect EDRM XML 1.2 loadfile (third format alongside DAT/OPT) ----
    // Natives resolve relative to the folder containing the XML (its natives/
    // companion) — the on-disk tree at the network/folder location is read as-is.
    const edrmXmlPath = detectEdrmXml(allFiles);
    if (edrmXmlPath) {
      const edrmRoot = path.dirname(edrmXmlPath);
      const setName = (req.body?.name as string)?.trim() || path.basename(edrmXmlPath);
      const ins = await query<{ id: number }>(
        `INSERT INTO loadfile_imports (case_id, name, xml_filename, imported_by, status, phase, source_kind, original_files)
         VALUES ($1,$2,$3,$4,'pending','parsing','edrm',$5) RETURNING id`,
        [caseId, setName, path.basename(edrmXmlPath), req.user!.id, JSON.stringify([{ path: sourceRoot, xml: path.basename(edrmXmlPath) }])]
      );
      const importId = ins.rows[0].id;
      await audit({
        userId: req.user!.id, caseId, action: 'import.started',
        target: `import:${importId}`,
        detail: `${setName} — network/folder location "${sourceRoot}" — EDRM XML=${path.basename(edrmXmlPath)}`,
      });
      startEdrmJob({ importId, caseId, xmlPath: edrmXmlPath, sourceRoot: edrmRoot, importedBy: req.user!.id, setName });
      cleanup(); // EDRM reads natives directly from the source location, not the local stage dir
      return res.status(202).json({
        importId,
        status: 'pending',
        format: 'edrm',
        xmlFile: path.basename(edrmXmlPath),
        sourceKind: 'path',
      });
    }

    const datFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.dat');
    const optFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.opt');

    const datPath = datFileHint || (datFiles.length ? datFiles[0] : undefined);
    if (!datPath) {
      cleanup();
      return res.status(400).json({ error: 'No .DAT loadfile found at that location. A Concordance .DAT metadata file is required.' });
    }
    const optPath = optFiles.length ? optFiles[0] : undefined;

    // 4. Copy TIFF/PDF images into local _images/ so rendering reads from local disk.
    const imagesDir = path.join(stageDir, '_images');
    const { copied, collisions } = flattenImages(allFiles, imagesDir);

    const ocr = req.body?.ocr === true || req.body?.ocr === 'true' || config.enableOcr;
    const setName = (req.body?.name as string)?.trim() || path.basename(datPath);

    // 5. Record the import (source_kind='path', original_files holds the source path for audit/UI).
    const ins = await query<{ id: number }>(
      `INSERT INTO loadfile_imports (case_id, name, dat_filename, opt_filename, imported_by, status, phase, source_kind, original_files)
       VALUES ($1,$2,$3,$4,$5,'pending','parsing',$6,$7) RETURNING id`,
      [caseId, setName, path.basename(datPath), optPath ? path.basename(optPath) : null, req.user!.id, 'path', JSON.stringify([{ path: sourceRoot, dat: path.basename(datPath) }])]
    );
    const importId = ins.rows[0].id;

    await audit({
      userId: req.user!.id, caseId, action: 'import.started',
      target: `import:${importId}`,
      detail: `${setName} — network/folder location "${sourceRoot}" — DAT=${path.basename(datPath)}${optPath ? ', OPT=' + path.basename(optPath) : ', no OPT'}, ${copied} image file(s)${collisions.length ? ', ' + collisions.length + ' name collision(s) skipped' : ''}`,
    });

    // 6. Kick the SAME background ingest job used by the upload route.
    startIngestJob({
      importId, caseId, datPath, optPath, imagesDir,
      importedBy: req.user!.id, setName, ocr,
    });

    return res.status(202).json({
      importId,
      status: 'pending',
      datFile: path.basename(datPath),
      optFile: optPath ? path.basename(optPath) : null,
      imageCount: copied,
      collisions,
      sourceKind: 'path',
    });
  } catch (e: any) {
    cleanup();
    return res.status(400).json({ error: 'That location could not be read by the server.' });
  }
};
router.post('/:caseId/imports/path', requireAuth, requireCaseRole('case_manager'), pathImportHandler);

// ---- GET /api/cases/:caseId/imports/:importId — status ----------------------
export const importStatusHandler = async (req: AuthedRequest, res: any) => {
  const caseId = parseInt(req.params.caseId, 10);
  const importId = parseInt(req.params.importId, 10);
  const { rows } = await query(
    `SELECT i.id, i.name, i.dat_filename, i.opt_filename, i.xml_filename, i.status, i.phase,
            i.docs_total, i.docs_done, i.pages_done, i.doc_count, i.page_count,
            i.error, i.source_kind, i.imported_at, u.display_name AS imported_by_name
       FROM loadfile_imports i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.id=$1 AND i.case_id=$2`,
    [importId, caseId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  res.json(rows[0]);
};
router.get('/:caseId/imports/:importId', requireAuth, requireCaseRole('case_manager'), importStatusHandler);

// ---- GET /api/cases/:caseId/imports — history list --------------------------
router.get('/:caseId/imports', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const { rows } = await query(
    `SELECT i.id, i.name, i.dat_filename, i.opt_filename, i.xml_filename, i.status, i.phase,
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
