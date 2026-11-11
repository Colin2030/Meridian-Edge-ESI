import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import multer from 'multer';
import { config } from '../config';
import { query } from '../db';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';
import { audit } from '../lib/audit';
import {
  IMPORTS_ROOT, RESET_MESSAGE, SOURCE_GONE_MESSAGE,
  walk, flattenImages, detectEdrmXml, findStagedSource,
} from '../lib/importRunner';

const router = Router();

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


// ---- Optional field-mapping parse -------------------------------------------
// The importer may bind its own column names to platform fields without renaming
// columns, e.g. {"DATESENT":"date","THREADID":"thread_id"}. Accept it as a JSON
// object or a JSON string in the multipart/body field `fieldMapping`. Returns a
// clean string->string map, or null when absent/empty/invalid (invalid is
// ignored rather than failing the whole import).
function parseFieldMapping(input: unknown): Record<string, string> | null {
  if (input == null || input === '') return null;
  let obj: any = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : null;
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
    const setName = (req.body?.name as string)?.trim() || path.basename(edrmXmlPath);
    // Enqueue only — the durable worker renders this one at a time and the row
    // survives a restart (resumed from the staged source). Return 202 promptly.
    const ins = await query<{ id: number }>(
      `INSERT INTO loadfile_imports (case_id, name, xml_filename, imported_by, status, phase, source_kind, original_files, enqueued_at)
       VALUES ($1,$2,$3,$4,'queued','parsing','edrm',$5, now()) RETURNING id`,
      [caseId, setName, path.basename(edrmXmlPath), req.user!.id, JSON.stringify(originalFiles)]
    );
    const importId = ins.rows[0].id;
    await audit({
      userId: req.user!.id, caseId, action: 'import.started',
      target: `import:${importId}`,
      detail: `${setName} — EDRM XML=${path.basename(edrmXmlPath)} (queued)`,
    });
    return res.status(202).json({
      importId,
      status: 'queued',
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

  const setName = (req.body?.name as string)?.trim() || path.basename(datPath);
  const fieldMapping = parseFieldMapping(req.body?.fieldMapping);
  void imagesDir; // flattened above so the worker finds _images/ when it claims this row

  // Create the import row as 'queued' so the durable worker renders it (one at a
  // time, restart-safe). The UI polls the same importId. Return 202 promptly.
  const ins = await query<{ id: number }>(
    `INSERT INTO loadfile_imports (case_id, name, dat_filename, opt_filename, imported_by, status, phase, source_kind, original_files, field_mapping, enqueued_at)
     VALUES ($1,$2,$3,$4,$5,'queued','parsing',$6,$7,$8, now()) RETURNING id`,
    [caseId, setName, path.basename(datPath), optPath ? path.basename(optPath) : null, req.user!.id, sourceKind, JSON.stringify(originalFiles), fieldMapping ? JSON.stringify(fieldMapping) : null]
  );
  const importId = ins.rows[0].id;

  await audit({
    userId: req.user!.id, caseId, action: 'import.started',
    target: `import:${importId}`,
    detail: `${setName} — DAT=${path.basename(datPath)}${optPath ? ', OPT=' + path.basename(optPath) : ', no OPT'}, ${copied} image file(s)${collisions.length ? ', ' + collisions.length + ' name collision(s) skipped' : ''} (queued)`,
  });

  res.status(202).json({
    importId,
    status: 'queued',
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
      const setName = (req.body?.name as string)?.trim() || path.basename(edrmXmlPath);
      // Enqueue as a 'path' import: the worker re-resolves the loadfile from the
      // recorded source location (original_files[0].path) when it claims the row.
      const ins = await query<{ id: number }>(
        `INSERT INTO loadfile_imports (case_id, name, xml_filename, imported_by, status, phase, source_kind, original_files, enqueued_at)
         VALUES ($1,$2,$3,$4,'queued','parsing','path',$5, now()) RETURNING id`,
        [caseId, setName, path.basename(edrmXmlPath), req.user!.id, JSON.stringify([{ path: sourceRoot, xml: path.basename(edrmXmlPath) }])]
      );
      const importId = ins.rows[0].id;
      await audit({
        userId: req.user!.id, caseId, action: 'import.started',
        target: `import:${importId}`,
        detail: `${setName} — network/folder location "${sourceRoot}" — EDRM XML=${path.basename(edrmXmlPath)} (queued)`,
      });
      cleanup(); // worker reads natives directly from the source location, not the local stage dir
      return res.status(202).json({
        importId,
        status: 'queued',
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
    const imageCount = allFiles.filter((p) => ['.tif', '.tiff', '.pdf'].includes(path.extname(p).toLowerCase())).length;

    const setName = (req.body?.name as string)?.trim() || path.basename(datPath);
    const fieldMapping = parseFieldMapping(req.body?.fieldMapping);

    // Record the import as 'queued' (source_kind='path'); when the worker claims
    // the row it re-resolves the loadfile and flattens images from the recorded
    // source location, so no local image copy is needed here.
    const ins = await query<{ id: number }>(
      `INSERT INTO loadfile_imports (case_id, name, dat_filename, opt_filename, imported_by, status, phase, source_kind, original_files, field_mapping, enqueued_at)
       VALUES ($1,$2,$3,$4,$5,'queued','parsing',$6,$7,$8, now()) RETURNING id`,
      [caseId, setName, path.basename(datPath), optPath ? path.basename(optPath) : null, req.user!.id, 'path', JSON.stringify([{ path: sourceRoot, dat: path.basename(datPath) }]), fieldMapping ? JSON.stringify(fieldMapping) : null]
    );
    const importId = ins.rows[0].id;

    await audit({
      userId: req.user!.id, caseId, action: 'import.started',
      target: `import:${importId}`,
      detail: `${setName} — network/folder location "${sourceRoot}" — DAT=${path.basename(datPath)}${optPath ? ', OPT=' + path.basename(optPath) : ', no OPT'}, ${imageCount} image file(s) (queued)`,
    });

    cleanup(); // worker reads/flattens from the source location, not the local stage dir

    return res.status(202).json({
      importId,
      status: 'queued',
      datFile: path.basename(datPath),
      optFile: optPath ? path.basename(optPath) : null,
      imageCount,
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
            i.error, i.source_kind, i.imported_at, i.enqueued_at, i.attempts,
            u.display_name AS imported_by_name
       FROM loadfile_imports i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.id=$1 AND i.case_id=$2`,
    [importId, caseId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  res.json(rows[0]);
};
router.get('/:caseId/imports/:importId', requireAuth, requireCaseRole('case_manager'), importStatusHandler);

// ---- Self-service retry / reset for stuck imports ---------------------------
// These re-run or clear an EXISTING import of an already-uploaded, pre-processed
// loadfile. They add NO new processing capability — retry uses the identical
// runImport/runEdrmImport path the upload handler uses, and is duplicate-safe
// (upsert on (case_id, control_number)).


// ---- POST /api/cases/:caseId/imports/:importId/reset ------------------------
// Mark an orphaned processing/failed row as failed (keeps the row for audit).
router.post('/:caseId/imports/:importId/reset', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const importId = parseInt(req.params.importId, 10);
  const { rows } = await query<any>(
    `SELECT id, status FROM loadfile_imports WHERE id=$1 AND case_id=$2`,
    [importId, caseId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  const imp = rows[0];
  if (!['queued', 'processing', 'failed'].includes(imp.status)) {
    return res.status(409).json({ error: `Only imports that are queued, still processing or already failed can be reset (this one is "${imp.status}").` });
  }
  await query(
    `UPDATE loadfile_imports SET status='failed', phase='failed', error=$2 WHERE id=$1`,
    [importId, RESET_MESSAGE]
  );
  await audit({
    userId: req.user!.id, caseId, action: 'import.reset',
    target: `import:${importId}`, detail: RESET_MESSAGE,
  });
  res.json({ ok: true, id: importId, status: 'failed', phase: 'failed', error: RESET_MESSAGE });
});

// ---- POST /api/cases/:caseId/imports/:importId/retry ------------------------
// Re-enqueue an existing import onto the durable worker queue. The worker
// resolves the staged source and re-runs the idempotent ingest (duplicate-safe),
// so a retried part goes through the exact same restart-survivable path as a
// fresh upload. Adds no new processing capability.
router.post('/:caseId/imports/:importId/retry', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const importId = parseInt(req.params.importId, 10);
  const { rows } = await query<any>(
    `SELECT id, name, status, dat_filename, opt_filename, xml_filename, source_kind, original_files, imported_by
       FROM loadfile_imports WHERE id=$1 AND case_id=$2`,
    [importId, caseId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Import not found' });
  const imp = rows[0];
  if (!['processing', 'failed'].includes(imp.status)) {
    return res.status(409).json({ error: `Only imports that are still processing or already failed can be retried (this one is "${imp.status}").` });
  }

  // Fast-fail with clear feedback when the staged source for an uploaded chunk is
  // gone. Network/folder ('path') imports re-resolve from their recorded source
  // location, so leave those to the worker.
  if (imp.source_kind !== 'path' && !findStagedSource(caseId, imp)) {
    return res.status(409).json({
      error: 'The source for this import is no longer staged on the server. Please re-upload this chunk to complete it.',
    });
  }

  await query(
    `UPDATE loadfile_imports SET status='queued', phase='parsing', enqueued_at=now(), error=NULL WHERE id=$1`,
    [importId]
  );
  await audit({
    userId: req.user!.id, caseId, action: 'import.retry',
    target: `import:${importId}`, detail: `${imp.name || 'Import'} — re-enqueued onto the durable import queue`,
  });

  res.status(202).json({ importId, status: 'queued', retried: true });
});

// ---- GET /api/cases/:caseId/imports — history list --------------------------
router.get('/:caseId/imports', requireAuth, requireCaseRole('case_manager'), async (req: AuthedRequest, res) => {
  const caseId = parseInt(req.params.caseId, 10);
  const { rows } = await query(
    `SELECT i.id, i.name, i.dat_filename, i.opt_filename, i.xml_filename, i.status, i.phase,
            i.doc_count, i.page_count, i.docs_total, i.docs_done, i.pages_done,
            i.error, i.source_kind, i.imported_at, i.enqueued_at, i.attempts,
            u.display_name AS imported_by_name,
            CASE WHEN i.status='queued'
                 THEN row_number() OVER (
                        PARTITION BY (i.status='queued')
                        ORDER BY i.enqueued_at ASC NULLS FIRST, i.id ASC)
                 END AS queue_position
       FROM loadfile_imports i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.case_id=$1
      ORDER BY i.imported_at DESC`,
    [caseId]
  );
  res.json(rows);
});

export default router;
