/* Phase 4 UI verification seed — dev only (.env.dev / meridian_dev).
   Creates a self-contained case with: a translated document, a 3-message thread,
   a family (parent + attachment), an item with native + review image, and a
   posted integrator audit entry with a downloadable report. Reuses the app's
   own blobStore + password hashing so downloads resolve exactly as in prod. */
require('dotenv').config({ path: '.env.dev' });
const fs = require('fs');
const path = require('path');
const { query, pool } = require('./dist/db');
const blobStore = require('./dist/lib/blobStore');
const { hashPassword } = require('./dist/lib/auth');
const { config } = require('./dist/config');

async function main() {
  const OWNER = 4; // phase3-owner (system admin)
  // Known login for browser verification.
  await query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [hashPassword('Phase4!verify'), OWNER]);

  // Fresh case each run.
  const cs = await query(
    `INSERT INTO cases (name, case_number, description, status, created_by)
     VALUES ('Phase 4 UI verification', 'P4-UI', 'Seeded to verify the Remontoire web UI.', 'open', $1)
     RETURNING id`, [OWNER]);
  const caseId = cs.rows[0].id;
  await query(`INSERT INTO case_memberships (user_id, case_id, role) VALUES ($1,$2,'case_manager')
               ON CONFLICT DO NOTHING`, [OWNER, caseId]);

  const threadId = `thread-${caseId}-A`;
  const md = (o) => JSON.stringify(o);

  // ---- Family parent email (also thread message 1) -------------------------
  const nativeBuf = Buffer.from('From: alice@example.com\nTo: bob@example.com\nSubject: Projekt Remontoire\n\nGuten Tag, anbei der Bericht.\n');
  const nativePut = await blobStore.put(nativeBuf, { mimeType: 'message/rfc822' });
  const parent = await query(
    `INSERT INTO documents (case_id, control_number, native_type, metadata, thread_id, thread_subject,
        thread_position, thread_size, message_id, native_sha256, native_filename, native_storage_name, native_mime)
     VALUES ($1,'DOC-0001','native',$2,$3,'Projekt Remontoire',1,3,'<msg1@example.com>',$4,'projekt-remontoire.eml',$5,'message/rfc822')
     RETURNING id`,
    [caseId, md({ 'Subject': 'Projekt Remontoire', 'From': 'alice@example.com', 'To': 'bob@example.com', 'Date': '2026-01-05 09:00' }),
     threadId, nativePut.sha256, nativePut.sha256]);
  const parentId = parent.rows[0].id;

  // Original German text + English machine translation for DOC-0001 (#1).
  await query(`INSERT INTO document_text (document_id, language, kind, is_original, method, text_content, char_length)
               VALUES ($1,'de','extracted',true,null,$2,$3)`,
    [parentId, 'Guten Tag, anbei der Bericht über das Projekt Remontoire. Mit freundlichen Grüßen, Alice.', 88]);
  await query(`INSERT INTO document_text (document_id, language, kind, is_original, translated_from, method, text_content, char_length)
               VALUES ($1,'en','translation',false,'de','machine',$2,$3)`,
    [parentId, 'Good day, attached is the report on the Remontoire project. Kind regards, Alice.', 79]);

  // ---- Thread messages 2 and 3 --------------------------------------------
  await query(
    `INSERT INTO documents (case_id, control_number, native_type, metadata, thread_id, thread_subject, thread_position, thread_size, message_id, in_reply_to)
     VALUES ($1,'DOC-0002','none',$2,$3,'Projekt Remontoire',2,3,'<msg2@example.com>','<msg1@example.com>')`,
    [caseId, md({ 'Subject': 'RE: Projekt Remontoire', 'From': 'bob@example.com', 'To': 'alice@example.com', 'Date': '2026-01-05 10:30' }), threadId]);
  await query(
    `INSERT INTO documents (case_id, control_number, native_type, metadata, thread_id, thread_subject, thread_position, thread_size, message_id, in_reply_to)
     VALUES ($1,'DOC-0003','none',$2,$3,'Projekt Remontoire',3,3,'<msg3@example.com>','<msg2@example.com>')`,
    [caseId, md({ 'Subject': 'RE: Projekt Remontoire', 'From': 'alice@example.com', 'To': 'bob@example.com', 'Date': '2026-01-05 11:15' }), threadId]);

  // ---- Attachment to the parent (family child) with native + review image ---
  const pdfNative = Buffer.from('%PDF-1.4\n% seeded native attachment for Phase 4\n');
  const pdfPut = await blobStore.put(pdfNative, { mimeType: 'application/pdf' });
  // 1x1 PNG review image written under uploadsDir and referenced by document_pages.
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
  const pngBuf = Buffer.from(pngB64, 'base64');
  const imgRel = path.join('phase4', `case${caseId}-DOC-0004-p1.png`);
  const imgAbs = path.join(config.uploadsDir, imgRel);
  fs.mkdirSync(path.dirname(imgAbs), { recursive: true });
  fs.writeFileSync(imgAbs, pngBuf);
  const att = await query(
    `INSERT INTO documents (case_id, control_number, native_type, metadata, parent_control_number, page_count,
        native_sha256, native_filename, native_storage_name, native_mime, image_sha256, image_format, image_page_count)
     VALUES ($1,'DOC-0004','pdf',$2,'DOC-0001',1,$3,'invoice-scan.pdf',$4,'application/pdf',$5,'pdf',1)
     RETURNING id`,
    [caseId, md({ 'Subject': 'Invoice (scanned)', 'Custodian': 'Alice' }), pdfPut.sha256, pdfPut.sha256, pdfPut.sha256]);
  await query(`INSERT INTO document_pages (document_id, page_no, image_path) VALUES ($1,1,$2)`, [att.rows[0].id, imgRel]);

  // ---- Orphan family item: references a parent not present (unfound flag) ---
  await query(
    `INSERT INTO documents (case_id, control_number, native_type, metadata, parent_control_number)
     VALUES ($1,'DOC-0005','none',$2,'DOC-9999')`,
    [caseId, md({ 'Subject': 'Attachment with missing parent' })]);

  // ---- A completed-with-failures batch (verification + progress, #6) --------
  const counts = {
    phases: {
      receiving: { done: 10, total: 10, state: 'done' },
      storing: { done: 10, total: 10, state: 'done' },
      indexing_text: { done: 9, total: 10, state: 'done' },
      rendering: { done: 8, total: 10, state: 'done' },
      linking: { done: 10, total: 10, state: 'done' },
      finalising: { done: 10, total: 10, state: 'done' },
    },
    verification: {
      items_received: 10, items_created: 9, items_updated: 1,
      text_indexed: 9, text_missing: 1, natives: 7, images: 8, pages: 24,
      threads: 1, families: 2,
      failures: [{ controlNumber: 'DOC-BAD-01', reason: 'native blob hash mismatch' }],
    },
  };
  await query(
    `INSERT INTO batches (case_id, status, expected_items, expected_files, expected_bytes, counts, end_state, created_by)
     VALUES ($1,'completed_with_failures',10,18,204800,$2,'completed_with_failures',$3)`,
    [caseId, JSON.stringify(counts), OWNER]);

  // ---- A posted integrator audit entry with a downloadable report (#5/#8) ---
  const reportBuf = Buffer.from('Remontoire scan report\nrun_id: run-4242\nitems: 10\nfailures: 1 (DOC-BAD-01)\n');
  const reportPut = await blobStore.put(reportBuf, { mimeType: 'text/plain' });
  const entry = await query(
    `INSERT INTO audit_entries (case_id, event_type, occurred_at, summary, source_system, source_version, source_run_id, posted_by, posted_at)
     VALUES ($1,'remontoire.scan.completed', now() - interval '1 hour', 'Scan completed: 10 items received, 1 failure.', 'Remontoire', '2.3.0', 'run-4242', $2, now())
     RETURNING id`, [caseId, OWNER]);
  await query(
    `INSERT INTO audit_entry_attachments (entry_id, filename, mime_type, blob_sha256, byte_size)
     VALUES ($1,'remontoire-scan-report.txt','text/plain',$2,$3)`,
    [entry.rows[0].id, reportPut.sha256, reportBuf.length]);

  // ---- A platform audit_log event so history shows BOTH kinds ---------------
  await query(
    `INSERT INTO audit_log (user_id, case_id, action, target, detail)
     VALUES ($1,$2,'import.completed',$3,'Load-file import completed: 10 documents.')`,
    [OWNER, caseId, `case:${caseId}`]);

  console.log(JSON.stringify({ caseId, parentId, login: 'phase3-owner / Phase4!verify' }));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
