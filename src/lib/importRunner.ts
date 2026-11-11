import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';
import { query } from '../db';
import { runImport, runEdrmImport } from './ingest';
import { isEdrmXml } from './loadfile';
import { audit } from './audit';

// ---------------------------------------------------------------------------
// Shared import source-resolution + run logic.
//
// Both the HTTP upload/path/retry endpoints and the durable background worker
// need to turn a loadfile_imports row into "where is the staged source, and how
// do I render it". That logic lives here so there is a single, tested path.
//
// VIEW-ONLY CONSTRAINT: this only re-runs the EXISTING ingest of an already
// pre-processed loadfile (Concordance DAT/OPT or EDRM XML). It adds no new
// processing/forensic capability. Re-running is duplicate-safe because ingest
// upserts documents ON CONFLICT (case_id, control_number) and pages ON CONFLICT
// (document_id, page_no), so a resume overwrites already-imported docs and
// continues rather than double-counting.
// ---------------------------------------------------------------------------

export const IMPORTS_ROOT = path.join(config.uploadsDir, 'imports');

const IMAGE_EXTS = new Set(['.tif', '.tiff', '.pdf']);

/** Standard message when an orphaned import's staged source is gone. */
export const RESET_MESSAGE =
  'Reset: processing was interrupted by a service restart and the source chunk is no longer staged — please re-upload this chunk to complete it.';

export const SOURCE_GONE_MESSAGE =
  'The source for this import is no longer staged on the server — please re-upload this chunk to complete it.';

/** Recursively collect all files under a directory. */
export function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Flatten image files (tiff/pdf) into a single images/ dir so basename resolution works regardless of archive nesting. */
export function flattenImages(files: string[], imagesDir: string): { copied: number; collisions: string[] } {
  fs.mkdirSync(imagesDir, { recursive: true });
  let copied = 0;
  const collisions: string[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const dest = path.join(imagesDir, path.basename(f));
    if (fs.existsSync(dest)) { collisions.push(path.basename(f)); continue; }
    try { fs.copyFileSync(f, dest); copied++; } catch { /* ignore individual copy errors */ }
  }
  return { copied, collisions };
}

/**
 * Detect an EDRM XML 1.2 loadfile among the candidate files. Returns the path of
 * the first `.xml` whose content sniffs as EDRM XML (checked cheaply from the file
 * head), or null when none is present.
 */
export function detectEdrmXml(files: string[]): string | null {
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

/**
 * Locate the staged _incoming_* source directory for an import, if it is still on
 * disk. Matches by the original uploaded file name(s) recorded on the row (chunk
 * zips are uniquely named per chunk), falling back to the sole incoming dir when
 * there is exactly one and it carries the expected .DAT/.XML loadfile.
 */
export function findStagedSource(caseId: number, imp: any): string | null {
  const caseDir = path.join(IMPORTS_ROOT, String(caseId));
  if (!fs.existsSync(caseDir)) return null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(caseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('_incoming_'))
      .map((e) => path.join(caseDir, e.name));
  } catch { return null; }
  if (dirs.length === 0) return null;

  const wantNames: string[] = Array.isArray(imp.original_files)
    ? imp.original_files.map((f: any) => (f && f.name ? path.basename(String(f.name)) : '')).filter(Boolean)
    : [];
  const loadfile = imp.dat_filename || imp.xml_filename || null;

  // 1. Strong match: a dir whose top level contains one of the original uploaded files.
  if (wantNames.length) {
    for (const dir of dirs) {
      let top: string[];
      try { top = fs.readdirSync(dir); } catch { continue; }
      if (wantNames.some((n) => top.includes(n))) return dir;
    }
  }

  // 2. Fallback: exactly one incoming dir that actually carries the loadfile.
  if (dirs.length === 1 && loadfile) {
    const dir = dirs[0];
    const extracted = path.join(dir, '_extracted');
    const hasLoadfile =
      (fs.existsSync(path.join(extracted, loadfile))) ||
      (fs.existsSync(dir) && fs.readdirSync(dir).includes(loadfile)) ||
      (fs.existsSync(extracted) && walk(extracted).some((p) => path.basename(p) === loadfile));
    if (hasLoadfile) return dir;
  }
  return null;
}

export type ResolvedSource =
  | { kind: 'edrm'; xmlPath: string; sourceRoot: string }
  | { kind: 'dat'; datPath: string; optPath?: string; imagesDir: string; sourceRoot: string }
  | { kind: 'missing' };

/**
 * Ensure a staged ZIP has been expanded into _extracted/. Safe to call when it
 * already exists (no-op) or when the source was uploaded as loose files.
 */
function ensureExtracted(stageDir: string): string {
  const extractedDir = path.join(stageDir, '_extracted');
  if (!fs.existsSync(extractedDir)) {
    let zips: string[] = [];
    try { zips = fs.readdirSync(stageDir).filter((f) => f.toLowerCase().endsWith('.zip')); } catch { /* ignore */ }
    if (zips.length) {
      fs.mkdirSync(extractedDir, { recursive: true });
      for (const z of zips) {
        execFileSync('unzip', ['-o', '-qq', path.join(stageDir, z), '-d', extractedDir], { stdio: 'ignore' });
      }
    }
  }
  return fs.existsSync(extractedDir) ? extractedDir : stageDir;
}

/**
 * Resolve where an import's source lives and how to render it, re-flattening
 * images as needed. Returns { kind: 'missing' } when the source is gone (the
 * caller then marks the row failed with a re-upload message). Idempotent.
 */
export function resolveImportSource(caseId: number, imp: any): ResolvedSource {
  // Network / folder location imports read the loadfile from the recorded path.
  if (imp.source_kind === 'path') {
    const sourceRoot: string | undefined = Array.isArray(imp.original_files) && imp.original_files[0]?.path
      ? String(imp.original_files[0].path)
      : undefined;
    if (!sourceRoot || !fs.existsSync(sourceRoot)) return { kind: 'missing' };
    const allFiles = walk(sourceRoot).filter((p) => !p.toLowerCase().endsWith('.zip'));
    const edrmXmlPath = detectEdrmXml(allFiles);
    if (edrmXmlPath) {
      return { kind: 'edrm', xmlPath: edrmXmlPath, sourceRoot: path.dirname(edrmXmlPath) };
    }
    const datFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.dat');
    if (datFiles.length === 0) return { kind: 'missing' };
    const optFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.opt');
    // Re-flatten images into a local worker staging dir so OPT basename refs resolve.
    const imagesDir = path.join(IMPORTS_ROOT, String(caseId), `_worker_images_${imp.id}`);
    if (!fs.existsSync(imagesDir) || fs.readdirSync(imagesDir).length === 0) {
      flattenImages(allFiles, imagesDir);
    }
    // sourceRoot = the recorded network/folder location: TEXTPATH / NATIVEPATH /
    // TRANSLATEDTEXTPATH refs are resolved against it (text/native files are not
    // flattened into imagesDir).
    return { kind: 'dat', datPath: datFiles[0], optPath: optFiles[0], imagesDir, sourceRoot };
  }

  // Upload imports (zip or loose files): discover the staged _incoming_* dir.
  const stageDir = findStagedSource(caseId, imp);
  if (!stageDir) return { kind: 'missing' };

  let scanRoot: string;
  try {
    scanRoot = ensureExtracted(stageDir);
  } catch {
    return { kind: 'missing' };
  }
  const allFiles = walk(scanRoot).filter((p) => !p.toLowerCase().endsWith('.zip'));

  const edrmXmlPath = detectEdrmXml(allFiles);
  if (edrmXmlPath) {
    return { kind: 'edrm', xmlPath: edrmXmlPath, sourceRoot: path.dirname(edrmXmlPath) };
  }

  const datFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.dat');
  if (datFiles.length === 0) return { kind: 'missing' };
  const optFiles = allFiles.filter((p) => path.extname(p).toLowerCase() === '.opt');

  // Reuse the already-flattened _images dir if present; otherwise flatten now.
  const imagesDir = path.join(stageDir, '_images');
  if (!fs.existsSync(imagesDir) || fs.readdirSync(imagesDir).length === 0) {
    flattenImages(allFiles, imagesDir);
  }
  // sourceRoot = the extracted package root; TEXTPATH / NATIVEPATH /
  // TRANSLATEDTEXTPATH refs resolve against it (they are not flattened into _images).
  return { kind: 'dat', datPath: datFiles[0], optPath: optFiles[0], imagesDir, sourceRoot: scanRoot };
}

/**
 * Run (or resume) a single claimed import to completion. Resolves the source,
 * runs the existing ingest pipeline, and writes the final status/notes. Throws
 * on hard failure so the worker can mark the row failed and move on. The source
 * being gone is NOT thrown — it returns { ok:false, reason:'missing' } so the
 * worker can mark it failed with the re-upload message without noise.
 */
export async function runClaimedImport(imp: any): Promise<{ ok: boolean; reason?: 'missing' }> {
  const caseId: number = imp.case_id;
  const importId: number = imp.id;
  const setName: string = imp.name || 'Import';
  const importedBy: number | null = imp.imported_by ?? null;

  const resolved = resolveImportSource(caseId, imp);
  if (resolved.kind === 'missing') {
    await query(
      `UPDATE loadfile_imports SET status='failed', phase='failed', error=$2 WHERE id=$1`,
      [importId, SOURCE_GONE_MESSAGE]
    );
    await audit({ userId: importedBy, caseId, action: 'import.failed', target: `import:${importId}`, detail: SOURCE_GONE_MESSAGE });
    return { ok: false, reason: 'missing' };
  }

  const warnings: string[] = [];
  const missing: string[] = [];

  if (resolved.kind === 'edrm') {
    const res = await runEdrmImport({
      caseId,
      xmlPath: resolved.xmlPath,
      sourceRoot: resolved.sourceRoot,
      importedBy,
      setName,
      setId: importId,
      log: (m: string) => {
        const mm = m.trim();
        if (mm.startsWith('! missing native')) missing.push(mm.replace(/^!\s*/, ''));
        else if (mm.startsWith('!')) warnings.push(mm.replace(/^!\s*/, ''));
      },
    });
    const notes: string[] = [];
    if (missing.length) {
      notes.push(`Completed with ${missing.length} missing native file reference(s): ${missing.slice(0, 8).join('; ')}${missing.length > 8 ? ' ...' : ''}`);
    }
    if (res.overwritten.length) {
      notes.push(`${res.overwritten.length} document(s) re-used a control number already present in this case and were updated in place (chunk/import overlap): ${res.overwritten.slice(0, 8).join('; ')}${res.overwritten.length > 8 ? ' ...' : ''}`);
    }
    const note = notes.length ? notes.join(' | ') : null;
    await query(`UPDATE loadfile_imports SET error=$2 WHERE id=$1`, [importId, note]);
    await audit({ userId: importedBy, caseId, action: 'import.completed', target: `import:${importId}`, detail: `${res.docCount} documents (EDRM XML, ${setName})${note ? ' — ' + note : ''}` });
    return { ok: true };
  }

  // Concordance DAT/OPT
  const res = await runImport({
    caseId,
    datPath: resolved.datPath,
    optPath: resolved.optPath,
    imagesDir: resolved.imagesDir,
    sourceRoot: resolved.sourceRoot,
    fieldMapping: imp.field_mapping ?? null,
    importedBy,
    setName,
    ocr: config.enableOcr,
    setId: importId,
    log: (m: string) => {
      const mm = m.trim();
      if (mm.startsWith('! missing image')) missing.push(mm.replace(/^!\s*/, ''));
      else if (mm.startsWith('!')) warnings.push(mm.replace(/^!\s*/, ''));
    },
  });
  const notes: string[] = [];
  if (missing.length) {
    notes.push(`Completed with ${missing.length} missing image reference(s): ${missing.slice(0, 8).join('; ')}${missing.length > 8 ? ' ...' : ''}`);
  }
  if (res.overwritten.length) {
    notes.push(`${res.overwritten.length} document(s) re-used a control number already present in this case and were updated in place (chunk/import overlap): ${res.overwritten.slice(0, 8).join('; ')}${res.overwritten.length > 8 ? ' ...' : ''}`);
  }
  const note = notes.length ? notes.join(' | ') : null;
  await query(`UPDATE loadfile_imports SET error=$2 WHERE id=$1`, [importId, note]);
  await audit({ userId: importedBy, caseId, action: 'import.completed', target: `import:${importId}`, detail: `${res.docCount} documents, ${res.pageCount} pages (${setName})${note ? ' — ' + note : ''}` });
  return { ok: true };
}
