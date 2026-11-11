import { Router } from 'express';
import multer from 'multer';
import { AuthedRequest, requireCaseRole } from '../middleware/auth';
import { query } from '../db';
import * as blobStore from '../lib/blobStore';
import { decodeText } from '../lib/normalise';
import { resolveNativeMime } from '../lib/fileType';
import { audit } from '../lib/audit';
import {
  BATCH_CONCURRENCY, ERROR_CODES, initialCounts, applyItemDeltas, emptyDeltas,
  startFinalise, buildStatus, ItemDeltas, BatchFailure,
} from '../lib/batchRunner';

// ============================================================================
// Item batch API (Phase 2, v1.4.0) — POST .../batches, .../items, .../commit,
// GET status + SSE events. Token-authenticated (router mounted under requireApiToken
// in v1.ts); each route enforces per-case RBAC. Items are ALREADY PROCESSED by the
// external pipeline — no extraction is performed here.
// ============================================================================

const router = Router({ mergeParams: true });

// In-memory multipart: a request carries up to a few hundred small manifests +
// their files. Memory storage keeps SHA-256 + dedup simple; large natives are
// bounded by the per-file limit below.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 5000 } });

type UploadedFile = { fieldname: string; originalname: string; mimetype: string; buffer: Buffer };

function fileMapOf(req: AuthedRequest): Map<string, UploadedFile> {
  const m = new Map<string, UploadedFile>();
  const files = (req.files as UploadedFile[]) || [];
  for (const f of files) if (!m.has(f.fieldname)) m.set(f.fieldname, f);
  return m;
}

// ---- POST /cases/:caseId/batches — open a batch -----------------------------
router.post('/:caseId/batches', requireCaseRole('case_manager'), async (req: AuthedRequest, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    const b = req.body || {};
    const expItems = b.expectedItems == null ? null : Number(b.expectedItems);
    const expFiles = b.expectedFiles == null ? null : Number(b.expectedFiles);
    const expBytes = b.expectedBytes == null ? null : Number(b.expectedBytes);
    const counts = initialCounts({ items: expItems, files: expFiles, bytes: expBytes });
    const { rows } = await query(
      `INSERT INTO batches (case_id, status, expected_items, expected_files, expected_bytes, counts, created_by)
         VALUES ($1,'open',$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [caseId, expItems, expFiles, expBytes, JSON.stringify(counts), req.user!.id]
    );
    await audit({ userId: req.user!.id, caseId, action: 'batch.opened', target: `batch:${rows[0].id}`,
      detail: `expected items=${expItems ?? '?'} files=${expFiles ?? '?'} bytes=${expBytes ?? '?'}` });
    res.status(201).json({
      batchId: rows[0].id,
      concurrency: BATCH_CONCURRENCY,
      expected: { items: expItems, files: expFiles, bytes: expBytes },
      status: 'open',
    });
  } catch (e) { next(e); }
});

// ---- POST /cases/:caseId/batches/:batchId/items — ingest a page of items -----
router.post('/:caseId/batches/:batchId/items', requireCaseRole('case_manager'), upload.any(), async (req: AuthedRequest, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    const batchId = String(req.params.batchId);
    const { rows: brows } = await query(`SELECT id, status FROM batches WHERE id=$1 AND case_id=$2`, [batchId, caseId]);
    if (!brows.length) return res.status(404).json({ code: 'batch_not_found', error: 'Batch not found' });
    if (brows[0].status !== 'open') {
      return res.status(409).json({ code: ERROR_CODES.BATCH_NOT_OPEN, error: `Batch is ${brows[0].status}, not open` });
    }

    // Manifest array: an inline JSON body field (items/manifest) or a file part.
    const files = fileMapOf(req);
    let manifestRaw: string | undefined = (req.body && (req.body.items || req.body.manifest)) as string | undefined;
    if (!manifestRaw && (files.get('items') || files.get('manifest'))) {
      manifestRaw = (files.get('items') || files.get('manifest'))!.buffer.toString('utf8');
    }
    let items: any[];
    try {
      const parsed = JSON.parse(manifestRaw || '[]');
      items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
    } catch {
      return res.status(400).json({ code: ERROR_CODES.INVALID_MANIFEST, error: 'items manifest is not valid JSON' });
    }

    const deltas: ItemDeltas = emptyDeltas();
    const results: any[] = [];

    for (const item of items) {
      const control = (item && typeof item.controlNumber === 'string') ? item.controlNumber.trim() : '';
      const itemErrors: BatchFailure[] = [];
      const itemFiles: { part: string; sha256: string; deduplicated: boolean }[] = [];
      if (!control) {
        const f: BatchFailure = { controlNumber: null, code: ERROR_CODES.MISSING_CONTROL_NUMBER, reason: 'Item has no controlNumber', failedValue: null };
        deltas.failures.push(f);
        results.push({ controlNumber: null, status: 'failed', errors: [f] });
        continue;
      }
      deltas.items_received++;
      try {
        // Upsert the batch_items row (idempotent on (batch_id, control_number)).
        await query(
          `INSERT INTO batch_items (batch_id, control_number, status) VALUES ($1,$2,'received')
             ON CONFLICT (batch_id, control_number) DO UPDATE SET status='received', updated_at=now()`,
          [batchId, control]
        );

        // --- native file (request 3) -------------------------------------------
        let nativeSha: string | null = null, nativeFilename: string | null = null, nativeMime: string | null = null;
        let nativeStorageName: string | null = null;
        if (item.native && item.native.part) {
          const f = files.get(item.native.part);
          if (!f) {
            itemErrors.push({ controlNumber: control, code: ERROR_CODES.MISSING_PART, reason: `Native part ${item.native.part} not present in request`, failedValue: item.native.part });
          } else {
            try {
              const put = await blobStore.put(f.buffer, { expectedSha256: item.native.sha256, mimeType: item.native.mimeType });
              nativeSha = put.sha256;
              nativeStorageName = put.sha256;
              nativeFilename = item.native.fileName || f.originalname || null;
              nativeMime = resolveNativeMime(item.native.mimeType, nativeFilename || undefined, f.buffer);
              itemFiles.push({ part: item.native.part, sha256: put.sha256, deduplicated: put.deduplicated });
              if (!put.deduplicated) deltas.natives_stored++;
              else deltas.natives_stored++; // count references stored; dedup still "stored for this item"
            } catch (e: any) {
              if (e && e.code === 'hash_mismatch') {
                itemErrors.push({ controlNumber: control, code: ERROR_CODES.HASH_MISMATCH, reason: e.message, failedValue: item.native.sha256 });
              } else throw e;
            }
          }
        }

        // --- review image (requests 1/4) ---------------------------------------
        let imageSha: string | null = null, imageFormat: string | null = null, imagePageCount: number | null = null;
        if (item.image && item.image.part) {
          const fmt = String(item.image.format || '').toLowerCase();
          if (fmt !== 'pdf' && fmt !== 'tiff') {
            itemErrors.push({ controlNumber: control, code: ERROR_CODES.UNSUPPORTED_IMAGE_FORMAT, reason: `Image format ${item.image.format} is not pdf or tiff`, failedValue: String(item.image.format) });
          } else {
            const f = files.get(item.image.part);
            if (!f) {
              itemErrors.push({ controlNumber: control, code: ERROR_CODES.MISSING_PART, reason: `Image part ${item.image.part} not present in request`, failedValue: item.image.part });
            } else {
              const put = await blobStore.put(f.buffer, { expectedSha256: item.image.sha256, mimeType: fmt === 'pdf' ? 'application/pdf' : 'image/tiff' });
              imageSha = put.sha256; imageFormat = fmt;
              imagePageCount = item.image.pageCount == null ? null : Number(item.image.pageCount);
              itemFiles.push({ part: item.image.part, sha256: put.sha256, deduplicated: put.deduplicated });
              deltas.images_stored++;
            }
          }
        }

        // --- text versions (requests 2/5) --------------------------------------
        const textVersions: { language: string; kind: string; isOriginal: boolean; translatedFrom: string | null; method: string | null; text: string }[] = [];
        const rawText = Array.isArray(item.text) ? item.text : [];
        let sawOriginal = false;
        for (const tv of rawText) {
          let text = '';
          if (tv.part) {
            const f = files.get(tv.part);
            if (!f) { itemErrors.push({ controlNumber: control, code: ERROR_CODES.MISSING_PART, reason: `Text part ${tv.part} not present`, failedValue: tv.part }); continue; }
            text = decodeText(f.buffer);
          } else if (typeof tv.inline === 'string') {
            text = tv.inline;
          } else if (typeof tv.content === 'string') {
            text = tv.content;
          } else if (typeof tv.text === 'string') {
            text = tv.text;
          }
          text = (text || '').trim();
          if (!text) continue;
          const kind = (tv.kind === 'translation' || tv.kind === 'ocr') ? tv.kind : 'extracted';
          const isOriginal = kind === 'extracted' && !sawOriginal;
          if (isOriginal) sawOriginal = true;
          textVersions.push({
            language: String(tv.language || 'und').toLowerCase(),
            kind, isOriginal,
            translatedFrom: tv.translatedFrom || null,
            method: (tv.method === 'machine' || tv.method === 'human') ? tv.method : null,
            text,
          });
        }
        const hasText = textVersions.length > 0;
        if (!hasText) deltas.text_missing++;

        // native_type is the VIEWER RENDER KIND (migration 013 note).
        const nativeType = imageFormat === 'pdf' ? 'pdf' : imageFormat === 'tiff' ? 'tiff' : (nativeSha ? 'native' : 'none');
        const metadata = (item.metadata && typeof item.metadata === 'object') ? item.metadata : {};
        const thread = item.thread || {};
        const threadId = thread.threadId ? String(thread.threadId) : null;
        if (threadId) deltas.threads_populated++;
        const originalText = textVersions.find((t) => t.isOriginal)?.text || '';

        const docRow = await query<{ id: number; was_overwrite: boolean }>(
          `INSERT INTO documents (case_id, set_id, control_number, native_type, native_path, page_count,
             has_text, extracted_text, metadata, thread_id, thread_subject, thread_position, thread_size,
             message_id, in_reply_to, parent_control_number, native_filename, native_storage_name,
             native_sha256, native_mime, image_sha256, image_format, image_page_count, processed_by)
           VALUES ($1,NULL,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
           ON CONFLICT (case_id, control_number) DO UPDATE SET native_type=EXCLUDED.native_type,
             page_count=EXCLUDED.page_count, has_text=EXCLUDED.has_text, extracted_text=EXCLUDED.extracted_text,
             metadata=EXCLUDED.metadata, thread_id=EXCLUDED.thread_id, thread_subject=EXCLUDED.thread_subject,
             thread_position=EXCLUDED.thread_position, thread_size=EXCLUDED.thread_size,
             message_id=EXCLUDED.message_id, in_reply_to=EXCLUDED.in_reply_to,
             parent_control_number=EXCLUDED.parent_control_number, native_filename=EXCLUDED.native_filename,
             native_storage_name=EXCLUDED.native_storage_name, native_sha256=EXCLUDED.native_sha256,
             native_mime=EXCLUDED.native_mime, image_sha256=EXCLUDED.image_sha256, image_format=EXCLUDED.image_format,
             image_page_count=EXCLUDED.image_page_count, processed_by=EXCLUDED.processed_by
           RETURNING id, (xmax <> 0) AS was_overwrite`,
          [caseId, control, nativeType, imagePageCount || 0, hasText, originalText || null, JSON.stringify(metadata),
           threadId, thread.subject || null, thread.position == null ? null : Number(thread.position),
           thread.size == null ? null : Number(thread.size), item.messageId || null, item.inReplyTo || null,
           item.parentControlNumber || null, nativeFilename, nativeStorageName, nativeSha, nativeMime,
           imageSha, imageFormat, imagePageCount, item.processedBy || null]
        );
        const docId = docRow.rows[0].id;
        const updated = docRow.rows[0].was_overwrite;
        if (updated) deltas.items_updated++; else deltas.items_created++;

        // text versions -> document_text (each independently FTS-indexed).
        for (const v of textVersions) {
          const byteLen = Buffer.byteLength(v.text, 'utf8');
          await query(
            `INSERT INTO document_text
               (document_id, language, kind, is_original, translated_from, method, blob_sha256, text_content, char_length, byte_length, search_tsv)
             VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9, to_tsvector('simple', coalesce($7,'')))
             ON CONFLICT (document_id, language, kind) DO UPDATE SET
               is_original=EXCLUDED.is_original, translated_from=EXCLUDED.translated_from, method=EXCLUDED.method,
               text_content=EXCLUDED.text_content, char_length=EXCLUDED.char_length, byte_length=EXCLUDED.byte_length,
               search_tsv=EXCLUDED.search_tsv`,
            [docId, v.language, v.kind, v.isOriginal, v.translatedFrom, v.method, v.text, v.text.length, byteLen]
          );
          deltas.text_indexed[v.language] = (deltas.text_indexed[v.language] || 0) + 1;
        }

        // Fold metadata + every text version into documents.search_tsv (cross-language).
        const metaText = Object.values(metadata).map((x) => String(x)).join(' ');
        const allText = textVersions.map((v) => v.text).join('\n');
        await query(
          `UPDATE documents SET search_tsv =
             setweight(to_tsvector('english', coalesce($2,'')), 'A') ||
             setweight(to_tsvector('english', coalesce($3,'')), 'B')
           WHERE id=$1`,
          [docId, metaText, allText]
        );
        await query(
          `INSERT INTO review_states (document_id, case_id, status) VALUES ($1,$2,'unreviewed')
             ON CONFLICT (document_id) DO NOTHING`,
          [docId, caseId]
        );
        await query(`UPDATE batch_items SET document_id=$2, status='indexed', updated_at=now() WHERE batch_id=$1 AND control_number=$3`,
          [batchId, docId, control]);

        // Persist per-item failures (non-fatal, e.g. text_missing, missing_part).
        if (!hasText) {
          itemErrors.push({ controlNumber: control, code: ERROR_CODES.TEXT_MISSING, reason: 'Item carried no searchable text', failedValue: null });
        }
        for (const err of itemErrors) {
          deltas.failures.push(err);
          await query(`INSERT INTO import_failures (case_id, batch_id, control_number, code, reason, failed_value) VALUES ($1,$2,$3,$4,$5,$6)`,
            [caseId, batchId, control, err.code, err.reason, err.failedValue ?? null]);
        }
        results.push({ controlNumber: control, status: updated ? 'updated' : 'created', documentId: docId, files: itemFiles, errors: itemErrors });
      } catch (e: any) {
        const f: BatchFailure = { controlNumber: control, code: ERROR_CODES.ITEM_ERROR, reason: (e?.message || String(e)).slice(0, 300), failedValue: null };
        deltas.failures.push(f);
        await query(`UPDATE batch_items SET status='failed', updated_at=now() WHERE batch_id=$1 AND control_number=$2`, [batchId, control]).catch(() => {});
        await query(`INSERT INTO import_failures (case_id, batch_id, control_number, code, reason) VALUES ($1,$2,$3,$4,$5)`,
          [caseId, batchId, control, f.code, f.reason]).catch(() => {});
        results.push({ controlNumber: control, status: 'failed', errors: [f] });
      }
    }

    await applyItemDeltas(batchId, deltas);
    res.status(200).json({ batchId, received: results.length, concurrency: BATCH_CONCURRENCY, items: results });
  } catch (e) { next(e); }
});

// ---- POST /cases/:caseId/batches/:batchId/commit — close + finalise async ---
router.post('/:caseId/batches/:batchId/commit', requireCaseRole('case_manager'), async (req: AuthedRequest, res, next) => {
  try {
    const caseId = Number(req.params.caseId);
    const batchId = String(req.params.batchId);
    const { rows } = await query(`SELECT id, status FROM batches WHERE id=$1 AND case_id=$2`, [batchId, caseId]);
    if (!rows.length) return res.status(404).json({ code: 'batch_not_found', error: 'Batch not found' });
    if (rows[0].status !== 'open') return res.status(409).json({ code: ERROR_CODES.BATCH_NOT_OPEN, error: `Batch is ${rows[0].status}` });
    await query(`UPDATE batches SET status='committing', updated_at=now() WHERE id=$1`, [batchId]);
    await audit({ userId: req.user!.id, caseId, action: 'batch.committed', target: `batch:${batchId}` });
    startFinalise(batchId);
    res.status(202).json({ batchId, status: 'committing', message: 'Finalisation (rendering/linking) is running asynchronously. Poll the status endpoint.' });
  } catch (e) { next(e); }
});

// ---- GET /cases/:caseId/batches/:batchId — status ---------------------------
router.get('/:caseId/batches/:batchId', requireCaseRole('read_only'), async (req: AuthedRequest, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM batches WHERE id=$1 AND case_id=$2`, [req.params.batchId, Number(req.params.caseId)]);
    if (!rows.length) return res.status(404).json({ code: 'batch_not_found', error: 'Batch not found' });
    res.json(buildStatus(rows[0]));
  } catch (e) { next(e); }
});

// ---- GET /cases/:caseId/batches/:batchId/events — SSE -----------------------
router.get('/:caseId/batches/:batchId/events', requireCaseRole('read_only'), async (req: AuthedRequest, res, next) => {
  try {
    const batchId = String(req.params.batchId);
    const caseId = Number(req.params.caseId);
    const { rows } = await query(`SELECT id FROM batches WHERE id=$1 AND case_id=$2`, [batchId, caseId]);
    if (!rows.length) return res.status(404).json({ code: 'batch_not_found', error: 'Batch not found' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    let closed = false;
    req.on('close', () => { closed = true; });
    const terminal = ['completed', 'completed_with_failures', 'failed'];
    const tick = async () => {
      if (closed) return;
      try {
        const { rows: br } = await query(`SELECT * FROM batches WHERE id=$1`, [batchId]);
        if (br.length) {
          const status = buildStatus(br[0]);
          res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
          if (terminal.includes(br[0].status)) { res.write('event: end\ndata: {}\n\n'); res.end(); return; }
        }
      } catch { /* ignore a transient read error */ }
      setTimeout(tick, 1500);
    };
    tick();
  } catch (e) { next(e); }
});

export default router;
