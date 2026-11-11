/* eslint-disable no-console */
// ============================================================================
// Phase 2 — Item batch API end-to-end test (DEV DATABASE ONLY).
// ----------------------------------------------------------------------------
// Exercises the full sequence against the isolated dev DB + a spawned dev server:
//   - create a case, open a batch with expected* totals
//   - POST two item requests IN PARALLEL (text part + inline text + native with a
//     supplied sha256 + a PDF review image + a thread + a translation + a parent
//     link to a present item + one item whose parent is absent + a missing-text
//     item + a native whose supplied sha256 is WRONG)
//   - re-POST an item (idempotency / dedup)
//   - HEAD a known + an unknown blob
//   - commit, poll status through the phases to an end state
//   - hit the SSE stream
// Then asserts every Phase-2 requirement with actual values.
//
// Refuses to run unless DATABASE_URL points at a *_dev database. Never touches
// production. Run with:
//   set -a; . .env.dev; set +a; UPLOADS_DIR=/tmp/meridian-phase2-uploads \
//     npx ts-node tests/batch_phase2.ts
// ============================================================================

import { spawn, ChildProcess, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { query, pool } from '../src/db';
import { generateApiToken } from '../src/middleware/apitoken';

const DB = process.env.DATABASE_URL || '';
if (!/meridian_dev|_dev(\b|$|\?)/.test(DB)) {
  console.error(`REFUSING TO RUN: DATABASE_URL does not look like a dev database (${DB}).`);
  process.exit(2);
}
const PORT = Number(process.env.PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const UPLOADS = process.env.UPLOADS_DIR || '/tmp/meridian-phase2-uploads';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

// --- fixtures ---------------------------------------------------------------
function makeTwoPagePdf(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pdf-'));
  const p1 = path.join(dir, 'p1.png'), p2 = path.join(dir, 'p2.png'), pdf = path.join(dir, 'two.pdf');
  execFileSync('convert', ['-size', '300x400', 'xc:white', p1]);
  execFileSync('convert', ['-size', '300x400', 'xc:gray', p2]);
  execFileSync('convert', [p1, p2, pdf]);
  return fs.readFileSync(pdf);
}

const EN_TEXT = 'Settlement memorandum regarding the Geneva escrow account.';
const FR_TEXT = 'Memorandum de reglement concernant le compte sequestre de Geneve.';
const NATIVE_BUF = Buffer.from('MIME-Version: 1.0\r\nSubject: Settlement\r\n\r\nNative message body.\r\n', 'utf8');
const NATIVE_SHA = sha256(NATIVE_BUF);
const BAD_NATIVE_BUF = Buffer.from('this native will fail its integrity check', 'utf8');
const PDF_BUF = makeTwoPagePdf();

let server: ChildProcess | null = null;
let caseId = 0;
let rawToken = '';

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await fetch(`${BASE}/api/v1/blobs/${'0'.repeat(64)}`, { method: 'HEAD' }); return true; }
    catch { await sleep(400); }
  }
  return false;
}

function authHeaders(): Record<string, string> { return { Authorization: `Bearer ${rawToken}` }; }

async function setup() {
  // Clean any previous run of these fixtures.
  await query(`DELETE FROM api_tokens WHERE name='phase2-test-token'`);
  await query(`DELETE FROM users WHERE username='phase2-tester'`);
  const u = await query<{ id: number }>(
    `INSERT INTO users (username, display_name, email, password_hash, is_system_admin, active, can_create_cases)
       VALUES ('phase2-tester','Phase 2 Tester','phase2@example.test','x',true,true,true) RETURNING id`);
  const userId = u.rows[0].id;
  const tok = generateApiToken();
  rawToken = tok.raw;
  await query(
    `INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, scopes, created_by)
       VALUES ($1,'phase2-test-token',$2,$3,'{batch}',$1)`,
    [userId, tok.prefix, tok.hash]);
  const c = await query<{ id: number }>(
    `INSERT INTO cases (case_number, name, description, status, created_by)
       VALUES ($1,'Phase 2 Batch Case','e2e batch test','active',$2) RETURNING id`,
    [`P2-${Date.now()}`, userId]);
  caseId = c.rows[0].id;
  console.log(`setup: userId=${userId} caseId=${caseId} token=${tok.prefix}...`);
}

async function postItems(manifest: any[], fileParts: Record<string, { buf: Buffer; name: string }>, batchId: string) {
  const fd = new FormData();
  fd.append('items', JSON.stringify(manifest));
  for (const [part, f] of Object.entries(fileParts)) {
    fd.append(part, new Blob([new Uint8Array(f.buf)]), f.name);
  }
  const resp = await fetch(`${BASE}/api/v1/cases/${caseId}/batches/${batchId}/items`, {
    method: 'POST', headers: authHeaders(), body: fd,
  });
  return { status: resp.status, body: await resp.json() as any };
}

async function run() {
  await setup();

  // Build server with current code already compiled by the runner (npm run build).
  server = spawn('node', ['dist/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, UPLOADS_DIR: UPLOADS, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr?.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));
  if (!(await waitForServer())) throw new Error('dev server did not start');

  // 1) Open a batch with expected totals ------------------------------------
  const openResp = await fetch(`${BASE}/api/v1/cases/${caseId}/batches`, {
    method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedItems: 6, expectedFiles: 3, expectedBytes: 123456 }),
  });
  const open = await openResp.json() as any;
  check('POST /batches returns 201', openResp.status === 201, `status=${openResp.status}`);
  check('open response states accepted concurrency', typeof open.concurrency === 'number' && open.concurrency > 0, `concurrency=${open.concurrency}`);
  check('open echoes expected totals', open.expected?.items === 6 && open.expected?.files === 3 && open.expected?.bytes === 123456, JSON.stringify(open.expected));
  const batchId = String(open.batchId);
  check('open returns a batchId', !!batchId, `batchId=${batchId}`);

  // 2) Two item requests IN PARALLEL ----------------------------------------
  const manifestA = [
    {
      controlNumber: 'RICH-1',
      metadata: { custodian: 'A. Dupont', subject: 'Settlement' },
      processedBy: 'remontoire/1.4',
      text: [
        { part: 'rich_en', language: 'en', kind: 'extracted' },
        { inline: FR_TEXT, language: 'fr', kind: 'translation', translatedFrom: 'en', method: 'machine' },
      ],
      native: { part: 'rich_native', fileName: 'statement.msg', mimeType: 'message/rfc822', sha256: NATIVE_SHA },
      image: { part: 'rich_pdf', format: 'pdf', pageCount: 2 },
      thread: { threadId: 'THREAD-A', position: 1, size: 3, subject: 'Settlement thread' },
    },
    { controlNumber: 'ROOT-1', text: [{ inline: 'Root document body text.', language: 'en', kind: 'extracted' }] },
  ];
  const filesA = {
    rich_en: { buf: Buffer.from('\uFEFF' + EN_TEXT, 'utf8'), name: 'rich_en.txt' }, // UTF-8 with BOM
    rich_native: { buf: NATIVE_BUF, name: 'statement.msg' },
    rich_pdf: { buf: PDF_BUF, name: 'image.pdf' },
  };
  const manifestB = [
    { controlNumber: 'CHILD-1', parentControlNumber: 'ROOT-1', text: [{ inline: 'Child attachment text.', language: 'en', kind: 'extracted' }] },
    { controlNumber: 'ORPHAN-1', parentControlNumber: 'GHOST-999', text: [{ inline: 'Orphan body text.', language: 'en', kind: 'extracted' }] },
    { controlNumber: 'BAD-1', text: [{ inline: 'Item with a bad native checksum.', language: 'en', kind: 'extracted' }], native: { part: 'bad_native', fileName: 'bad.bin', mimeType: 'application/octet-stream', sha256: '0'.repeat(64) } },
    { controlNumber: 'NOTEXT-1' },
  ];
  const filesB = { bad_native: { buf: BAD_NATIVE_BUF, name: 'bad.bin' } };

  const [ra, rb] = await Promise.all([
    postItems(manifestA, filesA, batchId),
    postItems(manifestB, filesB, batchId),
  ]);
  check('parallel items request A ok', ra.status === 200, `status=${ra.status}`);
  check('parallel items request B ok', rb.status === 200, `status=${rb.status}`);

  const rich = ra.body.items.find((i: any) => i.controlNumber === 'RICH-1');
  check('RICH-1 created', rich?.status === 'created', `status=${rich?.status}`);
  const nativeFile = rich?.files?.find((f: any) => f.part === 'rich_native');
  const imageFile = rich?.files?.find((f: any) => f.part === 'rich_pdf');
  check('sha256 returned per stored file (native)', nativeFile?.sha256 === NATIVE_SHA, `returned=${nativeFile?.sha256?.slice(0, 12)} expected=${NATIVE_SHA.slice(0, 12)}`);
  check('sha256 returned per stored file (image)', !!imageFile?.sha256, `image sha=${imageFile?.sha256?.slice(0, 12)}`);

  const bad = rb.body.items.find((i: any) => i.controlNumber === 'BAD-1');
  const badErr = bad?.errors?.find((e: any) => e.code === 'hash_mismatch');
  check('hash mismatch rejected with code', !!badErr, `code=${badErr?.code} value=${badErr?.failedValue?.slice(0, 8)}`);
  check('hash mismatch error carries controlNumber', badErr?.controlNumber === 'BAD-1', `controlNumber=${badErr?.controlNumber}`);

  // 3) Idempotency / dedup — re-POST RICH-1 ---------------------------------
  const rc = await postItems([manifestA[0]], filesA, batchId);
  const richAgain = rc.body.items.find((i: any) => i.controlNumber === 'RICH-1');
  check('re-POST same controlNumber => updated (not duplicated)', richAgain?.status === 'updated', `status=${richAgain?.status}`);
  const dedupNative = richAgain?.files?.find((f: any) => f.part === 'rich_native');
  check('re-stored identical native is deduplicated', dedupNative?.deduplicated === true, `deduplicated=${dedupNative?.deduplicated}`);
  const dupCount = await query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE case_id=$1 AND control_number='RICH-1'`, [caseId]);
  check('no duplicate document row for RICH-1', dupCount.rows[0].n === 1, `rows=${dupCount.rows[0].n}`);

  // 4) HEAD blobs ------------------------------------------------------------
  const headKnown = await fetch(`${BASE}/api/v1/blobs/${NATIVE_SHA}`, { method: 'HEAD', headers: authHeaders() });
  const headUnknown = await fetch(`${BASE}/api/v1/blobs/${'a'.repeat(64)}`, { method: 'HEAD', headers: authHeaders() });
  check('HEAD known blob => 200', headKnown.status === 200, `status=${headKnown.status}`);
  check('HEAD unknown blob => 404', headUnknown.status === 404, `status=${headUnknown.status}`);

  // Capture a mid-flight status to prove phases are monotonic across commit.
  const midResp = await fetch(`${BASE}/api/v1/cases/${caseId}/batches/${batchId}`, { headers: authHeaders() });
  const mid = await midResp.json() as any;
  const midReceiving = mid.phases.find((p: any) => p.phase === 'receiving')?.done ?? 0;
  check('status phases in fixed order', JSON.stringify(mid.phases.map((p: any) => p.phase)) === JSON.stringify(['receiving', 'storing', 'indexing_text', 'rendering', 'linking', 'finalising']), mid.phases.map((p: any) => p.phase).join(','));
  check('updatedAt present on status', !!mid.updatedAt, `updatedAt=${mid.updatedAt}`);

  // 5) SSE — connect and confirm it streams ---------------------------------
  let sseGot = '';
  try {
    const ctrl = new AbortController();
    const sseResp = await fetch(`${BASE}/api/v1/cases/${caseId}/batches/${batchId}/events`, { headers: authHeaders(), signal: ctrl.signal });
    const reader = (sseResp.body as any).getReader();
    const dec = new TextDecoder();
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      sseGot += dec.decode(value, { stream: true });
      if (sseGot.includes('event: status')) break;
    }
    ctrl.abort();
  } catch { /* abort expected */ }
  check('SSE stream carries status events', sseGot.includes('event: status') && sseGot.includes('"phases"'), `len=${sseGot.length}`);

  // 6) Commit + poll to end state -------------------------------------------
  const commitResp = await fetch(`${BASE}/api/v1/cases/${caseId}/batches/${batchId}/commit`, { method: 'POST', headers: authHeaders() });
  check('commit => 202 committing', commitResp.status === 202, `status=${commitResp.status}`);

  let last: any = null;
  const seenReceiving: number[] = [];
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${BASE}/api/v1/cases/${caseId}/batches/${batchId}`, { headers: authHeaders() });
    last = await r.json();
    seenReceiving.push(last.phases.find((p: any) => p.phase === 'receiving')?.done ?? 0);
    if (['completed', 'completed_with_failures', 'failed'].includes(last.status)) break;
    await sleep(500);
  }
  check('batch reaches a terminal state', ['completed', 'completed_with_failures', 'failed'].includes(last.status), `status=${last.status}`);
  check('end state is completed_with_failures (has orphan/hash/text failures)', last.endState === 'completed_with_failures', `endState=${last.endState}`);
  const monotonic = seenReceiving.every((v, i) => i === 0 || v >= seenReceiving[i - 1]) && (seenReceiving[seenReceiving.length - 1] >= midReceiving);
  check('phase counters are monotonic (never decrease)', monotonic, `receiving.done series=${seenReceiving.join(',')}`);
  const allComplete = last.phases.every((p: any) => p.state === 'complete');
  check('all phases complete at terminal state', allComplete, last.phases.map((p: any) => `${p.phase}:${p.state}`).join(' '));

  // 7) Verification counts (#9) ---------------------------------------------
  const v = last.verification;
  check('items_received counted (>=7 incl. re-post)', v.items_received >= 7, `items_received=${v.items_received}`);
  check('items_created = 6 distinct docs', v.items_created === 6, `items_created=${v.items_created}`);
  check('items_updated >= 1 (idempotent re-post)', v.items_updated >= 1, `items_updated=${v.items_updated}`);
  check('text_indexed per language en+fr', (v.text_indexed.en || 0) >= 1 && (v.text_indexed.fr || 0) >= 1, JSON.stringify(v.text_indexed));
  check('text_missing = 1 (NOTEXT-1)', v.text_missing === 1, `text_missing=${v.text_missing}`);
  check('natives_stored >= 1', v.natives_stored >= 1, `natives_stored=${v.natives_stored}`);
  check('images_stored >= 1', v.images_stored >= 1, `images_stored=${v.images_stored}`);
  check('pages rendered = 2 (two-page PDF)', v.pages === 2, `pages=${v.pages}`);
  check('threads_populated >= 1', v.threads_populated >= 1, `threads_populated=${v.threads_populated}`);
  check('families_linked = 1 (CHILD-1 -> ROOT-1)', v.families_linked === 1, `families_linked=${v.families_linked}`);
  check('unmapped_columns is an array', Array.isArray(v.unmapped_columns), JSON.stringify(v.unmapped_columns));
  const parentFail = v.failures.find((f: any) => f.code === 'parent_not_found' && f.controlNumber === 'ORPHAN-1');
  const textFail = v.failures.find((f: any) => f.code === 'text_missing' && f.controlNumber === 'NOTEXT-1');
  const hashFail = v.failures.find((f: any) => f.code === 'hash_mismatch');
  check('failures include parent_not_found for ORPHAN-1', !!parentFail, `failedValue=${parentFail?.failedValue}`);
  check('failures include text_missing for NOTEXT-1', !!textFail, `reason=${textFail?.reason}`);
  check('failures include hash_mismatch', !!hashFail, `controlNumber=${hashFail?.controlNumber}`);

  // 8) Deep assertions straight from the DB ---------------------------------
  const richDoc = await query<any>(`SELECT * FROM documents WHERE case_id=$1 AND control_number='RICH-1'`, [caseId]);
  const rd = richDoc.rows[0];
  check('native_mime reflects declared type, not an image format', rd.native_mime === 'message/rfc822' && rd.native_type !== 'tiff', `native_mime=${rd.native_mime} native_type=${rd.native_type}`);
  check('native_filename kept separate from storage name', rd.native_filename === 'statement.msg' && rd.native_storage_name === NATIVE_SHA, `filename=${rd.native_filename} storage=${rd.native_storage_name?.slice(0, 10)}`);
  check('processed_by recorded', rd.processed_by === 'remontoire/1.4', `processed_by=${rd.processed_by}`);
  check('thread fields populated', rd.thread_id === 'THREAD-A' && Number(rd.thread_size) === 3, `thread_id=${rd.thread_id} size=${rd.thread_size}`);
  const pages = await query<{ n: number }>(`SELECT count(*)::int n FROM document_pages WHERE document_id=$1`, [rd.id]);
  check('document_pages has 2 rendered pages', pages.rows[0].n === 2, `pages=${pages.rows[0].n}`);
  check('documents.page_count = 2', rd.page_count === 2, `page_count=${rd.page_count}`);

  // Cross-language FTS: an English term and a French term both match RICH-1.
  const enHit = await query<{ document_id: number }>(`SELECT document_id FROM document_text WHERE document_id=$1 AND search_tsv @@ to_tsquery('simple','settlement')`, [rd.id]);
  const frHit = await query<{ document_id: number }>(`SELECT document_id FROM document_text WHERE document_id=$1 AND search_tsv @@ to_tsquery('simple','compte')`, [rd.id]);
  check('text indexed + cross-language searchable (en term matches)', enHit.rows.length >= 1, `en rows=${enHit.rows.length}`);
  check('text indexed + cross-language searchable (fr term matches same doc)', frHit.rows.length >= 1, `fr rows=${frHit.rows.length}`);
  const foldHit = await query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE id=$1 AND (search_tsv @@ to_tsquery('english','settlement') AND search_tsv @@ to_tsquery('english','compte'))`, [rd.id]);
  check('documents.search_tsv folds all languages (both terms on one doc)', foldHit.rows[0].n === 1, `n=${foldHit.rows[0].n}`);

  // text decoded without a leading BOM
  const enRow = await query<{ text_content: string; is_original: boolean }>(`SELECT text_content, is_original FROM document_text WHERE document_id=$1 AND language='en' AND kind='extracted'`, [rd.id]);
  check('UTF-8 BOM stripped from decoded text', enRow.rows[0].text_content.charCodeAt(0) !== 0xFEFF && enRow.rows[0].text_content.startsWith('Settlement'), `starts="${enRow.rows[0].text_content.slice(0, 12)}"`);
  check('original text version flagged is_original', enRow.rows[0].is_original === true, `is_original=${enRow.rows[0].is_original}`);
  const frRow = await query<{ translated_from: string; method: string }>(`SELECT translated_from, method FROM document_text WHERE document_id=$1 AND language='fr' AND kind='translation'`, [rd.id]);
  check('translation records source language + method', frRow.rows[0]?.translated_from === 'en' && frRow.rows[0]?.method === 'machine', `from=${frRow.rows[0]?.translated_from} method=${frRow.rows[0]?.method}`);

  console.log(`\n==== Phase 2 batch API: ${passed} passed, ${failed} failed ====`);
}

run()
  .catch((e) => { console.error('TEST ERROR', e); failed++; })
  .finally(async () => {
    try { server?.kill('SIGKILL'); } catch { /* */ }
    await pool.end().catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
  });
