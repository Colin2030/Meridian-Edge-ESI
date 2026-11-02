import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';
import { query, withTx } from '../db';
import { parseDat, parseOpt, buildFieldMap, OptDocument } from './loadfile';

export interface ImportOptions {
  caseId: number;
  datPath: string;
  optPath?: string;
  imagesDir?: string;
  importedBy?: number | null;
  setName?: string;
  ocr?: boolean;
  log?: (msg: string) => void;
  /** Reuse an already-created loadfile_imports row (e.g. created by the upload route) instead of inserting a new one. */
  setId?: number;
  /** Live progress callback for the background job runner / status endpoint. */
  onProgress?: (p: { phase: 'parsing' | 'rendering'; docsDone: number; docsTotal: number; pagesDone: number }) => void;
}

export interface ImportResult {
  setId: number;
  docCount: number;
  pageCount: number;
}

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'ignore' });
}

/** Resolve an OPT page path against an images directory (handles relative/absolute, missing volume prefixes). */
function resolveImagePath(fullPath: string, imagesDir?: string): string | null {
  if (!fullPath) return null;
  const candidates: string[] = [];
  if (path.isAbsolute(fullPath) && fs.existsSync(fullPath)) return fullPath;
  if (imagesDir) {
    candidates.push(path.join(imagesDir, fullPath));
    candidates.push(path.join(imagesDir, path.basename(fullPath)));
    // path may contain backslashes (Windows loadfiles)
    const normalised = fullPath.replace(/\\/g, '/');
    candidates.push(path.join(imagesDir, normalised));
    candidates.push(path.join(imagesDir, path.basename(normalised)));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Render one source image file (TIFF/PDF) to PNG page(s) in destDir. Returns ordered page file paths. */
function renderToPages(srcPath: string, destDir: string, startIndex: number): string[] {
  const ext = path.extname(srcPath).toLowerCase();
  const out: string[] = [];
  const numSort = (re: RegExp) => (a: string, b: string) => {
    const na = parseInt((a.match(re) || [])[1] || '0', 10);
    const nb = parseInt((b.match(re) || [])[1] || '0', 10);
    return na - nb;
  };
  // Unique prefix per source file so multiple natives in one doc don't collide.
  const tag = `s${startIndex}`;
  if (ext === '.pdf') {
    sh('pdftoppm', ['-png', '-r', '120', srcPath, path.join(destDir, tag)]);
    const re = new RegExp(`^${tag}-(\\d+)\\.png$`);
    const produced = fs.readdirSync(destDir).filter((f) => re.test(f)).sort(numSort(re));
    for (const f of produced) out.push(path.join(destDir, f));
  } else {
    // TIFF (possibly multi-page) or other raster -> PNG per page
    sh('convert', ['-density', '120', srcPath, path.join(destDir, `${tag}-%03d.png`)]);
    const re = new RegExp(`^${tag}-(\\d+)\\.png$`);
    const produced = fs.readdirSync(destDir).filter((f) => re.test(f)).sort(numSort(re));
    for (const f of produced) out.push(path.join(destDir, f));
  }
  return out;
}

function ocrImage(imgPath: string): string {
  try {
    const base = imgPath.replace(/\.png$/i, '');
    execFileSync('tesseract', [imgPath, base, '--psm', '3'], { stdio: 'ignore' });
    const txtFile = `${base}.txt`;
    if (fs.existsSync(txtFile)) {
      const t = fs.readFileSync(txtFile, 'utf8');
      fs.unlinkSync(txtFile);
      return t;
    }
  } catch {
    /* ignore */
  }
  return '';
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log || (() => {});
  const progress = opts.onProgress || (() => {});
  const datContent = fs.readFileSync(opts.datPath, 'utf8');
  const dat = parseDat(datContent);
  const fieldMap = buildFieldMap(dat.fields);
  log(`Parsed .DAT: ${dat.rows.length} records, delimiter=${dat.delimiterSet.kind}, control field=${fieldMap.control_number}`);
  progress({ phase: 'parsing', docsDone: 0, docsTotal: dat.rows.length, pagesDone: 0 });

  let optDocs: OptDocument[] = [];
  if (opts.optPath && fs.existsSync(opts.optPath)) {
    optDocs = parseOpt(fs.readFileSync(opts.optPath, 'utf8'));
    log(`Parsed .OPT: ${optDocs.length} documents / ${optDocs.reduce((a, d) => a + d.pages.length, 0)} pages`);
  }

  // Index OPT docs by first image key (commonly == control number)
  const optByKey = new Map<string, OptDocument>();
  for (const od of optDocs) optByKey.set(od.firstKey.toUpperCase(), od);

  const renderedRoot = path.join(config.uploadsDir, `case-${opts.caseId}`, 'rendered');
  const nativeRoot = path.join(config.uploadsDir, `case-${opts.caseId}`, 'native');
  fs.mkdirSync(renderedRoot, { recursive: true });
  fs.mkdirSync(nativeRoot, { recursive: true });

  // Create import set row (or reuse one already created by the upload route).
  let setId: number;
  if (opts.setId) {
    setId = opts.setId;
    await query(
      `UPDATE loadfile_imports SET status='processing', phase='rendering', docs_total=$2 WHERE id=$1`,
      [setId, dat.rows.length]
    );
  } else {
    const setRow = await query<{ id: number }>(
      `INSERT INTO loadfile_imports (case_id, name, dat_filename, opt_filename, imported_by, doc_count, status, phase, docs_total)
       VALUES ($1,$2,$3,$4,$5,0,'processing','rendering',$6) RETURNING id`,
      [opts.caseId, opts.setName || path.basename(opts.datPath), path.basename(opts.datPath), opts.optPath ? path.basename(opts.optPath) : null, opts.importedBy ?? null, dat.rows.length]
    );
    setId = setRow.rows[0].id;
  }
  progress({ phase: 'rendering', docsDone: 0, docsTotal: dat.rows.length, pagesDone: 0 });

  let totalPages = 0;
  let docCount = 0;

  for (const row of dat.rows) {
    const control = (fieldMap.control_number ? row[fieldMap.control_number] : '') || `DOC-${docCount + 1}`;
    const controlKey = control.toUpperCase();
    const textField = fieldMap.text_path ? row[fieldMap.text_path] : '';
    let extractedText = '';
    let hasText = false;
    // If text field is actual text (not a path), use it directly.
    if (textField && !/[\\/].*\.(txt|dat)$/i.test(textField) && textField.length > 20) {
      extractedText = textField;
      hasText = true;
    }

    // Determine pages from OPT
    const od = optByKey.get(controlKey);
    const docDir = path.join(renderedRoot, controlKey.replace(/[^A-Za-z0-9_-]/g, '_'));
    fs.mkdirSync(docDir, { recursive: true });

    const pageImagePaths: string[] = [];
    let nativeType: 'tiff' | 'pdf' | 'none' = 'none';
    let nativeRel: string | null = null;

    if (od) {
      let pageIdx = 0;
      let firstExt = '';
      for (const p of od.pages) {
        const resolved = resolveImagePath(p.fullPath, opts.imagesDir);
        if (!resolved) {
          log(`  ! missing image for ${control}: ${p.fullPath}`);
          continue;
        }
        const ext = path.extname(resolved).toLowerCase();
        if (!firstExt) firstExt = ext;
        // Preserve native: copy original (esp. for PDFs)
        if (ext === '.pdf') {
          nativeType = 'pdf';
          const destNative = path.join(nativeRoot, `${controlKey.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`);
          if (!fs.existsSync(destNative)) fs.copyFileSync(resolved, destNative);
          nativeRel = path.relative(config.uploadsDir, destNative);
        } else {
          if (nativeType === 'none') nativeType = 'tiff';
        }
        const rendered = renderToPages(resolved, docDir, pageIdx);
        for (const rp of rendered) {
          pageIdx++;
          const rel = path.relative(config.uploadsDir, rp);
          pageImagePaths.push(rel);
        }
      }
    }

    // OCR if enabled and no text yet
    if (opts.ocr && !hasText && pageImagePaths.length > 0) {
      const texts: string[] = [];
      for (const rel of pageImagePaths) {
        texts.push(ocrImage(path.join(config.uploadsDir, rel)));
      }
      extractedText = texts.join('\n').trim();
      hasText = extractedText.length > 0;
    }

    // metadata = all fields, but keep the bulky extracted-text field out of the metadata panel
    const metadata: Record<string, string> = { ...row };
    if (hasText && fieldMap.text_path && metadata[fieldMap.text_path] !== undefined) {
      delete metadata[fieldMap.text_path];
    }

    const docRow = await query<{ id: number }>(
      `INSERT INTO documents (case_id, set_id, control_number, native_type, native_path, page_count, has_text, extracted_text, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (case_id, control_number) DO UPDATE SET set_id=EXCLUDED.set_id, native_type=EXCLUDED.native_type,
         native_path=EXCLUDED.native_path, page_count=EXCLUDED.page_count, has_text=EXCLUDED.has_text,
         extracted_text=EXCLUDED.extracted_text, metadata=EXCLUDED.metadata
       RETURNING id`,
      [opts.caseId, setId, control, nativeType, nativeRel, pageImagePaths.length, hasText, extractedText || null, JSON.stringify(metadata)]
    );
    const docId = docRow.rows[0].id;

    await query(`DELETE FROM document_pages WHERE document_id=$1`, [docId]);
    for (let i = 0; i < pageImagePaths.length; i++) {
      await query(
        `INSERT INTO document_pages (document_id, page_no, image_path) VALUES ($1,$2,$3)
         ON CONFLICT (document_id, page_no) DO UPDATE SET image_path=EXCLUDED.image_path`,
        [docId, i + 1, pageImagePaths[i]]
      );
    }

    // update tsvector (metadata text + extracted text)
    const metaText = Object.values(metadata).join(' ');
    await query(
      `UPDATE documents SET search_tsv =
         setweight(to_tsvector('english', coalesce($2,'')), 'A') ||
         setweight(to_tsvector('english', coalesce($3,'')), 'B')
       WHERE id=$1`,
      [docId, metaText, extractedText || '']
    );

    // ensure a review state row
    await query(
      `INSERT INTO review_states (document_id, case_id, status) VALUES ($1,$2,'unreviewed')
       ON CONFLICT (document_id) DO NOTHING`,
      [docId, opts.caseId]
    );

    totalPages += pageImagePaths.length;
    docCount++;
    progress({ phase: 'rendering', docsDone: docCount, docsTotal: dat.rows.length, pagesDone: totalPages });
    // Persist incremental progress so the status endpoint reflects it live.
    await query(`UPDATE loadfile_imports SET docs_done=$2, pages_done=$3 WHERE id=$1`, [setId, docCount, totalPages]);
  }

  await query(`UPDATE loadfile_imports SET doc_count=$2, page_count=$3, docs_done=$2, pages_done=$3, status='completed', phase='completed' WHERE id=$1`, [setId, docCount, totalPages]);
  log(`Import complete: ${docCount} documents, ${totalPages} pages`);
  return { setId, docCount, pageCount: totalPages };
}
