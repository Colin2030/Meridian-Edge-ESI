/**
 * Phase-1 load-file import test (v1.4.0 "Remontoire delivery").
 *
 * Standalone test — the project has no test runner, so this is a focused
 * script run with ts-node against the DEV database only. It builds a tiny
 * fixture package (a CSV .DAT with TEXTPATH, THREADID/THREADPOSITION/THREADSIZE,
 * FILETYPE, PARENTID, TRANSLATEDTEXTPATH/TRANSLATEDFROM) with a French original +
 * English translation, an RFC822 native, a found-parent child and an
 * unfound-parent child, runs runImport against it, then QUERIES the DEV DB to
 * prove each bug fix with the actual stored values.
 *
 *   Run:  set -a; . .env.dev; set +a; \
 *         UPLOADS_DIR=/tmp/meridian-phase1-uploads npx ts-node tests/import_phase1.ts
 *
 * NEVER run against the production .env — this inserts and deletes a throwaway
 * case. It refuses to run unless DATABASE_URL points at the dev database name.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { query, pool } from '../src/db';
import { runImport } from '../src/lib/ingest';

const DEV_DB = 'meridian_dev';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  if (ok) {
    console.log(`  \u2713 PASS  ${name} \u2014 ${detail}`);
  } else {
    failures++;
    console.log(`  \u2717 FAIL  ${name} \u2014 ${detail}`);
  }
}

async function main() {
  // --- safety: dev DB only --------------------------------------------------
  const url = process.env.DATABASE_URL || '';
  if (!url.includes(DEV_DB)) {
    console.error(`REFUSING TO RUN: DATABASE_URL does not point at "${DEV_DB}". Load .env.dev first.`);
    process.exit(1);
  }

  // --- build the fixture package -------------------------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-fixture-'));
  const textDir = path.join(root, 'TEXT');
  const nativeDir = path.join(root, 'NATIVE');
  fs.mkdirSync(textDir, { recursive: true });
  fs.mkdirSync(nativeDir, { recursive: true });

  // French original, written with a UTF-8 BOM and CRLF line-endings to exercise
  // the UTF-8 ±BOM decode + line-ending normalisation helpers.
  const frenchText = '\uFEFF' + 'Bonjour,\r\nVeuillez trouver le budget trimestriel ci-joint.\r\nCordialement.\r\n';
  fs.writeFileSync(path.join(textDir, 'DOC-001.txt'), frenchText, 'binary');
  // English machine translation — carries a UNIQUE token that appears ONLY in the
  // English translation, so a search for it proving the (French-original) document
  // is found demonstrates cross-language search via the existing search path.
  const englishText = 'Hello,\nPlease find attached the quarterly budget.\nRegards.\nzebracrossword marker.\n';
  fs.writeFileSync(path.join(textDir, 'DOC-001.en.txt'), englishText, 'utf8');
  fs.writeFileSync(path.join(textDir, 'DOC-002.txt'), 'Attachment spreadsheet with figures.\n', 'utf8');
  fs.writeFileSync(path.join(textDir, 'DOC-003.txt'), 'Standalone child document text.\n', 'utf8');

  // RFC822 native so content-detection resolves to message/rfc822 (and the
  // declared FILETYPE agrees) — NEVER the image format.
  const eml = [
    'From: alice@example.com',
    'To: bob@example.com',
    'Subject: Reunion budget',
    'Date: Fri, 15 Mar 2024 09:00:00 +0000',
    'Message-ID: <msg-001@example.com>',
    '',
    'Veuillez trouver le budget trimestriel ci-joint.',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(nativeDir, 'DOC-001.eml'), eml, 'utf8');

  // CSV .DAT. Uses Windows back-slash separators in one ref to exercise the
  // path-separator normalisation; forward slashes in others.
  const dat = [
    'DOCID,TEXTPATH,NATIVEPATH,FILETYPE,THREADID,THREADPOSITION,THREADSIZE,PARENTID,TRANSLATEDTEXTPATH,TRANSLATEDFROM,TRANSLATEDTO,SUBJECT,DATESENT',
    'DOC-001,TEXT\\DOC-001.txt,NATIVE\\DOC-001.eml,message/rfc822,THREAD-A,1,2,,TEXT/DOC-001.en.txt,fr,en,Reunion budget,2024-03-15',
    'DOC-002,TEXT/DOC-002.txt,,application/pdf,THREAD-A,2,2,DOC-001,,,,Re: Reunion budget,2024-03-15',
    'DOC-003,TEXT/DOC-003.txt,,,,,,DOC-DOESNOTEXIST,,,,Orphan child,2024-03-16',
  ].join('\n') + '\n';
  const datPath = path.join(root, 'loadfile.DAT');
  fs.writeFileSync(datPath, dat, 'utf8');

  // --- throwaway case -------------------------------------------------------
  const caseRow = await query<{ id: number }>(
    `INSERT INTO cases (name, status) VALUES ($1,'open') RETURNING id`,
    [`__phase1_test_${Date.now()}`]
  );
  const caseId = caseRow.rows[0].id;
  console.log(`\nFixture root: ${root}`);
  console.log(`Throwaway case id: ${caseId}\n`);

  try {
    // --- run the import -----------------------------------------------------
    const res = await runImport({
      caseId,
      datPath,
      sourceRoot: root,
      importedBy: null,
      setName: 'Phase-1 fixture',
      log: () => { /* quiet */ },
    });
    console.log(`runImport -> setId=${res.setId}, docCount=${res.docCount}, pageCount=${res.pageCount}\n`);

    // --- Bug 1: text indexed + searchable (incl. cross-language) ------------
    const docs = await query<any>(
      `SELECT id, control_number, has_text, native_type, native_mime, native_filename,
              native_storage_name, native_sha256, thread_id, thread_position, thread_size,
              thread_subject, parent_control_number, metadata
         FROM documents WHERE case_id=$1 ORDER BY control_number`,
      [caseId]
    );
    const byCtl: Record<string, any> = {};
    for (const d of docs.rows) byCtl[d.control_number] = d;
    console.log('--- documents (queried) ---');
    for (const d of docs.rows) {
      console.log(`  ${d.control_number}: has_text=${d.has_text} native_type=${d.native_type} native_mime=${d.native_mime} native_filename=${d.native_filename} thread_id=${d.thread_id ? d.thread_id.slice(0, 12) + '…' : null} pos=${d.thread_position} size=${d.thread_size} parent=${d.parent_control_number}`);
    }
    console.log('');

    check('Bug1 text indexed', byCtl['DOC-001']?.has_text === true && byCtl['DOC-002']?.has_text === true,
      `DOC-001 has_text=${byCtl['DOC-001']?.has_text}, DOC-002 has_text=${byCtl['DOC-002']?.has_text}`);

    const english = await query<any>(
      `SELECT control_number FROM documents
         WHERE case_id=$1 AND search_tsv @@ plainto_tsquery('english',$2) ORDER BY control_number`,
      [caseId, 'quarterly budget']
    );
    check('Bug1 full-text searchable', english.rows.some((r) => r.control_number === 'DOC-001'),
      `search 'quarterly budget' -> [${english.rows.map((r) => r.control_number).join(', ')}]`);

    const crossLang = await query<any>(
      `SELECT control_number FROM documents
         WHERE case_id=$1 AND search_tsv @@ plainto_tsquery('english',$2)`,
      [caseId, 'zebracrossword']
    );
    check('Bug1 cross-language search (EN translation finds FR-original doc)',
      crossLang.rows.length === 1 && crossLang.rows[0].control_number === 'DOC-001',
      `search English-only token 'zebracrossword' -> [${crossLang.rows.map((r) => r.control_number).join(', ')}]`);

    // --- Bug 2: native type from declared/detected, not image format --------
    const d1 = byCtl['DOC-001'];
    check('Bug2 native_mime = declared/detected (message/rfc822)', d1?.native_mime === 'message/rfc822',
      `DOC-001 native_mime=${d1?.native_mime}`);
    check('Bug2 original filename kept separate from storage (hash) name',
      d1?.native_filename === 'DOC-001.eml' && !!d1?.native_storage_name && d1?.native_storage_name === d1?.native_sha256
        && d1?.native_storage_name !== d1?.native_filename,
      `native_filename=${d1?.native_filename}, native_storage_name=${d1?.native_storage_name?.slice(0, 16)}…`);
    check('Bug2 native_type is NOT an image format', d1?.native_type === 'native',
      `DOC-001 native_type=${d1?.native_type}`);
    check('Bug2 declared type without a native file still recorded (DOC-002 application/pdf)',
      byCtl['DOC-002']?.native_mime === 'application/pdf',
      `DOC-002 native_mime=${byCtl['DOC-002']?.native_mime}`);

    // Verify the native actually landed in the content-addressed blob store.
    const blob = await query<any>(`SELECT sha256, mime_type, ref_count FROM blobs WHERE sha256=$1`, [d1?.native_sha256]);
    check('Bug2 native stored in blob store (content-addressed + ref-counted)',
      blob.rows.length === 1 && blob.rows[0].mime_type === 'message/rfc822' && blob.rows[0].ref_count >= 1,
      blob.rows.length ? `blobs row mime=${blob.rows[0].mime_type} ref_count=${blob.rows[0].ref_count}` : 'no blobs row');

    // --- Bug 3: threading ---------------------------------------------------
    check('Bug3 thread_id/position/size populated',
      !!d1?.thread_id && d1?.thread_position === 1 && d1?.thread_size === 2
        && byCtl['DOC-002']?.thread_position === 2,
      `DOC-001 pos/size=${d1?.thread_position}/${d1?.thread_size}, DOC-002 pos=${byCtl['DOC-002']?.thread_position}`);
    check('Bug3 same supplied THREADID -> same derived thread_id',
      !!d1?.thread_id && d1?.thread_id === byCtl['DOC-002']?.thread_id,
      `DOC-001 thread_id === DOC-002 thread_id: ${d1?.thread_id === byCtl['DOC-002']?.thread_id}`);

    // --- Family by PARENTID -------------------------------------------------
    check('Family parent_control_number set (found parent)',
      byCtl['DOC-002']?.parent_control_number === 'DOC-001',
      `DOC-002 parent_control_number=${byCtl['DOC-002']?.parent_control_number}`);

    const failRows = await query<any>(
      `SELECT control_number, code, reason, failed_value FROM import_failures
         WHERE case_id=$1 ORDER BY control_number, code`,
      [caseId]
    );
    console.log('\n--- import_failures (queried) ---');
    for (const f of failRows.rows) console.log(`  ${f.control_number} [${f.code}] ${f.reason} (value=${f.failed_value})`);
    console.log('');
    const parentFail = failRows.rows.find((f) => f.code === 'parent_not_found' && f.control_number === 'DOC-003');
    check('Family unfound parent reported (import_failures.parent_not_found)',
      !!parentFail, parentFail ? `DOC-003 failed_value=${parentFail.failed_value}` : 'no parent_not_found row');
    check('Family unfound-parent child flagged in metadata (Parent Unresolved)',
      !!byCtl['DOC-003']?.metadata?.['Parent Unresolved'],
      `DOC-003 metadata['Parent Unresolved']=${byCtl['DOC-003']?.metadata?.['Parent Unresolved']}`);

    // --- translation version ------------------------------------------------
    const texts = await query<any>(
      `SELECT d.control_number, t.language, t.kind, t.is_original, t.translated_from, t.char_length
         FROM document_text t JOIN documents d ON d.id = t.document_id
        WHERE d.case_id=$1 ORDER BY d.control_number, t.kind`,
      [caseId]
    );
    console.log('--- document_text versions (queried) ---');
    for (const t of texts.rows) console.log(`  ${t.control_number}: lang=${t.language} kind=${t.kind} is_original=${t.is_original} from=${t.translated_from} chars=${t.char_length}`);
    console.log('');
    const extracted = texts.rows.find((t) => t.control_number === 'DOC-001' && t.kind === 'extracted');
    const translation = texts.rows.find((t) => t.control_number === 'DOC-001' && t.kind === 'translation');
    check('Translation original (extracted) version in fr', !!extracted && extracted.language === 'fr' && extracted.is_original === true,
      extracted ? `lang=${extracted.language} is_original=${extracted.is_original}` : 'missing');
    check('Translation version created (en, translated_from=fr)',
      !!translation && translation.language === 'en' && translation.translated_from === 'fr' && translation.is_original === false,
      translation ? `lang=${translation.language} translated_from=${translation.translated_from}` : 'missing');

    // --- verification counts (request 9: account for every item) -----------
    const vrow = await query<any>(`SELECT verification FROM loadfile_imports WHERE id=$1`, [res.setId]);
    console.log('--- loadfile_imports.verification (queried) ---');
    console.log('  ' + JSON.stringify(vrow.rows[0]?.verification));
    console.log('');
    const v = vrow.rows[0]?.verification || {};
    check('Verification accounts for every item',
      v.items_received === 3 && v.items_created === 3 && v.text_indexed === 3 && v.translations_created === 1
        && v.natives_stored === 1 && v.threads_populated === 2 && v.families_linked === 1,
      `received=${v.items_received} created=${v.items_created} text_indexed=${v.text_indexed} translations=${v.translations_created} natives=${v.natives_stored} threaded=${v.threads_populated} families=${v.families_linked} failures=${v.failures}`);

    // --- Field-mapping option: integrator's OWN column names bound to platform
    // fields without renaming columns, e.g. {"DOC_REF":"control_number", ...} ---
    const mapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-fixture-map-'));
    fs.mkdirSync(path.join(mapRoot, 'T'), { recursive: true });
    fs.writeFileSync(path.join(mapRoot, 'T', 'a.txt'), 'Mapped import body text.\n', 'utf8');
    // None of these headers match the built-in aliases, so only an explicit
    // mapping can bind them.
    const mapDat = [
      'DOC_REF,BODY_FILE,CONV_KEY,CONV_POS',
      'MAP-001,T/a.txt,CONV-9,1',
    ].join('\n') + '\n';
    const mapDatPath = path.join(mapRoot, 'mapped.DAT');
    fs.writeFileSync(mapDatPath, mapDat, 'utf8');
    const mapCaseRow = await query<{ id: number }>(
      `INSERT INTO cases (name, status) VALUES ($1,'open') RETURNING id`,
      [`__phase1_map_${Date.now()}`]
    );
    const mapCaseId = mapCaseRow.rows[0].id;
    try {
      await runImport({
        caseId: mapCaseId,
        datPath: mapDatPath,
        sourceRoot: mapRoot,
        importedBy: null,
        setName: 'Phase-1 field-mapping',
        fieldMapping: { DOC_REF: 'control_number', BODY_FILE: 'text_path', CONV_KEY: 'thread_id', CONV_POS: 'thread_position' },
        log: () => { /* quiet */ },
      });
      const mapDoc = await query<any>(
        `SELECT control_number, has_text, thread_id, thread_position FROM documents WHERE case_id=$1`,
        [mapCaseId]
      );
      const m = mapDoc.rows[0];
      console.log('\n--- field-mapping import (queried) ---');
      console.log(`  ${m?.control_number}: has_text=${m?.has_text} thread_id=${m?.thread_id ? m.thread_id.slice(0, 12) + '…' : null} pos=${m?.thread_position}`);
      console.log('');
      check('Field-mapping binds integrator columns to platform fields',
        m?.control_number === 'MAP-001' && m?.has_text === true && !!m?.thread_id && m?.thread_position === 1,
        `control_number=${m?.control_number} has_text=${m?.has_text} thread_id set=${!!m?.thread_id} pos=${m?.thread_position}`);
    } finally {
      await query(`DELETE FROM cases WHERE id=$1`, [mapCaseId]);
      try { fs.rmSync(mapRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }

  } finally {
    // --- clean up the throwaway case -------------------------------------
    await query(`DELETE FROM cases WHERE id=$1`, [caseId]);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\nCleaned up throwaway case ${caseId} and fixture dir.`);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  await pool.end().catch(() => { /* ignore */ });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('TEST ERROR:', e);
  await pool.end().catch(() => { /* ignore */ });
  process.exit(1);
});
