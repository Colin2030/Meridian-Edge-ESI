import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { AuthedRequest, requireCaseRole } from '../middleware/auth';
import { query, withTx } from '../db';
import * as blobStore from '../lib/blobStore';
import { audit } from '../lib/audit';

// ---------------------------------------------------------------------------
// Case audit entries with attached report files (request 8), mounted under
// /api/v1/cases. APPEND-ONLY: entries and attachments may be created and read,
// but there is deliberately NO update or delete route anywhere in the app — a
// correction is a new entry that may reference a prior entryId.
//
// An integrator (e.g. Remontoire) posts an entry at the end of a pipeline stage,
// carrying one or more report files (PDF/HTML/JSON/CSV). The platform records the
// posting user + server time, stores each attachment in the content-addressed
// blob store (dedup), computes its SHA-256, and returns it. These entries appear
// in the web case history alongside the platform's own import.* audit events.
// ---------------------------------------------------------------------------

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 50 } });

interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// Accepted attachment types — validated by extension AND declared MIME.
const ALLOWED_EXT = new Set(['.pdf', '.html', '.htm', '.json', '.csv']);
const EXT_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

/** Validate an attachment by extension + declared MIME; return canonical mime or null. */
function validateAttachment(f: UploadedFile): { ok: true; ext: string; mime: string } | { ok: false } {
  const ext = path.extname(f.originalname || '').toLowerCase();
  if (!ALLOWED_EXT.has(ext)) return { ok: false };
  const declared = (f.mimetype || '').toLowerCase();
  // Accept a sensible declared MIME or fall back to the canonical one for the ext.
  const canonical = EXT_MIME[ext];
  const acceptable =
    declared === canonical ||
    (ext === '.json' && (declared.includes('json') || declared === 'text/plain' || declared === 'application/octet-stream')) ||
    (ext === '.csv' && (declared.includes('csv') || declared === 'text/plain' || declared === 'application/vnd.ms-excel' || declared === 'application/octet-stream')) ||
    ((ext === '.html' || ext === '.htm') && declared.includes('html')) ||
    (ext === '.pdf' && declared.includes('pdf')) ||
    declared === '' || declared === 'application/octet-stream';
  if (!acceptable) return { ok: false };
  return { ok: true, ext, mime: canonical };
}

function parseBody(req: AuthedRequest): any {
  // Multipart JSON body can arrive as a `body`/`manifest`/`metadata` text field,
  // or as individual form fields. Prefer a JSON text part.
  const raw = req.body?.body || req.body?.manifest || req.body?.metadata || req.body?.json;
  if (typeof raw === 'string' && raw.trim()) {
    try { return JSON.parse(raw); } catch { return { __parseError: true }; }
  }
  return req.body || {};
}

// ---- POST /cases/:caseId/audit-entries — create an append-only entry ---------
router.post('/:caseId/audit-entries', requireCaseRole('case_manager'), upload.any(), async (req: AuthedRequest, res, next) => {
  const caseId = (req as any).caseId as number;
  try {
    const body = parseBody(req);
    if (body.__parseError) {
      return res.status(400).json({ code: 'bad_request', item: 'body', error: 'Invalid JSON in the entry body.' });
    }
    const eventType = body.eventType;
    if (!eventType || typeof eventType !== 'string') {
      return res.status(400).json({ code: 'bad_request', item: 'eventType', error: 'eventType is required.' });
    }
    const source = body.source || {};
    const files = (req.files as UploadedFile[]) || [];

    // Validate all attachments up front (reject the whole entry if any is bad).
    const prepared: { f: UploadedFile; mime: string }[] = [];
    for (const f of files) {
      const v = validateAttachment(f);
      if (!v.ok) {
        return res.status(400).json({
          code: 'unsupported_attachment_type', item: f.originalname,
          error: `Attachment "${f.originalname}" is not an accepted type. Allowed: PDF, HTML, JSON, CSV.`,
        });
      }
      prepared.push({ f, mime: v.mime });
    }

    const created = await withTx(async (q) => {
      const { rows } = await q(
        `INSERT INTO audit_entries
           (case_id, event_type, occurred_at, summary, source_system, source_version, source_run_id, import_id, batch_id, posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, posted_at`,
        [
          caseId, eventType, body.occurredAt || null, body.summary || null,
          source.system || null, source.version || null, source.runId || null,
          body.importId || null, body.batchId || null, req.user!.id,
        ]
      );
      const entry = rows[0];
      const attachments: any[] = [];
      for (const { f, mime } of prepared) {
        // Store in the content-addressed blob store (dedup + SHA-256).
        const put = await blobStore.put(f.buffer, { mimeType: mime });
        const { rows: arows } = await q(
          `INSERT INTO audit_entry_attachments (entry_id, filename, mime_type, blob_sha256, byte_size)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [entry.id, f.originalname, mime, put.sha256, put.size]
        );
        attachments.push({
          id: arows[0].id, filename: f.originalname, mime, size: put.size, sha256: put.sha256, deduplicated: put.deduplicated,
        });
      }
      return { entry, attachments };
    });

    await audit({
      userId: req.user!.id, caseId, action: 'audit_entry.created',
      target: `audit_entry:${created.entry.id}`,
      detail: `${eventType} with ${created.attachments.length} attachment(s).`,
    });

    res.status(201).json({
      id: created.entry.id,
      caseId,
      eventType,
      occurredAt: body.occurredAt || null,
      summary: body.summary || null,
      source: { system: source.system || null, version: source.version || null, runId: source.runId || null },
      importId: body.importId || null,
      batchId: body.batchId || null,
      postedBy: { id: req.user!.id, username: req.user!.username },
      postedAt: created.entry.posted_at,
      attachments: created.attachments.map((a: any) => ({
        id: a.id, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// ---- GET /cases/:caseId/audit-entries — list newest first -------------------
router.get('/:caseId/audit-entries', requireCaseRole('read_only'), async (req: AuthedRequest, res, next) => {
  const caseId = (req as any).caseId as number;
  try {
    const { rows: entries } = await query<any>(
      `SELECT e.id, e.event_type, e.occurred_at, e.summary,
              e.source_system, e.source_version, e.source_run_id,
              e.import_id, e.batch_id, e.posted_by, e.posted_at,
              u.username AS posted_by_username
         FROM audit_entries e
         LEFT JOIN users u ON u.id = e.posted_by
        WHERE e.case_id=$1
        ORDER BY e.posted_at DESC, e.id DESC`,
      [caseId]
    );
    const ids = entries.map((e) => e.id);
    let attByEntry: Record<string, any[]> = {};
    if (ids.length) {
      const { rows: atts } = await query<any>(
        `SELECT id, entry_id, filename, mime_type, byte_size, blob_sha256
           FROM audit_entry_attachments WHERE entry_id = ANY($1::uuid[])
          ORDER BY created_at ASC, id ASC`,
        [ids]
      );
      for (const a of atts) {
        (attByEntry[a.entry_id] ||= []).push({
          id: a.id, filename: a.filename, mime: a.mime_type, size: a.byte_size != null ? Number(a.byte_size) : null, sha256: a.blob_sha256,
        });
      }
    }
    res.json(entries.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      occurredAt: e.occurred_at,
      summary: e.summary,
      source: { system: e.source_system, version: e.source_version, runId: e.source_run_id },
      importId: e.import_id,
      batchId: e.batch_id,
      postedBy: { id: e.posted_by, username: e.posted_by_username },
      postedAt: e.posted_at,
      attachments: attByEntry[e.id] || [],
    })));
  } catch (e) {
    next(e);
  }
});

// ---- GET /cases/:caseId/audit-entries/:entryId/attachments/:attachmentId ----
router.get('/:caseId/audit-entries/:entryId/attachments/:attachmentId', requireCaseRole('read_only'), async (req: AuthedRequest, res, next) => {
  const caseId = (req as any).caseId as number;
  const { entryId, attachmentId } = req.params;
  try {
    const { rows } = await query<{ filename: string; mime_type: string | null; blob_sha256: string | null }>(
      `SELECT a.filename, a.mime_type, a.blob_sha256
         FROM audit_entry_attachments a
         JOIN audit_entries e ON e.id = a.entry_id
        WHERE a.id=$1 AND a.entry_id=$2 AND e.case_id=$3`,
      [attachmentId, entryId, caseId]
    );
    if (!rows.length) {
      return res.status(404).json({ code: 'not_found', item: `attachment:${attachmentId}`, error: 'Attachment not found.' });
    }
    const a = rows[0];
    const p = a.blob_sha256 ? blobStore.getPath(a.blob_sha256) : null;
    if (!p) {
      return res.status(404).json({ code: 'not_found', item: `attachment:${attachmentId}`, error: 'Attachment content is not available on this server.' });
    }
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.filename)}"`);
    res.sendFile(p);
  } catch (e) {
    next(e);
  }
});

export default router;
