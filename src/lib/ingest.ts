import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';
import { query, withTx } from '../db';
import { parseDat, parseOpt, buildFieldMap, OptDocument, parseEdrmXml, EdrmFolderNode } from './loadfile';

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

export interface EdrmImportOptions {
  caseId: number;
  /** Path to the EDRM XML loadfile. */
  xmlPath: string;
  /** Export root where native paths are resolved from. Defaults to dirname(xmlPath). */
  sourceRoot?: string;
  importedBy?: number | null;
  setName?: string;
  /** Reuse an already-created loadfile_imports row instead of inserting a new one. */
  setId?: number;
  log?: (msg: string) => void;
  onProgress?: (p: { phase: 'parsing' | 'rendering'; docsDone: number; docsTotal: number; pagesDone: number }) => void;
}

export interface ImportResult {
  setId: number;
  docCount: number;
  pageCount: number;
  /**
   * Control numbers that were already present in the case (from a prior import /
   * chunk, or duplicated within this one) and whose document row was therefore
   * UPDATED in place rather than newly inserted (ON CONFLICT (case_id,
   * control_number) DO UPDATE). Surfaced so sequential chunked imports into one
   * case are auditable rather than silently last-wins. Empty when every control
   * number was new.
   */
  overwritten: string[];
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
  const overwritten: string[] = [];

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

    const docRow = await query<{ id: number; was_overwrite: boolean }>(
      `INSERT INTO documents (case_id, set_id, control_number, native_type, native_path, page_count, has_text, extracted_text, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (case_id, control_number) DO UPDATE SET set_id=EXCLUDED.set_id, native_type=EXCLUDED.native_type,
         native_path=EXCLUDED.native_path, page_count=EXCLUDED.page_count, has_text=EXCLUDED.has_text,
         extracted_text=EXCLUDED.extracted_text, metadata=EXCLUDED.metadata
       RETURNING id, (xmax <> 0) AS was_overwrite`,
      [opts.caseId, setId, control, nativeType, nativeRel, pageImagePaths.length, hasText, extractedText || null, JSON.stringify(metadata)]
    );
    const docId = docRow.rows[0].id;
    // xmax<>0 on the ON CONFLICT path => the row already existed and was updated
    // in place (a control number re-used from a prior chunk/import or duplicated
    // within this one). Record + log it so chunked imports stay auditable.
    if (docRow.rows[0].was_overwrite) {
      overwritten.push(control);
      log(`! overwrote control number for ${control}: existing document in this case updated in place (chunk/import overlap)`);
    }

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
  log(`Import complete: ${docCount} documents, ${totalPages} pages${overwritten.length ? `, ${overwritten.length} existing control number(s) updated in place` : ''}`);
  return { setId, docCount, pageCount: totalPages, overwritten };
}

// ============================================================================
// EDRM XML import path
// ----------------------------------------------------------------------------
// Maps an EDRM XML loadfile onto the existing document / folder / family model.
// It carries native files + metadata + relationships + folders. A re-processed
// export may additionally include a sibling images/ directory of rendered TIFF
// pages correlated to documents by filename (page 1 = <DocID>.tif, page N>=2 =
// <DocID>_000N.tif); when present these are rendered to PNG and stored as
// document_pages so the viewer can display them. A native-only export (no images/
// dir) gets page_count=0, as before. In both cases the native is stored and
// downloadable, and extracted_text is read directly from the native for text /
// email MIME types. No OCR, no forensic/processing step — this is a reader for
// processing-engine output.
// ============================================================================

/** MIME types whose native file is plain text we can index directly. */
function isTextualMime(mime: string): boolean {
  const m = (mime || '').toLowerCase();
  return m.startsWith('text/') || m === 'message/rfc822' || m === 'application/mbox';
}

/**
 * Decode a native buffer to text only if it is genuinely printable text.
 * Guards against binary files that carry a text/* MIME label (e.g. .DS_Store).
 */
function nativeToText(buf: Buffer): string {
  if (buf.length === 0) return '';
  // Reject obvious binary: NUL bytes.
  if (buf.includes(0)) return '';
  const text = buf.toString('utf8');
  // Count the UTF-8 replacement char and non-printable control chars.
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0xfffd) bad++;
    else if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  if (text.length > 0 && bad / text.length > 0.1) return '';
  return text;
}

/** Create case folders rows from the EDRM folder tree; returns docId → folderId[] map of placements. */
async function createEdrmFolders(
  caseId: number,
  setLabel: string,
  roots: EdrmFolderNode[]
): Promise<Map<string, number[]>> {
  const placements = new Map<string, number[]>();
  const addPlacement = (docId: string, folderId: number) => {
    const arr = placements.get(docId) || [];
    arr.push(folderId);
    placements.set(docId, arr);
  };

  const walkTree = async (node: EdrmFolderNode, parentId: number | null): Promise<void> => {
    const name = (node.name || '(unnamed)').slice(0, 500);
    const ins = await query<{ id: number }>(
      `INSERT INTO folders (case_id, name, parent_id) VALUES ($1,$2,$3) RETURNING id`,
      [caseId, name, parentId]
    );
    const folderId = ins.rows[0].id;
    for (const docId of node.docIds) addPlacement(docId, folderId);
    for (const child of node.children) await walkTree(child, folderId);
  };

  for (const root of roots) await walkTree(root, null);
  return placements;
}

export async function runEdrmImport(opts: EdrmImportOptions): Promise<ImportResult> {
  const log = opts.log || (() => {});
  const progress = opts.onProgress || (() => {});
  const exportRoot = opts.sourceRoot || path.dirname(opts.xmlPath);

  const xmlContent = fs.readFileSync(opts.xmlPath, 'utf8');
  const edrm = parseEdrmXml(xmlContent);
  log(`Parsed EDRM XML ${edrm.majorVersion}.${edrm.minorVersion}: ${edrm.documents.length} documents, ${edrm.relationships.length} relationships, ${edrm.documents.filter((d) => d.native).length} native file(s)`);
  progress({ phase: 'parsing', docsDone: 0, docsTotal: edrm.documents.length, pagesDone: 0 });

  // Field Key → human label (from <Fields>) for friendlier metadata keys.
  const fieldLabels = new Map<string, string>();
  for (const f of edrm.fields) if (f.key) fieldLabels.set(f.key, f.name || f.key);

  // Family lookup: childId → { parentId, type } from <Relationships>, and a
  // child-count per parent so parent docs can show how many items they contain.
  const relByChild = new Map<string, { parentId: string; type: string }>();
  const childCount = new Map<string, number>();
  for (const r of edrm.relationships) {
    if (r.childId) relByChild.set(r.childId, { parentId: r.parentId, type: r.type });
    if (r.parentId) childCount.set(r.parentId, (childCount.get(r.parentId) || 0) + 1);
  }

  // Rendered page images: a re-processed EDRM export may carry a sibling images/
  // directory of TIFFs correlated to documents by filename (page 1 = <DocID>.tif,
  // page N>=2 = <DocID>_000N.tif). The XML itself does not reference them. Build a
  // DocID -> ordered page-file map once. Native-only exports have no images/ dir.
  const imagesDir = path.join(exportRoot, 'images');
  const hasImagesDir = fs.existsSync(imagesDir) && fs.statSync(imagesDir).isDirectory();
  const imagesByDoc = new Map<string, { page: number; file: string }[]>();
  if (hasImagesDir) {
    let tifCount = 0;
    for (const file of fs.readdirSync(imagesDir)) {
      if (!/\.tif$/i.test(file)) continue;
      tifCount++;
      const m = file.match(/^(.*)_(\d{4})\.tif$/i);
      const base = m ? m[1] : file.replace(/\.tif$/i, '');
      const page = m ? parseInt(m[2], 10) : 1;
      const arr = imagesByDoc.get(base) || [];
      arr.push({ page, file });
      imagesByDoc.set(base, arr);
    }
    for (const arr of imagesByDoc.values()) arr.sort((a, b) => a.page - b.page);
    log(`Found images/ dir: ${tifCount} page image(s) across ${imagesByDoc.size} document(s)`);
  }

  const nativeRoot = path.join(config.uploadsDir, `case-${opts.caseId}`, 'native');
  fs.mkdirSync(nativeRoot, { recursive: true });
  const renderedRoot = path.join(config.uploadsDir, `case-${opts.caseId}`, 'rendered');
  if (hasImagesDir) fs.mkdirSync(renderedRoot, { recursive: true });

  // Import set row.
  let setId: number;
  if (opts.setId) {
    setId = opts.setId;
    await query(
      `UPDATE loadfile_imports SET status='processing', phase='rendering', docs_total=$2 WHERE id=$1`,
      [setId, edrm.documents.length]
    );
  } else {
    const setRow = await query<{ id: number }>(
      `INSERT INTO loadfile_imports (case_id, name, xml_filename, imported_by, doc_count, status, phase, docs_total, source_kind)
       VALUES ($1,$2,$3,$4,0,'processing','rendering',$5,'edrm') RETURNING id`,
      [opts.caseId, opts.setName || path.basename(opts.xmlPath), path.basename(opts.xmlPath), opts.importedBy ?? null, edrm.documents.length]
    );
    setId = setRow.rows[0].id;
  }
  progress({ phase: 'rendering', docsDone: 0, docsTotal: edrm.documents.length, pagesDone: 0 });

  // Create folders from the EDRM folder tree (prefixed so re-imports stay distinct
  // and the set is identifiable in the case folder list).
  let placements = new Map<string, number[]>();
  try {
    placements = await createEdrmFolders(opts.caseId, opts.setName || 'EDRM', edrm.folders);
    log(`Created ${[...new Set([...placements.values()].flat())].length ? 'folder tree' : 'no folders'} with ${placements.size} placed document(s)`);
  } catch (e: any) {
    log(`! folders: ${e?.message || e}`);
  }

  // docId → documents.id, filled as we insert, so folder placements can be linked.
  const docIdToDbId = new Map<string, number>();
  let docCount = 0;
  let nativeCopied = 0;
  let missingNatives = 0;
  let totalPages = 0;
  const overwritten: string[] = [];

  for (const d of edrm.documents) {
    const control = d.docId || d.fieldValues.ITEMID || `DOC-${docCount + 1}`;

    // --- native file ---------------------------------------------------------
    let nativeType: 'native' | 'none' = 'none';
    let nativeRel: string | null = null;
    let extractedText = '';
    let hasText = false;

    if (d.native && d.native.file) {
      const srcPath = path.join(exportRoot, d.native.dir || '', d.native.file);
      if (fs.existsSync(srcPath)) {
        // Preserve the native under the case native dir (dedup by file name, which
        // is the content SHA — identical content is stored once).
        const destNative = path.join(nativeRoot, d.native.file);
        if (!fs.existsSync(destNative)) {
          try { fs.copyFileSync(srcPath, destNative); nativeCopied++; } catch (e: any) { log(`! native copy failed for ${control}: ${e?.message || e}`); }
        }
        if (fs.existsSync(destNative)) {
          nativeType = 'native';
          nativeRel = path.relative(config.uploadsDir, destNative);
          // Index text for textual MIME types.
          if (isTextualMime(d.mimeType)) {
            try {
              extractedText = nativeToText(fs.readFileSync(destNative));
              hasText = extractedText.trim().length > 0;
            } catch { /* ignore */ }
          }
        }
      } else {
        missingNatives++;
        log(`! missing native for ${control}: ${path.join(d.native.dir || '', d.native.file)}`);
      }
    }

    // --- metadata ------------------------------------------------------------
    const metadata: Record<string, string> = {};
    // All field values, keyed by their human label where known.
    for (const [k, v] of Object.entries(d.fieldValues)) {
      if (v === undefined || v === null || v === '') continue;
      metadata[fieldLabels.get(k) || k] = v;
    }
    metadata['Doc Type'] = d.docType;
    if (d.mimeType) metadata['MIME Type'] = d.mimeType;
    if (d.location?.uriDecoded) metadata['Source Location'] = d.location.uriDecoded;
    if (d.location?.custodian && d.location.custodian !== 'Unknown') metadata['Custodian'] = d.location.custodian;
    // Family / attachment structure.
    const rel = relByChild.get(d.docId);
    if (rel && rel.parentId) {
      metadata['Parent Document'] = rel.parentId;
      metadata['Family Relationship'] = rel.type; // Container | Attachment
    } else if (d.parentId) {
      metadata['Parent Document'] = d.parentId;
    }
    const kids = childCount.get(d.docId);
    if (kids) metadata['Contains Items'] = String(kids);
    // Original (human-meaningful) filename from the native's source LocationURI, so
    // the list/viewer show e.g. "Contingency Plans.eml" rather than the SHA .bin.
    const displayName = d.location?.uriDecoded ? path.basename(d.location.uriDecoded) : '';
    if (displayName) metadata['File Name'] = displayName;

    // --- rendered pages ------------------------------------------------------
    // If a sibling images/ dir exists, render this doc's TIFF page(s) to PNG.
    const pageImagePaths: string[] = [];
    if (hasImagesDir) {
      const imgs = imagesByDoc.get(d.docId);
      if (imgs && imgs.length) {
        const docDir = path.join(renderedRoot, control.replace(/[^A-Za-z0-9_-]/g, '_'));
        fs.mkdirSync(docDir, { recursive: true });
        let pageIdx = 0;
        for (const img of imgs) {
          try {
            const rendered = renderToPages(path.join(imagesDir, img.file), docDir, pageIdx);
            for (const rp of rendered) {
              pageIdx++;
              pageImagePaths.push(path.relative(config.uploadsDir, rp));
            }
          } catch (e: any) {
            log(`! render failed for ${control} (${img.file}): ${e?.message || e}`);
          }
        }
      }
    }
    totalPages += pageImagePaths.length;

    // --- insert document -----------------------------------------------------
    const docRow = await query<{ id: number; was_overwrite: boolean }>(
      `INSERT INTO documents (case_id, set_id, control_number, native_type, native_path, page_count, has_text, extracted_text, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (case_id, control_number) DO UPDATE SET set_id=EXCLUDED.set_id, native_type=EXCLUDED.native_type,
         native_path=EXCLUDED.native_path, page_count=EXCLUDED.page_count, has_text=EXCLUDED.has_text,
         extracted_text=EXCLUDED.extracted_text, metadata=EXCLUDED.metadata
       RETURNING id, (xmax <> 0) AS was_overwrite`,
      [opts.caseId, setId, control, nativeType, nativeRel, pageImagePaths.length, hasText, extractedText || null, JSON.stringify(metadata)]
    );
    const dbId = docRow.rows[0].id;
    docIdToDbId.set(d.docId, dbId);
    // xmax<>0 => this control number already existed in the case and the row was
    // updated in place (chunk/import overlap), not newly inserted. Record + log.
    if (docRow.rows[0].was_overwrite) {
      overwritten.push(control);
      log(`! overwrote control number for ${control}: existing document in this case updated in place (chunk/import overlap)`);
    }

    // Rendered page rows (re-processed exports only; native-only has none).
    if (pageImagePaths.length > 0) {
      await query(`DELETE FROM document_pages WHERE document_id=$1`, [dbId]);
      for (let i = 0; i < pageImagePaths.length; i++) {
        await query(
          `INSERT INTO document_pages (document_id, page_no, image_path) VALUES ($1,$2,$3)
           ON CONFLICT (document_id, page_no) DO UPDATE SET image_path=EXCLUDED.image_path`,
          [dbId, i + 1, pageImagePaths[i]]
        );
      }
    }

    // search_tsv: metadata text (weight A) + extracted text (weight B).
    const metaText = Object.values(metadata).join(' ');
    await query(
      `UPDATE documents SET search_tsv =
         setweight(to_tsvector('english', coalesce($2,'')), 'A') ||
         setweight(to_tsvector('english', coalesce($3,'')), 'B')
       WHERE id=$1`,
      [dbId, metaText, extractedText || '']
    );

    await query(
      `INSERT INTO review_states (document_id, case_id, status) VALUES ($1,$2,'unreviewed')
       ON CONFLICT (document_id) DO NOTHING`,
      [dbId, opts.caseId]
    );

    docCount++;
    if (docCount % 50 === 0 || docCount === edrm.documents.length) {
      progress({ phase: 'rendering', docsDone: docCount, docsTotal: edrm.documents.length, pagesDone: totalPages });
      await query(`UPDATE loadfile_imports SET docs_done=$2, pages_done=$3 WHERE id=$1`, [setId, docCount, totalPages]);
    }
  }

  // --- link folder placements now that all documents exist -------------------
  let placed = 0;
  for (const [docId, folderIds] of placements) {
    const dbId = docIdToDbId.get(docId);
    if (!dbId) continue;
    for (const fid of folderIds) {
      await query(
        `INSERT INTO document_folders (document_id, folder_id) VALUES ($1,$2)
         ON CONFLICT (document_id, folder_id) DO NOTHING`,
        [dbId, fid]
      );
      placed++;
    }
  }

  await query(
    `UPDATE loadfile_imports SET doc_count=$2, page_count=$3, docs_done=$2, pages_done=$3, status='completed', phase='completed' WHERE id=$1`,
    [setId, docCount, totalPages]
  );
  log(`EDRM import complete: ${docCount} documents, ${totalPages} rendered page(s), ${nativeCopied} native file(s) stored, ${placed} folder placement(s)${missingNatives ? `, ${missingNatives} missing native(s)` : ''}${overwritten.length ? `, ${overwritten.length} existing control number(s) updated in place` : ''}`);
  return { setId, docCount, pageCount: totalPages, overwritten };
}
