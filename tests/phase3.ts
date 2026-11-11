/* eslint-disable no-console */
// ============================================================================
// Phase 3 — Case audit entries (#8) + delete/archive/retention/restore (#10).
// DEV DATABASE ONLY. Spawns the compiled dev server and exercises every
// requirement with actual values, then asserts.
//
// Run with:
//   set -a; . .env.dev; set +a; UPLOADS_DIR=/tmp/meridian-phase3-uploads \
//     npx ts-node tests/phase3.ts
// ============================================================================

import { spawn, ChildProcess, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { query, pool } from '../src/db';
import { generateApiToken } from '../src/middleware/apitoken';
import * as blobStore from '../src/lib/blobStore';
import { purgeExpired, assertCaseOwnerOrAdmin } from '../src/lib/retention';

const DB = process.env.DATABASE_URL || '';
if (!/meridian_dev|_dev(\b|$|\?)/.test(DB)) {
  console.error(`REFUSING TO RUN: DATABASE_URL does not look like a dev database (${DB}).`);
  process.exit(2);
}
const PORT = Number(process.env.PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const UPLOADS = process.env.UPLOADS_DIR || '/tmp/meridian-phase3-uploads';

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function makePdf(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3pdf-'));
  const p1 = path.join(dir, 'p1.png'), pdf = path.join(dir, 'r.pdf');
  execFileSync('convert', ['-size', '200x260', 'xc:white', p1]);
  execFileSync('convert', [p1, pdf]);
  return fs.readFileSync(pdf);
}

const PDF_BUF = makePdf();
const JSON_BUF = Buffer.from(JSON.stringify({ stage: 'remontoire.pipeline.completed', docs: 42 }), 'utf8');
const PDF_SHA = sha256(PDF_BUF);
const JSON_SHA = sha256(JSON_BUF);

let server: ChildProcess | null = null;
let caseId = 0;
let ownerToken = '', outsiderToken = '';
let ownerId = 0;

function hdr(tok: string): Record<string, string> { return { Authorization: `Bearer ${tok}` }; }

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await fetch(`${BASE}/api/v1/blobs/${'0'.repeat(64)}`, { method: 'HEAD' }); return true; }
    catch { await sleep(400); }
  }
  return false;
}

async function mkUser(username: string, admin: boolean): Promise<{ id: number; token: string }> {
  await query(`DELETE FROM api_tokens WHERE name=$1`, [`p3-${username}`]);
  // Remove cases this test user created on a prior run FIRST (children cascade),
  // else the user row is still referenced by cases_created_by_fkey.
  await query(`DELETE FROM cases WHERE created_by = (SELECT id FROM users WHERE username=$1)`, [username]);
  // audit_log.user_id references users (no cascade) — detach prior test rows.
  await query(`DELETE FROM audit_log WHERE user_id = (SELECT id FROM users WHERE username=$1)`, [username]);
  await query(`DELETE FROM users WHERE username=$1`, [username]);
  const u = await query<{ id: number }>(
    `INSERT INTO users (username, display_name, email, password_hash, is_system_admin, active, can_create_cases)
       VALUES ($1,$1,$2,'x',$3,true,true) RETURNING id`,
    [username, `${username}@example.test`, admin]);
  const id = u.rows[0].id;
  const tok = generateApiToken();
  await query(
    `INSERT INTO api_tokens (user_id, name, token_prefix, token_hash, scopes, created_by)
       VALUES ($1,$2,$3,$4,'{batch}',$1)`, [id, `p3-${username}`, tok.prefix, tok.hash]);
  return { id, token: tok.raw };
}

async function setup() {
  const owner = await mkUser('phase3-owner', true);     // system admin & case creator
  const outsider = await mkUser('phase3-outsider', false); // non-admin, non-creator
  ownerId = owner.id; ownerToken = owner.token; outsiderToken = outsider.token;
  const c = await query<{ id: number }>(
    `INSERT INTO cases (case_number, name, description, status, created_by)
       VALUES ($1,'Phase 3 Case','e2e phase3','open',$2) RETURNING id`,
    [`P3-${Date.now()}`, ownerId]);
  caseId = c.rows[0].id;
  // Make the outsider a case_manager MEMBER — proving creator-check, not role, gates deletes.
  await query(
    `INSERT INTO case_memberships (user_id, case_id, role)
       VALUES ((SELECT id FROM users WHERE username='phase3-outsider'),$1,'case_manager')
       ON CONFLICT DO NOTHING`, [caseId]);
  console.log(`setup: ownerId=${ownerId} caseId=${caseId}`);
}

async function run() {
  await setup();
  server = spawn('node', ['dist/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, UPLOADS_DIR: UPLOADS, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr?.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));
  if (!(await waitForServer())) throw new Error('dev server did not start');

  // ===== A. Case audit entries (#8) =========================================
  const fd = new FormData();
  fd.append('body', JSON.stringify({
    eventType: 'remontoire.pipeline.completed',
    occurredAt: '2026-11-01T09:00:00Z',
    summary: 'Pipeline finished for delivery batch 7.',
    source: { system: 'Remontoire', version: '2.3.1', runId: 'run-abc-123' },
  }));
  fd.append('file', new Blob([new Uint8Array(PDF_BUF)], { type: 'application/pdf' }), 'report.pdf');
  fd.append('file', new Blob([new Uint8Array(JSON_BUF)], { type: 'application/json' }), 'manifest.json');
  const postResp = await fetch(`${BASE}/api/v1/cases/${caseId}/audit-entries`, { method: 'POST', headers: hdr(ownerToken), body: fd });
  const entry = await postResp.json() as any;
  check('POST audit-entry returns 201', postResp.status === 201, `status=${postResp.status}`);
  const attByName: Record<string, any> = {};
  for (const a of entry.attachments || []) attByName[a.filename] = a;
  check('entry returns SHA-256 for PDF attachment', attByName['report.pdf']?.sha256 === PDF_SHA, `got=${attByName['report.pdf']?.sha256}`);
  check('entry returns SHA-256 for JSON attachment', attByName['manifest.json']?.sha256 === JSON_SHA, `got=${attByName['manifest.json']?.sha256}`);
  check('entry records posting user', entry.postedBy?.id === ownerId, `postedBy=${JSON.stringify(entry.postedBy)}`);
  check('entry records server posting time', !!entry.postedAt && !Number.isNaN(Date.parse(entry.postedAt)), `postedAt=${entry.postedAt}`);
  check('entry preserves occurredAt distinct from postedAt', entry.occurredAt && Date.parse(entry.occurredAt) !== Date.parse(entry.postedAt), `occurredAt=${entry.occurredAt}`);
  check('entry echoes source', entry.source?.system === 'Remontoire' && entry.source?.runId === 'run-abc-123');

  // Append-only: there must be NO update/delete route for entries/attachments.
  const putResp = await fetch(`${BASE}/api/v1/cases/${caseId}/audit-entries/${entry.id}`, { method: 'PUT', headers: hdr(ownerToken) });
  const delResp = await fetch(`${BASE}/api/v1/cases/${caseId}/audit-entries/${entry.id}`, { method: 'DELETE', headers: hdr(ownerToken) });
  check('append-only: PUT on an entry is not routed (404/405)', putResp.status === 404 || putResp.status === 405, `status=${putResp.status}`);
  check('append-only: DELETE on an entry is not routed (404/405)', delResp.status === 404 || delResp.status === 405, `status=${delResp.status}`);

  // List
  const listResp = await fetch(`${BASE}/api/v1/cases/${caseId}/audit-entries`, { headers: hdr(ownerToken) });
  const list = await listResp.json() as any[];
  check('GET audit-entries lists the entry', Array.isArray(list) && list.length >= 1 && list[0].id === entry.id, `count=${list.length}`);
  check('listed entry carries attachment metadata', (list[0].attachments || []).some((a: any) => a.sha256 === PDF_SHA && a.mime === 'application/pdf' && a.size === PDF_BUF.length));

  // Download an attachment — verify bytes + sha256 match.
  const pdfAtt = attByName['report.pdf'];
  const dlResp = await fetch(`${BASE}/api/v1/cases/${caseId}/audit-entries/${entry.id}/attachments/${pdfAtt.id}`, { headers: hdr(ownerToken) });
  const dlBuf = Buffer.from(await dlResp.arrayBuffer());
  check('download attachment returns 200', dlResp.status === 200, `status=${dlResp.status}`);
  check('downloaded content-type is application/pdf', (dlResp.headers.get('content-type') || '').includes('application/pdf'));
  check('downloaded bytes match + re-hash to the returned sha256', dlBuf.length === PDF_BUF.length && sha256(dlBuf) === PDF_SHA, `len=${dlBuf.length} sha=${sha256(dlBuf)}`);

  // Unsupported attachment type rejected with machine-readable code.
  const badFd = new FormData();
  badFd.append('body', JSON.stringify({ eventType: 'x' }));
  badFd.append('file', new Blob([new Uint8Array(Buffer.from('MZ...'))], { type: 'application/x-msdownload' }), 'evil.exe');
  const badResp = await fetch(`${BASE}/api/v1/cases/${caseId}/audit-entries`, { method: 'POST', headers: hdr(ownerToken), body: badFd });
  const badBody = await badResp.json() as any;
  check('unsupported attachment type -> 400 unsupported_attachment_type', badResp.status === 400 && badBody.code === 'unsupported_attachment_type', `status=${badResp.status} code=${badBody.code}`);

  // ===== B. Archive / un-archive ============================================
  const archResp = await fetch(`${BASE}/api/v1/cases/${caseId}`, { method: 'PATCH', headers: { ...hdr(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) });
  check('PATCH archived returns 200', archResp.status === 200, `status=${archResp.status}`);
  let cases = await (await fetch(`${BASE}/api/v1/cases`, { headers: hdr(ownerToken) })).json() as any[];
  check('archived case excluded from active listing', !cases.some((c) => c.id === caseId), `ids=${cases.map((c) => c.id).join(',')}`);
  cases = await (await fetch(`${BASE}/api/v1/cases?includeArchived=1`, { headers: hdr(ownerToken) })).json() as any[];
  check('archived case visible with includeArchived=1', cases.some((c) => c.id === caseId));
  const unarchResp = await fetch(`${BASE}/api/v1/cases/${caseId}`, { method: 'PATCH', headers: { ...hdr(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'open' }) });
  check('PATCH open (un-archive) returns 200', unarchResp.status === 200);
  cases = await (await fetch(`${BASE}/api/v1/cases`, { headers: hdr(ownerToken) })).json() as any[];
  check('un-archived case back in active listing', cases.some((c) => c.id === caseId));

  const badStatusResp = await fetch(`${BASE}/api/v1/cases/${caseId}`, { method: 'PATCH', headers: { ...hdr(ownerToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'bogus' }) });
  check('invalid archive status -> 400 invalid_status', badStatusResp.status === 400 && (await badStatusResp.json() as any).code === 'invalid_status');

  // ===== C. Soft-delete a document (blob ref NOT decremented) ================
  const imp = await query<{ id: number }>(
    `INSERT INTO loadfile_imports (case_id, name, status, phase) VALUES ($1,'p3-import','completed','completed') RETURNING id`, [caseId]);
  const importId = imp.rows[0].id;
  // Create a blob + a document referencing it.
  const nativeBuf = Buffer.from('native payload for phase3 document DOC-0001', 'utf8');
  const put = await blobStore.put(nativeBuf, { mimeType: 'application/octet-stream' });
  const beforeRef = (await query<{ ref_count: number }>(`SELECT ref_count FROM blobs WHERE sha256=$1`, [put.sha256])).rows[0].ref_count;
  await query(
    `INSERT INTO documents (case_id, set_id, control_number, native_type, native_sha256, native_filename)
       VALUES ($1,$2,'DOC-0001','none',$3,'native.eml')`, [caseId, importId, put.sha256]);
  // A second document in the same import to prove import-delete leaves the case.
  await query(`INSERT INTO documents (case_id, set_id, control_number, native_type) VALUES ($1,$2,'DOC-0002','none')`, [caseId, importId]);

  const delDoc = await fetch(`${BASE}/api/v1/cases/${caseId}/documents/DOC-0001`, { method: 'DELETE', headers: hdr(ownerToken) });
  const delDocBody = await delDoc.json() as any;
  check('DELETE document returns 200 sync', delDoc.status === 200 && delDocBody.deleted === true, `status=${delDoc.status}`);
  const liveAfter = (await query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE case_id=$1 AND control_number='DOC-0001' AND deleted_at IS NULL`, [caseId])).rows[0].n;
  check('soft-deleted document excluded (deleted_at set)', liveAfter === 0);
  const auditRow = (await query<{ n: number }>(`SELECT count(*)::int n FROM audit_log WHERE case_id=$1 AND action='document.deleted' AND detail LIKE '%DOC-0001%'`, [caseId])).rows[0].n;
  check('audit_log records document.deleted with control number', auditRow >= 1);
  const refAfterDelete = (await query<{ ref_count: number }>(`SELECT ref_count FROM blobs WHERE sha256=$1`, [put.sha256])).rows[0].ref_count;
  check('soft-delete did NOT decrement blob ref_count', refAfterDelete === beforeRef, `before=${beforeRef} after=${refAfterDelete}`);
  check('blob file still present after soft-delete', !!blobStore.getPath(put.sha256));

  // Restore the document — back + file intact.
  const restoreDoc = await fetch(`${BASE}/api/v1/cases/${caseId}/documents/DOC-0001/restore`, { method: 'POST', headers: hdr(ownerToken) });
  check('restore document returns 200', restoreDoc.status === 200, `status=${restoreDoc.status}`);
  const liveRestored = (await query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE case_id=$1 AND control_number='DOC-0001' AND deleted_at IS NULL`, [caseId])).rows[0].n;
  check('restored document is live again', liveRestored === 1);
  check('blob intact after restore', !!blobStore.getPath(put.sha256) && (await query<{ ref_count: number }>(`SELECT ref_count FROM blobs WHERE sha256=$1`, [put.sha256])).rows[0].ref_count === beforeRef);

  // ===== D. Soft-delete an import's documents, leaving the case =============
  const delImp = await fetch(`${BASE}/api/v1/cases/${caseId}/imports/${importId}`, { method: 'DELETE', headers: hdr(ownerToken) });
  check('DELETE import returns 200', delImp.status === 200, `status=${delImp.status}`);
  const impDocsLive = (await query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE set_id=$1 AND deleted_at IS NULL`, [importId])).rows[0].n;
  check('import documents soft-deleted', impDocsLive === 0);
  const caseStillLive = (await query<{ n: number }>(`SELECT count(*)::int n FROM cases WHERE id=$1 AND deleted_at IS NULL`, [caseId])).rows[0].n;
  check('case left in place after import delete', caseStillLive === 1);

  // ===== E. Permission denial (non-owner, non-admin -> 403 forbidden) ======
  // The delete/restore guard() enforces "system admin OR the case manager who
  // created the case". We assert that RULE directly against the exported
  // predicate (the single source of truth guard() maps to a 403 + code), then
  // confirm the HTTP layer refuses the non-owner too.
  //
  // NB: over HTTP, an unlicensed dev DB makes requireApiToken's licence gate
  // (which runs before the ownership guard) refuse EVERY non-admin token with a
  // 403 — so the outsider's DELETE is a 403 regardless. We therefore verify the
  // ownership decision at the predicate level (where the licence gate cannot
  // mask it) and only check the HTTP status (403) e2e.
  const ownerDecision = await assertCaseOwnerOrAdmin({ id: ownerId, isSystemAdmin: false }, caseId);
  check('ownership rule: case creator is permitted', ownerDecision.ok === true, `ok=${ownerDecision.ok}`);
  const outsiderId = (await query<{ id: number }>(`SELECT id FROM users WHERE username='phase3-outsider'`)).rows[0].id;
  const denyDecision = await assertCaseOwnerOrAdmin({ id: outsiderId, isSystemAdmin: false }, caseId);
  check(
    'ownership rule: non-owner non-admin -> forbidden',
    denyDecision.ok === false && (denyDecision as any).code === 'forbidden',
    `ok=${denyDecision.ok} code=${(denyDecision as any).code}`
  );
  const denyResp = await fetch(`${BASE}/api/v1/cases/${caseId}`, { method: 'DELETE', headers: hdr(outsiderToken) });
  const denyBody = await denyResp.json() as any;
  check('non-owner case_manager delete refused over HTTP (403)', denyResp.status === 403, `status=${denyResp.status} code=${denyBody.code}`);

  // ===== F. Soft-delete the case; audit_entries survive =====================
  const entriesBefore = (await query<{ n: number }>(`SELECT count(*)::int n FROM audit_entries WHERE case_id=$1`, [caseId])).rows[0].n;
  const delCase = await fetch(`${BASE}/api/v1/cases/${caseId}`, { method: 'DELETE', headers: hdr(ownerToken) });
  check('DELETE case returns 200 (small case)', delCase.status === 200, `status=${delCase.status}`);
  const caseDeleted = (await query<{ n: number }>(`SELECT count(*)::int n FROM cases WHERE id=$1 AND deleted_at IS NOT NULL`, [caseId])).rows[0].n;
  check('case soft-deleted', caseDeleted === 1);
  const entriesAfter = (await query<{ n: number }>(`SELECT count(*)::int n FROM audit_entries WHERE case_id=$1`, [caseId])).rows[0].n;
  check('audit_entries SURVIVE case soft-delete', entriesAfter === entriesBefore && entriesAfter >= 1, `before=${entriesBefore} after=${entriesAfter}`);
  // Restore the case for subsequent assertions.
  await fetch(`${BASE}/api/v1/cases/${caseId}/restore`, { method: 'POST', headers: hdr(ownerToken) });

  // ===== G. Purge after forcing retention into the past =====================
  // Re-soft-delete DOC-0001 and force its retention_until into the past.
  await fetch(`${BASE}/api/v1/cases/${caseId}/documents/DOC-0001`, { method: 'DELETE', headers: hdr(ownerToken) });
  await query(`UPDATE documents SET retention_until = now() - interval '1 day' WHERE case_id=$1 AND control_number='DOC-0001'`, [caseId]);
  const refBeforePurge = (await query<{ ref_count: number }>(`SELECT ref_count FROM blobs WHERE sha256=$1`, [put.sha256])).rows[0].ref_count;
  const purgeResult = await purgeExpired(new Date());
  console.log('  purge result:', JSON.stringify(purgeResult));
  const docGone = (await query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE case_id=$1 AND control_number='DOC-0001'`, [caseId])).rows[0].n;
  check('purge permanently removed the expired document', docGone === 0, `remaining=${docGone}`);
  const blobRow = (await query<{ ref_count: number }>(`SELECT ref_count FROM blobs WHERE sha256=$1`, [put.sha256])).rows;
  const blobGone = blobRow.length === 0;
  check('purge decremented/removed the blob (ref_count 1 -> 0)', blobGone || blobRow[0].ref_count === refBeforePurge - 1, `before=${refBeforePurge} after=${blobGone ? 'removed' : blobRow[0].ref_count}`);
  check('purge removed the now-unreferenced blob file', !blobStore.getPath(put.sha256), `path=${blobStore.getPath(put.sha256)}`);

  // ===== H. Large delete returns 202 + pollable job ========================
  const bigCase = await query<{ id: number }>(
    `INSERT INTO cases (case_number, name, status, created_by) VALUES ($1,'Phase3 Big','open',$2) RETURNING id`,
    [`P3BIG-${Date.now()}`, ownerId]);
  const bigId = bigCase.rows[0].id;
  // Insert 1001 minimal documents (> LARGE_DELETE_THRESHOLD=1000) in one statement.
  await query(
    `INSERT INTO documents (case_id, control_number, native_type)
       SELECT $1, 'BIG-'||g, 'none' FROM generate_series(1,1001) g`, [bigId]);
  const bigDel = await fetch(`${BASE}/api/v1/cases/${bigId}`, { method: 'DELETE', headers: hdr(ownerToken) });
  const bigBody = await bigDel.json() as any;
  check('large case DELETE returns 202 + jobId', bigDel.status === 202 && !!bigBody.jobId, `status=${bigDel.status} jobId=${bigBody.jobId}`);
  // Poll the job to completion.
  let job: any = null;
  for (let i = 0; i < 40; i++) {
    const jr = await fetch(`${BASE}/api/v1/jobs/${bigBody.jobId}`, { headers: hdr(ownerToken) });
    job = await jr.json();
    if (job.status === 'completed' || job.status === 'failed') break;
    await sleep(250);
  }
  check('delete job polls to completed', job?.status === 'completed', `status=${job?.status} done=${job?.docsDone}/${job?.docsTotal}`);
  const bigLive = (await query<{ n: number }>(`SELECT count(*)::int n FROM documents WHERE case_id=$1 AND deleted_at IS NULL`, [bigId])).rows[0].n;
  check('large case documents all soft-deleted by job', bigLive === 0, `live=${bigLive}`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
}

run()
  .catch((e) => { console.error('FATAL', e); failed++; })
  .finally(async () => {
    if (server) server.kill('SIGKILL');
    await pool.end().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
  });
