import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { query } from '../db';
import { config } from '../config';
import { audit } from '../lib/audit';
import { AuthedRequest, requireAuth, requireCaseRole } from '../middleware/auth';
import { fileTypeBucketSql } from '../lib/fileType';
import { displayDateSql, displaySubjectSql } from '../lib/displayFields';
import {
  parsePatternOptions, buildPattern, regexOperator, validatePattern,
  queryWithTimeout, PatternError, buildJsRegex, makeSnippet, leadingExcerpt,
} from '../lib/search';

const router = Router();

// Per-query timeout (ms) guarding GREP/regex scans against catastrophic patterns.
const PATTERN_TIMEOUT_MS = 8000;
const KEYWORD_TIMEOUT_MS = 20000;
const MAX_KEYWORD_TERMS = 500;
const MAX_DOCS_PER_TERM = 500;

// In-memory upload for the small keyword-list text file.
const keywordUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

// Search / list documents within a case (read_only+)
// Exported so the token-auth /api/v1 route can reuse the exact same listing,
// search, filtering and pagination logic.
export const listDocumentsHandler = async (req: AuthedRequest, res: any) => {
  const caseId = (req as any).caseId;
  const u = req.user!;
  const q = (req.query.q as string || '').trim();
  const mode = ((req.query.mode as string) || 'fulltext').toLowerCase() === 'pattern' ? 'pattern' : 'fulltext';
  const patternOpts = parsePatternOptions(req.query as any);
  const status = (req.query.status as string || '').trim();
  const tagId = req.query.tagId ? parseInt(req.query.tagId as string, 10) : null;
  const dateFrom = (req.query.dateFrom as string || '').trim();
  const dateTo = (req.query.dateTo as string || '').trim();
  const bookmarked = (req.query.bookmarked as string) === 'true';
  // File-type filter: accepts a comma-separated list and/or a repeated param
  // (?fileTypes=eml,csv or ?fileTypes=eml&fileTypes=csv). Normalised to a
  // lowercased, trimmed, de-duplicated set. Multiple types = OR (union).
  const rawFileTypes = req.query.fileTypes;
  const fileTypes = Array.from(new Set(
    (Array.isArray(rawFileTypes) ? rawFileTypes : [rawFileTypes])
      .flatMap((v) => String(v ?? '').split(','))
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  ));
  const sort = (req.query.sort as string) || 'control_number';
  const dir = ((req.query.dir as string) || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const offset = parseInt(req.query.offset as string) || 0;

  const where: string[] = ['d.case_id = $1', 'd.deleted_at IS NULL'];
  const params: any[] = [caseId];
  let rankSelect = '0 AS rank';
  const usePattern = mode === 'pattern' && !!q;
  let pattern = '';
  if (usePattern) {
    // GREP / regex mode — match extracted_text with a POSIX regex.
    pattern = buildPattern(q, patternOpts);
    const invalid = await validatePattern(pattern);
    if (invalid) return res.status(400).json({ error: `Invalid pattern: ${invalid}` });
    params.push(pattern);
    where.push(`d.extracted_text ${regexOperator(patternOpts.caseSensitive)} $${params.length}`);
  } else if (q) {
    // Full-text (tsvector) mode — unchanged, backwards compatible.
    params.push(q);
    where.push(`d.search_tsv @@ plainto_tsquery('english', $${params.length})`);
    rankSelect = `ts_rank(d.search_tsv, plainto_tsquery('english', $${params.length})) AS rank`;
  }
  if (status) {
    params.push(status);
    where.push(`rs.status = $${params.length}`);
  }
  if (tagId) {
    params.push(tagId);
    where.push(`EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id=d.id AND dt.tag_id=$${params.length})`);
  }
  // Resolve the document date from whichever date field variant a loadfile uses
  // (DATE / Date Sent / DATESENT / DateSent) so date-range filtering works across
  // all schemas (Concordance, EDRM XML, email corpora). See displayFields.ts.
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`${displayDateSql('d.metadata')} >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`${displayDateSql('d.metadata')} <= $${params.length}`);
  }
  if (fileTypes.length) {
    // Restrict to documents whose derived file-type bucket is in the selected
    // set (OR/union). lower() around the bucket makes the 'Unknown' bucket match
    // the lowercased input; the extension itself is already lowercased.
    params.push(fileTypes);
    where.push(`lower(${fileTypeBucketSql('d.metadata', 'd.native_type')}) = ANY($${params.length}::text[])`);
  }
  params.push(u.id);
  const bmParam = params.length;
  if (bookmarked) {
    where.push(`EXISTS (SELECT 1 FROM bookmarks b WHERE b.document_id=d.id AND b.user_id=$${bmParam})`);
  }

  const sortCol = ['control_number', 'rank', 'created_at', 'page_count'].includes(sort) ? sort : 'control_number';
  // rank only meaningful in full-text mode; pattern mode falls back to the chosen/default column.
  const orderBy = (!usePattern && q && sort === 'rank') ? `rank DESC` : `d.${sortCol === 'rank' ? 'control_number' : sortCol} ${dir}`;

  // Pattern mode also selects extracted_text so we can build highlight snippets.
  const extraSelect = usePattern ? ', d.extracted_text' : '';

  params.push(limit, offset);
  const sql = `
    SELECT d.id, d.control_number, d.native_type, d.page_count, d.has_text, d.created_at,
           d.metadata, d.thread_id, d.thread_subject, rs.status AS review_status, ${rankSelect}${extraSelect},
           CASE WHEN d.thread_id IS NULL THEN 1
                ELSE (SELECT count(*)::int FROM documents dt WHERE dt.case_id=d.case_id AND dt.thread_id=d.thread_id)
           END AS thread_count,
           EXISTS (SELECT 1 FROM bookmarks b WHERE b.document_id=d.id AND b.user_id=$${bmParam}) AS bookmarked,
           COALESCE((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'colour',t.colour))
                     FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=d.id), '[]') AS tags
    FROM documents d
    LEFT JOIN review_states rs ON rs.document_id=d.id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy}
    LIMIT $${params.length - 1} OFFSET $${params.length}`;

  // Slice exactly the params referenced by the WHERE clause (u.id/limit/offset may be unused there).
  const whereStr = where.join(' AND ');
  const maxWhereParam = Math.max(0, ...(whereStr.match(/\$(\d+)/g) || []).map((s) => parseInt(s.slice(1), 10)));
  const countParams = params.slice(0, maxWhereParam);
  const countSql = `SELECT count(*)::int AS total FROM documents d LEFT JOIN review_states rs ON rs.document_id=d.id WHERE ${whereStr}`;

  let rows: any[];
  let total: number;
  try {
    if (usePattern) {
      // Guard regex scans with a per-query statement_timeout.
      rows = (await queryWithTimeout<any>(sql, params, PATTERN_TIMEOUT_MS)).rows;
      total = (await queryWithTimeout<any>(countSql, countParams, PATTERN_TIMEOUT_MS)).rows[0].total;
    } else {
      rows = (await query<any>(sql, params)).rows;
      total = (await query<any>(countSql, countParams)).rows[0].total;
    }
  } catch (e: any) {
    if (e instanceof PatternError) return res.status(e.status).json({ error: e.message });
    throw e;
  }

  if (usePattern) {
    const re = buildJsRegex(q, patternOpts);
    for (const r of rows) {
      r.snippet = makeSnippet(r.extracted_text, re) || leadingExcerpt(r.extracted_text);
      delete r.extracted_text; // don't ship full text to the client
    }
    await audit({ userId: u.id, caseId, action: 'pattern_search', target: q, detail: `literal=${patternOpts.literal} case=${patternOpts.caseSensitive} word=${patternOpts.wholeWord} hits=${total}` });
  } else if (q) {
    await audit({ userId: u.id, caseId, action: 'search', target: q, detail: `fulltext hits=${total}` });
  }

  res.json({ total, limit, offset, mode, documents: rows });
};
router.get('/case/:caseId/documents', requireAuth, requireCaseRole('read_only'), listDocumentsHandler);

// ---- Keyword-list batch GREP (read_only+) -----------------------------------
// Upload a .txt of terms (one per line, # comments ignored) and grep every term
// across the case's extracted_text, returning a per-term + aggregated report.
router.post('/case/:caseId/search/keyword-list', requireAuth, requireCaseRole('read_only'), keywordUpload.single('file'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const u = req.user!;
  if (!req.file) return res.status(400).json({ error: 'Please upload a .txt keyword list (field name "file").' });

  const opts = parsePatternOptions(req.body || {});
  const filename = req.file.originalname || 'keywords.txt';

  // Parse terms: one per line, trim, drop blank lines and # comments, de-duplicate (keep first order).
  const raw = req.file.buffer.toString('utf8');
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const key = opts.caseSensitive ? t : t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(t);
  }
  if (terms.length === 0) return res.status(400).json({ error: 'No search terms found in the file (one term per line; lines starting with # are ignored).' });
  if (terms.length > MAX_KEYWORD_TERMS) return res.status(400).json({ error: `Too many terms: ${terms.length}. The maximum is ${MAX_KEYWORD_TERMS} per list.` });

  // Build a pattern per term and validate; invalid terms are reported inline, not fatal.
  const built = terms.map((term, idx) => ({ idx, term, pattern: buildPattern(term, opts), invalid: null as string | null }));
  const op = regexOperator(opts.caseSensitive);

  // Validate the whole batch optimistically first; only fall back to per-term
  // validation (to find the culprits) if something is invalid.
  const valid = built;
  let needPerTerm = false;
  for (const b of built) {
    const probe = await validatePattern(b.pattern).catch(() => 'validation failed');
    if (probe) { b.invalid = probe; needPerTerm = true; }
  }
  void needPerTerm;
  const runnable = valid.filter((b) => !b.invalid);

  // Aggregate structures.
  const perTerm = new Map<number, { term: string; hitCount: number; documents: { docId: number; controlNumber: string }[]; truncated: boolean }>();
  for (const b of built) perTerm.set(b.idx, { term: b.term, hitCount: 0, documents: [], truncated: false });
  const docMap = new Map<number, { docId: number; controlNumber: string; terms: string[] }>();

  if (runnable.length > 0) {
    // Single batched query: cross-join the term list (as VALUES) against the
    // case's documents, testing each term's regex. One pass, timeout-guarded.
    const valuesSql: string[] = [];
    const params: any[] = [caseId];
    for (const b of runnable) {
      params.push(b.idx, b.pattern);
      valuesSql.push(`($${params.length - 1}::int, $${params.length}::text)`);
    }
    const batchSql = `
      SELECT t.idx AS idx, d.id AS doc_id, d.control_number AS control_number
      FROM (VALUES ${valuesSql.join(',')}) AS t(idx, pat)
      JOIN documents d ON d.case_id = $1 AND d.extracted_text ${op} t.pat
      ORDER BY t.idx, d.control_number`;
    let batchRows: any[];
    try {
      batchRows = (await queryWithTimeout<any>(batchSql, params, KEYWORD_TIMEOUT_MS)).rows;
    } catch (e: any) {
      if (e instanceof PatternError) return res.status(e.status).json({ error: e.message });
      throw e;
    }
    for (const row of batchRows) {
      const pt = perTerm.get(row.idx)!;
      pt.hitCount += 1;
      if (pt.documents.length < MAX_DOCS_PER_TERM) pt.documents.push({ docId: row.doc_id, controlNumber: row.control_number });
      else pt.truncated = true;
      let dm = docMap.get(row.doc_id);
      if (!dm) { dm = { docId: row.doc_id, controlNumber: row.control_number, terms: [] }; docMap.set(row.doc_id, dm); }
      dm.terms.push(pt.term);
    }
  }

  const termsReport = built.map((b) => {
    const pt = perTerm.get(b.idx)!;
    return { term: b.term, invalid: b.invalid, hitCount: b.invalid ? 0 : pt.hitCount, documents: pt.documents, truncated: pt.truncated };
  });
  const documents = Array.from(docMap.values()).sort((a, b) => a.controlNumber.localeCompare(b.controlNumber));
  const zeroHitTerms = termsReport.filter((t) => !t.invalid && t.hitCount === 0).map((t) => t.term);
  const invalidTerms = termsReport.filter((t) => t.invalid).map((t) => ({ term: t.term, reason: t.invalid }));

  await audit({ userId: u.id, caseId, action: 'keyword_list_search', target: filename, detail: `terms=${terms.length} matchedDocs=${documents.length} literal=${opts.literal} case=${opts.caseSensitive} word=${opts.wholeWord}` });

  res.json({
    filename,
    termCount: terms.length,
    options: opts,
    terms: termsReport,
    documents,
    zeroHitTerms,
    invalidTerms,
    matchedDocumentCount: documents.length,
  });
});

// Document detail (read_only+)
router.get('/documents/:docId', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(`SELECT * FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const doc = rows[0];
  // enforce case access
  const role = await requireAccess(req, doc.case_id);
  if (!role) return res.status(403).json({ error: 'No access to this case' });

  const pages = (await query<any>(`SELECT page_no, image_path FROM document_pages WHERE document_id=$1 ORDER BY page_no`, [docId])).rows;
  const review = (await query<any>(`SELECT rs.status, rs.reviewed_at, u.display_name AS reviewed_by FROM review_states rs LEFT JOIN users u ON u.id=rs.reviewed_by WHERE rs.document_id=$1`, [docId])).rows[0] || { status: 'unreviewed' };
  const tags = (await query<any>(`SELECT t.id, t.name, t.colour FROM document_tags dt JOIN tags t ON t.id=dt.tag_id WHERE dt.document_id=$1`, [docId])).rows;
  const bookmarked = (await query<any>(`SELECT 1 FROM bookmarks WHERE document_id=$1 AND user_id=$2`, [docId, req.user!.id])).rowCount > 0;
  const comments = (await query<any>(`SELECT c.id, c.body, c.created_at, u.display_name, u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.document_id=$1 ORDER BY c.created_at ASC`, [docId])).rows;

  await audit({ userId: req.user!.id, caseId: doc.case_id, action: 'document_view', target: doc.control_number });
  // Conversation thread (view-only): count other messages in the same thread so
  // the viewer knows whether to offer a thread panel.
  let threadCount = 1;
  if (doc.thread_id) {
    threadCount = (await query<any>(`SELECT count(*)::int AS n FROM documents WHERE case_id=$1 AND thread_id=$2`, [doc.case_id, doc.thread_id])).rows[0].n;
  }

  res.json({
    id: doc.id, caseId: doc.case_id, controlNumber: doc.control_number,
    nativeType: doc.native_type, nativePath: doc.native_path, pageCount: doc.page_count,
    hasText: doc.has_text, extractedText: doc.extracted_text, metadata: doc.metadata,
    threadId: doc.thread_id, threadSubject: doc.thread_subject, threadCount,
    pages: pages.map((p) => ({ pageNo: p.page_no, url: `/api/files/${encodeURI(p.image_path)}` })),
    nativeUrl: doc.native_path ? `/api/files/${encodeURI(doc.native_path)}` : null,
    review, tags, bookmarked, comments, role,
  });
});

// Conversation thread siblings (read_only+): the other messages in this document's
// email thread, ordered chronologically by Date Sent. Powers the thread panel.
router.get('/documents/:docId/thread', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(`SELECT case_id, thread_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const { case_id: caseId, thread_id: threadId } = rows[0];
  const role = await requireAccess(req, caseId);
  if (!role) return res.status(403).json({ error: 'No access to this case' });
  if (!threadId) return res.json({ threadId: null, messages: [] });

  // Order by the resolved document date (Concordance DATE then EDRM Date Sent),
  // falling back to control number for stable ordering when dates are absent/equal.
  const messages = (await query<any>(
    `SELECT d.id, d.control_number, d.metadata,
            ${displayDateSql('d.metadata')} AS date_sent,
            ${displaySubjectSql('d.metadata')} AS subject,
            rs.status AS review_status
     FROM documents d LEFT JOIN review_states rs ON rs.document_id=d.id
     WHERE d.case_id=$1 AND d.thread_id=$2
     ORDER BY ${displayDateSql('d.metadata')} ASC NULLS LAST, d.control_number ASC`,
    [caseId, threadId]
  )).rows;

  res.json({
    threadId,
    messages: messages.map((m) => ({
      id: m.id,
      controlNumber: m.control_number,
      subject: m.subject || m.control_number,
      from: m.metadata?.FROM || m.metadata?.['Email From'] || '',
      to: m.metadata?.TO || m.metadata?.['Email To'] || '',
      date: m.date_sent || '',
      reviewStatus: m.review_status || 'unreviewed',
      current: m.id === docId,
    })),
  });
});

// Helper: check user's role for a given caseId
async function requireAccess(req: AuthedRequest, caseId: number): Promise<string | null> {
  const u = req.user!;
  if (u.isSystemAdmin) return 'system_admin';
  const { rows } = await query<any>(`SELECT role FROM case_memberships WHERE user_id=$1 AND case_id=$2`, [u.id, caseId]);
  return rows.length ? rows[0].role : null;
}

function canReview(role: string | null): boolean {
  return role === 'system_admin' || role === 'case_manager' || role === 'reviewer';
}

// Set review state (reviewer+)
router.put('/documents/:docId/review', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { status } = req.body || {};
  const valid = ['unreviewed', 'in_review', 'responsive', 'non_responsive', 'privileged', 'further_review'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'invalid status' });
  const { rows } = await query<any>(`SELECT case_id, control_number FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted to change review state' });
  await query(
    `INSERT INTO review_states (document_id, case_id, status, reviewed_by, reviewed_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (document_id) DO UPDATE SET status=EXCLUDED.status, reviewed_by=EXCLUDED.reviewed_by, reviewed_at=now()`,
    [docId, rows[0].case_id, status, req.user!.id]
  );
  await audit({ userId: req.user!.id, caseId: rows[0].case_id, action: 'review_state_change', target: rows[0].control_number, detail: status });
  res.json({ ok: true, status });
});

// Toggle bookmark (read_only+)
router.post('/documents/:docId/bookmark', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!role) return res.status(403).json({ error: 'No access' });
  const existing = await query(`SELECT 1 FROM bookmarks WHERE document_id=$1 AND user_id=$2`, [docId, req.user!.id]);
  if (existing.rowCount) {
    await query(`DELETE FROM bookmarks WHERE document_id=$1 AND user_id=$2`, [docId, req.user!.id]);
    res.json({ bookmarked: false });
  } else {
    await query(`INSERT INTO bookmarks (user_id, document_id, case_id) VALUES ($1,$2,$3)`, [req.user!.id, docId, rows[0].case_id]);
    res.json({ bookmarked: true });
  }
});

// Add/remove tag on document (reviewer+)
router.post('/documents/:docId/tags', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { tagId } = req.body || {};
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted to tag' });
  await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [docId, tagId]);
  await audit({ userId: req.user!.id, caseId: rows[0].case_id, action: 'tag_add', target: `doc:${docId}`, detail: `tag:${tagId}` });
  res.json({ ok: true });
});

router.delete('/documents/:docId/tags/:tagId', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted' });
  await query(`DELETE FROM document_tags WHERE document_id=$1 AND tag_id=$2`, [docId, req.params.tagId]);
  res.json({ ok: true });
});

// Comments (reviewer+ to post; read_only cannot comment)
router.post('/documents/:docId/comments', requireAuth, async (req: AuthedRequest, res) => {
  const docId = parseInt(req.params.docId, 10);
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });
  const { rows } = await query<any>(`SELECT case_id FROM documents WHERE id=$1`, [docId]);
  if (!rows.length) return res.status(404).json({ error: 'Document not found' });
  const role = await requireAccess(req, rows[0].case_id);
  if (!canReview(role)) return res.status(403).json({ error: 'Not permitted to comment' });
  const ins = await query<any>(
    `INSERT INTO comments (document_id, case_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [docId, rows[0].case_id, req.user!.id, body.trim()]
  );
  await audit({ userId: req.user!.id, caseId: rows[0].case_id, action: 'comment_add', target: `doc:${docId}` });
  res.json({ id: ins.rows[0].id, createdAt: ins.rows[0].created_at });
});

// Bookmarks list for a case
router.get('/case/:caseId/bookmarks', requireAuth, requireCaseRole('read_only'), async (req: AuthedRequest, res) => {
  const caseId = (req as any).caseId;
  const { rows } = await query<any>(
    `SELECT d.id, d.control_number, d.native_type, d.page_count, d.metadata, rs.status AS review_status, b.created_at AS bookmarked_at
     FROM bookmarks b JOIN documents d ON d.id=b.document_id LEFT JOIN review_states rs ON rs.document_id=d.id
     WHERE b.user_id=$1 AND b.case_id=$2 ORDER BY b.created_at DESC`,
    [req.user!.id, caseId]
  );
  res.json(rows);
});

export default router;
