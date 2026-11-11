import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { config } from '../config';
import { query, withTx } from '../db';
import { parseDat, parseOpt, buildFieldMap, OptDocument, parseEdrmXml, EdrmFolderNode } from './loadfile';
import { deriveThread, deriveThreadId, normaliseSubject } from './threading';
import { decodeText, resolveRefPath, buildBasenameIndex, isoDateUtc } from './normalise';
import { resolveNativeMime } from './fileType';
import * as blobStore from './blobStore';

export interface ImportOptions {
  caseId: number;
  datPath: string;
  optPath?: string;
  imagesDir?: string;
  /** Package root used to resolve TEXTPATH / NATIVEPATH / TRANSLATEDTEXTPATH refs. Defaults to dirname(datPath). */
  sourceRoot?: string;
  /** Integrator sourceColumn -> platformField bindings, e.g. {"DATESENT":"date","THREADID":"thread_id"}. */
  fieldMapping?: Record<string, string> | null;
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

/** Recursively collect every file under a directory (local helper; avoids a circular import of importRunner). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Upsert one text version for a document into document_text, store/dedup large text
 * in the blob store, and maintain the per-version search_tsv. Returns the text so
 * the caller can fold every version into documents.search_tsv (cross-language
 * search via the EXISTING case search path). One version per (document, language,
 * kind) — a re-import overwrites in place.
 */
async function upsertDocumentText(
  documentId: number,
  version: {
    language: string;
    kind: 'extracted' | 'translation' | 'ocr';
    isOriginal: boolean;
    translatedFrom?: string | null;
    method?: 'machine' | 'human' | null;
    text: string;
  }
): Promise<string> {
  const text = version.text || '';
  const byteLength = Buffer.byteLength(text, 'utf8');
  // Store the text in the blob store (deduplicated) when it is large; small text
  // stays inline for cheap display. Either way the text is indexed below.
  let blobSha: string | null = null;
  if (byteLength >= 8192) {
    try {
      const r = await blobStore.put(Buffer.from(text, 'utf8'), { mimeType: 'text/plain' });
      blobSha = r.sha256;
    } catch { /* fall back to inline storage */ }
  }
  await query(
    `INSERT INTO document_text
       (document_id, language, kind, is_original, translated_from, method, blob_sha256, text_content, char_length, byte_length, search_tsv)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_tsvector('simple', coalesce($8,'')))
     ON CONFLICT (document_id, language, kind) DO UPDATE SET
       is_original=EXCLUDED.is_original, translated_from=EXCLUDED.translated_from, method=EXCLUDED.method,
       blob_sha256=EXCLUDED.blob_sha256, text_content=EXCLUDED.text_content,
       char_length=EXCLUDED.char_length, byte_length=EXCLUDED.byte_length, search_tsv=EXCLUDED.search_tsv`,
    [documentId, (version.language || 'und').toLowerCase(), version.kind, version.isOriginal,
     version.translatedFrom || null, version.method || null, blobSha, text || null, text.length, byteLength]
  );
  return text;
}

/** Read the first `n` bytes of a file (for content-based type detection) without loading it whole. */
function readHead(filePath: string, n = 4100): Buffer | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(n);
      const read = fs.readSync(fd, buf, 0, n, 0);
      return buf.subarray(0, read);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** Record a per-item import failure (code + control number + reason + the value that failed). */
async function recordFailure(
  caseId: number, importId: number,
  f: { controlNumber?: string; code: string; reason: string; failedValue?: string }
): Promise<void> {
  await query(
    `INSERT INTO import_failures (case_id, import_id, control_number, code, reason, failed_value)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [caseId, importId, f.controlNumber || null, f.code, f.reason, f.failedValue || null]
  );
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log || (() => {});
  const progress = opts.onProgress || (() => {});
  const datContent = fs.readFileSync(opts.datPath, 'utf8');
  const dat = parseDat(datContent);
  const fieldMap = buildFieldMap(dat.fields, opts.fieldMapping);
  // Package root: resolve TEXTPATH / NATIVEPATH / TRANSLATEDTEXTPATH references
  // against it. Build a basename index of every file under it so a reference still
  // resolves across nested TEXT\ / NATIVE\ dirs and Windows path separators (the
  // text files are NOT flattened into the images dir).
  const sourceRoot = opts.sourceRoot || path.dirname(opts.datPath);
  const basenameIndex = buildBasenameIndex(walkFiles(sourceRoot));
  log(`Parsed .DAT: ${dat.rows.length} records, delimiter=${dat.delimiterSet.kind}, control field=${fieldMap.control_number}, source root=${sourceRoot}`);
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

  // --- verification counters (request 9: account for every item) -------------
  let itemsCreated = 0, itemsUpdated = 0;
  let textIndexed = 0, textMissing = 0;
  let nativesStored = 0, imagesStored = 0;
  let threadsPopulated = 0, translationsCreated = 0;
  let failureCount = 0;
  const textByLanguage: Record<string, number> = {};
  // Columns bound to a platform field are "mapped"; the rest are preserved as
  // metadata only (unmapped_columns).
  const mappedSourceCols = new Set(Object.values(fieldMap).filter(Boolean) as string[]);
  const unmappedColumns = dat.fields.filter((f) => !mappedSourceCols.has(f));
  // Family post-pass: explicit parent links to resolve once every item is loaded.
  const parentRefs: { control: string; parent: string }[] = [];
  const allControlKeys = new Set<string>();

  const fail = async (f: { controlNumber?: string; code: string; reason: string; failedValue?: string }) => {
    await recordFailure(opts.caseId, setId, f);
    failureCount++;
  };

  for (const row of dat.rows) {
    const control = (fieldMap.control_number ? row[fieldMap.control_number] : '') || `DOC-${docCount + 1}`;
    const controlKey = control.toUpperCase();
    allControlKeys.add(controlKey);

    // --- Bug 1: TEXTPATH resolved relative to the package root, read UTF-8 ±BOM,
    // line-endings normalised, and INDEXED. A reference to a missing file is
    // counted as text_missing (never loaded as empty text that reads as "no text").
    const textRef = fieldMap.text_path ? (row[fieldMap.text_path] || '').trim() : '';
    let extractedText = '';
    let hasText = false;
    // A value with no path separators and no text-file extension, longer than a
    // short token, is treated as INLINE text (legacy behaviour); otherwise it is a
    // path to resolve and read.
    const looksInline = !!textRef && !/[\\/]/.test(textRef) && !/\.(txt|dat|text)$/i.test(textRef) && textRef.length > 40;
    if (textRef && looksInline) {
      extractedText = textRef;
      hasText = extractedText.length > 0;
    } else if (textRef) {
      const resolved = resolveRefPath(sourceRoot, textRef, basenameIndex);
      if (resolved) {
        try {
          extractedText = decodeText(fs.readFileSync(resolved)).trim();
          hasText = extractedText.length > 0;
        } catch (e: any) {
          await fail({ controlNumber: control, code: 'text_read_error', reason: `Could not read text file: ${e?.message || e}`, failedValue: textRef });
        }
      } else {
        textMissing++;
        await fail({ controlNumber: control, code: 'text_missing', reason: `Text file referenced by TEXTPATH was not found in the package`, failedValue: textRef });
        log(`! text missing for ${control}: ${textRef}`);
      }
    }

    // --- original / translation languages --------------------------------------
    const langField = fieldMap.language ? (row[fieldMap.language] || '').trim() : '';
    const translatedRef = fieldMap.translated_text_path ? (row[fieldMap.translated_text_path] || '').trim() : '';
    const translatedFromVal = fieldMap.translated_from ? (row[fieldMap.translated_from] || '').trim() : '';
    const translatedToVal = fieldMap.translated_to ? (row[fieldMap.translated_to] || '').trim() : '';
    // The original's language: the translation's source language when a translation
    // is present, else a declared language column, else undetermined.
    const originalLang = (translatedFromVal || langField || 'und').toLowerCase();

    // Determine pages from OPT (rendered review image).
    const od = optByKey.get(controlKey);
    const docDir = path.join(renderedRoot, controlKey.replace(/[^A-Za-z0-9_-]/g, '_'));
    fs.mkdirSync(docDir, { recursive: true });

    const pageImagePaths: string[] = [];
    let nativeType: 'tiff' | 'pdf' | 'none' | 'native' = 'none';
    let nativeRel: string | null = null;
    let firstExt = '';

    if (od) {
      let pageIdx = 0;
      for (const p of od.pages) {
        const resolved = resolveImagePath(p.fullPath, opts.imagesDir);
        if (!resolved) {
          log(`  ! missing image for ${control}: ${p.fullPath}`);
          continue;
        }
        const ext = path.extname(resolved).toLowerCase();
        if (!firstExt) firstExt = ext;
        // Preserve native: copy original (esp. for PDFs) for the legacy native_path.
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
    // The review image's format + page count (requests 1/4).
    const imageFormat: 'pdf' | 'tiff' | null = pageImagePaths.length ? (firstExt === '.pdf' ? 'pdf' : 'tiff') : null;
    const imagePageCount = pageImagePaths.length || null;
    if (pageImagePaths.length) imagesStored++;

    // --- Bug 2: native from NATIVEPATH stored content-addressed in the blob store.
    // The MIME type comes from the declared FILETYPE/MIMETYPE column, else content
    // detection — NEVER the image format. The original file name is kept separate
    // from the storage (hash) name.
    let nativeSha: string | null = null;
    let nativeFilename: string | null = null;
    let nativeStorageName: string | null = null;
    let nativeMime: string | null = null;
    const nativeRef = fieldMap.native_path ? (row[fieldMap.native_path] || '').trim() : '';
    const declaredType = fieldMap.file_type ? (row[fieldMap.file_type] || '').trim() : '';
    if (nativeRef) {
      const resolvedNative = resolveRefPath(sourceRoot, nativeRef, basenameIndex);
      if (resolvedNative) {
        try {
          nativeMime = resolveNativeMime(declaredType, path.basename(nativeRef.replace(/\\/g, '/')), readHead(resolvedNative));
          const put = await blobStore.putFile(resolvedNative, { mimeType: nativeMime || undefined });
          nativeSha = put.sha256;
          nativeStorageName = put.sha256;
          nativeFilename = path.basename(nativeRef.replace(/\\/g, '/'));
          nativesStored++;
          if (nativeType === 'none') nativeType = 'native';
        } catch (e: any) {
          await fail({ controlNumber: control, code: 'native_error', reason: `Could not store native: ${e?.message || e}`, failedValue: nativeRef });
        }
      } else {
        nativeFilename = path.basename(nativeRef.replace(/\\/g, '/'));
        nativeMime = declaredType ? resolveNativeMime(declaredType, nativeFilename, null) : null;
        await fail({ controlNumber: control, code: 'native_missing', reason: `Native file referenced by NATIVEPATH was not found in the package`, failedValue: nativeRef });
        log(`! native missing for ${control}: ${nativeRef}`);
      }
    } else if (declaredType) {
      // No native file, but a declared type was supplied — record it.
      nativeMime = resolveNativeMime(declaredType, fieldMap.filename ? row[fieldMap.filename] : undefined, null);
    }

    // OCR if enabled and no text yet (OCR is NOT ESI extraction — it reads text off
    // a supplied review image for search only; gated behind config.enableOcr).
    if (opts.ocr && !hasText && pageImagePaths.length > 0) {
      const texts: string[] = [];
      for (const rel of pageImagePaths) {
        texts.push(ocrImage(path.join(config.uploadsDir, rel)));
      }
      extractedText = texts.join('\n').trim();
      hasText = extractedText.length > 0;
    }

    // metadata = all fields, but keep the bulky text/translation path fields out of
    // the metadata panel. Normalise the date to ISO-8601 UTC, keeping the original.
    const metadata: Record<string, string> = { ...row };
    if (hasText && fieldMap.text_path && metadata[fieldMap.text_path] !== undefined) {
      delete metadata[fieldMap.text_path];
    }
    if (fieldMap.date && row[fieldMap.date]) {
      const d = isoDateUtc(row[fieldMap.date]);
      if (d.iso) metadata['Date (ISO-8601 UTC)'] = d.iso; // original value stays under its own column
    }
    if (nativeFilename) metadata['Native File Name'] = nativeFilename;
    if (nativeMime) metadata['Native Type'] = nativeMime;

    // --- Bug 3: threading from THREADID / THREADPOSITION / THREADSIZE columns
    // (+ thread subject, + optional MESSAGEID / INREPLYTO). Falls back to the
    // subject-derived grouping when no explicit thread id is supplied.
    let threadId: string | null = null;
    let threadSubject: string | null = null;
    let threadPosition: number | null = null;
    let threadSize: number | null = null;
    const subjectVal = fieldMap.subject ? row[fieldMap.subject] : '';
    const fromVal = fieldMap.from ? row[fieldMap.from] : '';
    const filenameVal = fieldMap.filename ? row[fieldMap.filename] : '';
    const explicitThreadId = fieldMap.thread_id ? (row[fieldMap.thread_id] || '').trim() : '';
    const explicitThreadSubject = fieldMap.thread_subject ? (row[fieldMap.thread_subject] || '').trim() : '';
    threadPosition = fieldMap.thread_position && row[fieldMap.thread_position] ? (parseInt(row[fieldMap.thread_position], 10) || null) : null;
    threadSize = fieldMap.thread_size && row[fieldMap.thread_size] ? (parseInt(row[fieldMap.thread_size], 10) || null) : null;
    const messageId = fieldMap.message_id ? (row[fieldMap.message_id] || '').trim() || null : null;
    const inReplyTo = fieldMap.in_reply_to ? (row[fieldMap.in_reply_to] || '').trim() || null : null;
    const looksLikeEmail = !!(fromVal && subjectVal) || /\.(eml|msg)$/i.test(filenameVal || '') || /\.(eml|msg)$/i.test(control || '');
    if (explicitThreadId) {
      // Supplied thread id wins. Namespace it to the case so ids never collide
      // across cases, and keep it stable/deterministic for the same supplied id.
      threadId = deriveThreadId(opts.caseId, `tid:${explicitThreadId}`);
      threadSubject = explicitThreadSubject || (subjectVal ? normaliseSubject(subjectVal) : null);
    } else if (looksLikeEmail && subjectVal) {
      const t = deriveThread(opts.caseId, subjectVal);
      if (t) { threadId = t.threadId; threadSubject = t.threadSubject; }
    }
    if (threadId) threadsPopulated++;

    // --- Family by explicit parent (request 7): PARENTID -> parent_control_number.
    const parentControl = fieldMap.parent_control_number ? (row[fieldMap.parent_control_number] || '').trim() : '';
    if (parentControl) parentRefs.push({ control, parent: parentControl });

    // Provenance: which engine produced the item (if a column carries it).
    const processedBy = (row['PROCESSEDBY'] || row['ProcessedBy'] || row['processedBy'] || '').trim() || null;

    const docRow = await query<{ id: number; was_overwrite: boolean }>(
      `INSERT INTO documents (case_id, set_id, control_number, native_type, native_path, page_count,
         has_text, extracted_text, metadata, thread_id, thread_subject, thread_position, thread_size,
         message_id, in_reply_to, parent_control_number, native_filename, native_storage_name,
         native_sha256, native_mime, image_format, image_page_count, processed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (case_id, control_number) DO UPDATE SET set_id=EXCLUDED.set_id, native_type=EXCLUDED.native_type,
         native_path=EXCLUDED.native_path, page_count=EXCLUDED.page_count, has_text=EXCLUDED.has_text,
         extracted_text=EXCLUDED.extracted_text, metadata=EXCLUDED.metadata,
         thread_id=EXCLUDED.thread_id, thread_subject=EXCLUDED.thread_subject,
         thread_position=EXCLUDED.thread_position, thread_size=EXCLUDED.thread_size,
         message_id=EXCLUDED.message_id, in_reply_to=EXCLUDED.in_reply_to,
         parent_control_number=EXCLUDED.parent_control_number, native_filename=EXCLUDED.native_filename,
         native_storage_name=EXCLUDED.native_storage_name, native_sha256=EXCLUDED.native_sha256,
         native_mime=EXCLUDED.native_mime, image_format=EXCLUDED.image_format,
         image_page_count=EXCLUDED.image_page_count, processed_by=EXCLUDED.processed_by
       RETURNING id, (xmax <> 0) AS was_overwrite`,
      [opts.caseId, setId, control, nativeType, nativeRel, pageImagePaths.length,
       hasText, extractedText || null, JSON.stringify(metadata), threadId, threadSubject, threadPosition, threadSize,
       messageId, inReplyTo, parentControl || null, nativeFilename, nativeStorageName,
       nativeSha, nativeMime, imageFormat, imagePageCount, processedBy]
    );
    const docId = docRow.rows[0].id;
    // xmax<>0 on the ON CONFLICT path => the row already existed and was updated
    // in place (a control number re-used from a prior chunk/import or duplicated
    // within this one). Record + log it so chunked imports stay auditable.
    if (docRow.rows[0].was_overwrite) {
      overwritten.push(control);
      itemsUpdated++;
      log(`! overwrote control number for ${control}: existing document in this case updated in place (chunk/import overlap)`);
    } else {
      itemsCreated++;
    }

    await query(`DELETE FROM document_pages WHERE document_id=$1`, [docId]);
    for (let i = 0; i < pageImagePaths.length; i++) {
      await query(
        `INSERT INTO document_pages (document_id, page_no, image_path) VALUES ($1,$2,$3)
         ON CONFLICT (document_id, page_no) DO UPDATE SET image_path=EXCLUDED.image_path`,
        [docId, i + 1, pageImagePaths[i]]
      );
    }

    // --- text versions (document_text): the original/extracted text, plus one
    // translation from the loadfile (TRANSLATEDTEXTPATH + TRANSLATEDFROM). Each is
    // independently indexed; both are folded into documents.search_tsv below so the
    // EXISTING case search finds a document by its translation too (cross-language).
    let translationText = '';
    if (hasText) {
      await upsertDocumentText(docId, { language: originalLang, kind: 'extracted', isOriginal: true, text: extractedText });
      textIndexed++;
      textByLanguage[originalLang] = (textByLanguage[originalLang] || 0) + 1;
    }
    if (translatedRef) {
      const resolvedTr = resolveRefPath(sourceRoot, translatedRef, basenameIndex);
      if (resolvedTr) {
        try {
          translationText = decodeText(fs.readFileSync(resolvedTr)).trim();
          if (translationText) {
            const trLang = (translatedToVal || 'en').toLowerCase();
            await upsertDocumentText(docId, {
              language: trLang, kind: 'translation', isOriginal: false,
              translatedFrom: originalLang, method: 'machine', text: translationText,
            });
            translationsCreated++;
            textByLanguage[trLang] = (textByLanguage[trLang] || 0) + 1;
          }
        } catch (e: any) {
          await fail({ controlNumber: control, code: 'translation_read_error', reason: `Could not read translation: ${e?.message || e}`, failedValue: translatedRef });
        }
      } else {
        await fail({ controlNumber: control, code: 'translation_missing', reason: `Translation file referenced by TRANSLATEDTEXTPATH was not found`, failedValue: translatedRef });
        log(`! translation missing for ${control}: ${translatedRef}`);
      }
    }

    // search_tsv: metadata text (weight A) + all text versions (weight B).
    const metaText = Object.values(metadata).join(' ');
    const allVersionText = [extractedText, translationText].filter(Boolean).join('\n');
    await query(
      `UPDATE documents SET search_tsv =
         setweight(to_tsvector('english', coalesce($2,'')), 'A') ||
         setweight(to_tsvector('english', coalesce($3,'')), 'B')
       WHERE id=$1`,
      [docId, metaText, allVersionText]
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

  // --- Family post-pass (request 7): resolve explicit parent links now that every
  // item is loaded. A parent not found in the case is reported (with its child
  // flagged) rather than leaving the child as an unrelated document.
  let familiesLinked = 0;
  for (const { control, parent } of parentRefs) {
    let found = allControlKeys.has(parent.toUpperCase());
    if (!found) {
      const r = await query<{ one: number }>(
        `SELECT 1 AS one FROM documents WHERE case_id=$1 AND upper(control_number)=upper($2) LIMIT 1`,
        [opts.caseId, parent]
      );
      found = r.rows.length > 0;
    }
    if (found) {
      familiesLinked++;
    } else {
      await fail({ controlNumber: control, code: 'parent_not_found', reason: `Parent control number not found in the case`, failedValue: parent });
      // Flag the child so it is visibly orphaned, not silently unrelated.
      await query(
        `UPDATE documents SET metadata = metadata || jsonb_build_object('Parent Unresolved', $3::text)
         WHERE case_id=$1 AND control_number=$2`,
        [opts.caseId, control, parent]
      );
      log(`! parent not found for ${control}: ${parent}`);
    }
  }

  // --- per-import verification counts (request 9) ----------------------------
  const verification = {
    items_received: dat.rows.length,
    items_created: itemsCreated,
    items_updated: itemsUpdated,
    text_indexed: textIndexed,
    text_missing: textMissing,
    text_by_language: textByLanguage,
    natives_stored: nativesStored,
    images_stored: imagesStored,
    pages: totalPages,
    threads_populated: threadsPopulated,
    families_linked: familiesLinked,
    translations_created: translationsCreated,
    unmapped_columns: unmappedColumns,
    failures: failureCount,
  };

  await query(
    `UPDATE loadfile_imports SET doc_count=$2, page_count=$3, docs_done=$2, pages_done=$3,
       status='completed', phase='completed', verification=$4 WHERE id=$1`,
    [setId, docCount, totalPages, JSON.stringify(verification)]
  );
  log(`Import complete: ${docCount} documents, ${totalPages} pages, ${textIndexed} text indexed, ${textMissing} text missing, ${nativesStored} native(s) stored, ${threadsPopulated} threaded, ${familiesLinked} family link(s), ${translationsCreated} translation(s)${failureCount ? `, ${failureCount} failure(s)` : ''}${overwritten.length ? `, ${overwritten.length} updated in place` : ''}`);
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

    // Email conversation threading (view-only): for email documents (DocType
    // "Message" / MIME message/rfc822, or where email fields are present), group by
    // the normalised subject so reviewers can follow a reply chain.
    let threadId: string | null = null;
    let threadSubject: string | null = null;
    const isEmail = d.docType === 'Message'
      || (d.mimeType || '').toLowerCase() === 'message/rfc822'
      || !!metadata['Email From'] || !!metadata['Email Subject'];
    const emailSubject = metadata['Email Subject'] || metadata['Subject'] || '';
    if (isEmail && emailSubject) {
      const t = deriveThread(opts.caseId, emailSubject);
      if (t) { threadId = t.threadId; threadSubject = t.threadSubject; }
    }

    // --- insert document -----------------------------------------------------
    const docRow = await query<{ id: number; was_overwrite: boolean }>(
      `INSERT INTO documents (case_id, set_id, control_number, native_type, native_path, page_count, has_text, extracted_text, metadata, thread_id, thread_subject)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (case_id, control_number) DO UPDATE SET set_id=EXCLUDED.set_id, native_type=EXCLUDED.native_type,
         native_path=EXCLUDED.native_path, page_count=EXCLUDED.page_count, has_text=EXCLUDED.has_text,
         extracted_text=EXCLUDED.extracted_text, metadata=EXCLUDED.metadata,
         thread_id=EXCLUDED.thread_id, thread_subject=EXCLUDED.thread_subject
       RETURNING id, (xmax <> 0) AS was_overwrite`,
      [opts.caseId, setId, control, nativeType, nativeRel, pageImagePaths.length, hasText, extractedText || null, JSON.stringify(metadata), threadId, threadSubject]
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
