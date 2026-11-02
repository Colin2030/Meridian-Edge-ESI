import path from 'path';
import fs from 'fs';
import { pool, query } from '../src/db';
import { hashPassword } from '../src/lib/auth';
import { runImport } from '../src/lib/ingest';
import { generateSamples } from './gen_samples';

const CREDS = {
  admin:    { pw: 'Admin!Northwind2025',    name: 'System Administrator', email: 'admin@meridian-edge.example',   sysadmin: true },
  manager:  { pw: 'Manager!Northwind2025',  name: 'Priya Chandra (Case Manager)', email: 'p.chandra@meridian-edge.example', sysadmin: false },
  reviewer: { pw: 'Reviewer!Northwind2025', name: 'Tom Ellis (Reviewer)', email: 't.ellis@meridian-edge.example', sysadmin: false },
  readonly: { pw: 'ReadOnly!Northwind2025', name: 'Jo Marsh (Read Only)', email: 'j.marsh@meridian-edge.example', sysadmin: false },
};

async function upsertUser(username: string, c: { pw: string; name: string; email: string; sysadmin: boolean }): Promise<number> {
  const { rows } = await query<any>(
    `INSERT INTO users (username, email, display_name, password_hash, is_system_admin)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (username) DO UPDATE SET email=EXCLUDED.email, display_name=EXCLUDED.display_name,
       password_hash=EXCLUDED.password_hash, is_system_admin=EXCLUDED.is_system_admin, active=TRUE
     RETURNING id`,
    [username, c.email, c.name, hashPassword(c.pw), c.sysadmin]
  );
  return rows[0].id;
}

async function main() {
  console.log('Seeding Meridian Edge demo data...');
  const enableOcr = process.argv.includes('--ocr');

  const adminId = await upsertUser('admin', CREDS.admin);
  const managerId = await upsertUser('manager', CREDS.manager);
  const reviewerId = await upsertUser('reviewer', CREDS.reviewer);
  const readonlyId = await upsertUser('readonly', CREDS.readonly);
  console.log('Users ready: admin, manager, reviewer, readonly');

  // Primary demo case
  let caseRow = (await query<any>(`SELECT id FROM cases WHERE name=$1`, ['Operation Northwind (DEMO)'])).rows[0];
  let caseId: number;
  if (caseRow) {
    caseId = caseRow.id;
    // reset its docs so seed is idempotent
    await query(`DELETE FROM documents WHERE case_id=$1`, [caseId]);
    await query(`DELETE FROM loadfile_imports WHERE case_id=$1`, [caseId]);
  } else {
    caseId = (await query<any>(
      `INSERT INTO cases (name, case_number, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['Operation Northwind (DEMO)', 'NW-2023', 'FICTIONAL demonstration case: suspected procurement fraud at Harwick Logistics Ltd. All content synthetic.', adminId]
    )).rows[0].id;
  }

  // Second, isolated case the reviewer is NOT a member of
  let case2 = (await query<any>(`SELECT id FROM cases WHERE name=$1`, ['Operation Blackthorn (DEMO)'])).rows[0];
  let case2Id: number;
  if (case2) { case2Id = case2.id; }
  else {
    case2Id = (await query<any>(
      `INSERT INTO cases (name, case_number, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      ['Operation Blackthorn (DEMO)', 'BT-2024', 'FICTIONAL second case used to demonstrate case isolation (reviewer has no access).', adminId]
    )).rows[0].id;
  }

  // Memberships (admin is global sysadmin, no membership rows needed)
  const members: [number, number, string][] = [
    [managerId, caseId, 'case_manager'],
    [reviewerId, caseId, 'reviewer'],
    [readonlyId, caseId, 'read_only'],
    [managerId, case2Id, 'case_manager'], // manager also manages case 2 (reviewer deliberately excluded)
  ];
  for (const [uid, cid, role] of members) {
    await query(
      `INSERT INTO case_memberships (user_id, case_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, case_id) DO UPDATE SET role=EXCLUDED.role`, [uid, cid, role]);
  }

  // Tags
  const tagDefs = [['Hot', '#dc2626'], ['Key evidence', '#b45309'], ['Follow up', '#2563eb'], ['Financial', '#059669']];
  const tagIds: Record<string, number> = {};
  for (const [name, colour] of tagDefs) {
    const t = (await query<any>(
      `INSERT INTO tags (case_id, name, colour) VALUES ($1,$2,$3)
       ON CONFLICT (case_id, name) DO UPDATE SET colour=EXCLUDED.colour RETURNING id`, [caseId, name, colour])).rows[0];
    tagIds[name] = t.id;
  }

  // Generate sample files and import through the real loadfile pipeline
  const sampleDir = path.resolve(process.cwd(), 'sample-data');
  console.log('Generating synthetic TIFF/PDF/.DAT/.OPT sample set...');
  const gen = generateSamples(sampleDir);
  console.log('Importing via loadfile pipeline (OCR=' + enableOcr + ')...');
  const res = await runImport({
    caseId, datPath: gen.datPath, optPath: gen.optPath, imagesDir: gen.imagesDir,
    importedBy: adminId, setName: 'Northwind production set 001', ocr: enableOcr,
    log: (m) => console.log('  ' + m),
  });

  // Apply some demo review states / tags / bookmarks / comments so the UI is populated
  const docs = (await query<any>(`SELECT id, control_number FROM documents WHERE case_id=$1 ORDER BY control_number`, [caseId])).rows;
  const byCtrl: Record<string, number> = {};
  docs.forEach((d: any) => (byCtrl[d.control_number] = d.id));
  const setState = async (ctrl: string, status: string, uid: number) => {
    if (!byCtrl[ctrl]) return;
    await query(`UPDATE review_states SET status=$2, reviewed_by=$3, reviewed_at=now() WHERE document_id=$1`, [byCtrl[ctrl], status, uid]);
  };
  await setState('NW-000005', 'responsive', reviewerId);
  await setState('NW-000009', 'responsive', reviewerId);
  await setState('NW-000014', 'responsive', reviewerId);
  await setState('NW-000015', 'responsive', reviewerId);
  await setState('NW-000019', 'privileged', managerId);
  await setState('NW-000002', 'further_review', reviewerId);
  await setState('NW-000016', 'non_responsive', reviewerId);
  await setState('NW-000003', 'in_review', reviewerId);

  const tagDoc = async (ctrl: string, tag: string) => {
    if (!byCtrl[ctrl]) return;
    await query(`INSERT INTO document_tags (document_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [byCtrl[ctrl], tagIds[tag]]);
  };
  await tagDoc('NW-000005', 'Key evidence'); await tagDoc('NW-000005', 'Financial');
  await tagDoc('NW-000009', 'Hot'); await tagDoc('NW-000015', 'Hot');
  await tagDoc('NW-000014', 'Financial'); await tagDoc('NW-000018', 'Follow up');

  const bm = async (ctrl: string, uid: number) => {
    if (!byCtrl[ctrl]) return;
    await query(`INSERT INTO bookmarks (user_id, document_id, case_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uid, byCtrl[ctrl], caseId]);
  };
  await bm('NW-000009', reviewerId); await bm('NW-000015', reviewerId); await bm('NW-000018', managerId);

  const comment = async (ctrl: string, uid: number, body: string) => {
    if (!byCtrl[ctrl]) return;
    await query(`INSERT INTO comments (document_id, case_id, user_id, body) VALUES ($1,$2,$3,$4)`, [byCtrl[ctrl], caseId, uid, body]);
  };
  await comment('NW-000009', reviewerId, 'Clear admission of benefit ("kitchen work... no charge"). Flagging as key.');
  await comment('NW-000009', managerId, 'Agreed. Cross-reference with bank extract NW-000014.');
  await comment('NW-000015', reviewerId, 'Instruction to destroy evidence — potential perverting the course of justice.');

  await query(`INSERT INTO audit_log (user_id, case_id, action, target, detail) VALUES ($1,$2,'seed','demo','Seeded demo data')`, [adminId, caseId]);

  console.log('\n==================== DEMO READY ====================');
  console.log(`Primary case: Operation Northwind (DEMO) [id=${caseId}] — ${res.docCount} docs, ${res.pageCount} pages`);
  console.log(`Isolated case: Operation Blackthorn (DEMO) [id=${case2Id}] (reviewer has NO access)`);
  console.log('\nDemo credentials (username / password):');
  console.log(`  admin    / ${CREDS.admin.pw}      (system admin — sees everything)`);
  console.log(`  manager  / ${CREDS.manager.pw}    (case_manager on Northwind + Blackthorn)`);
  console.log(`  reviewer / ${CREDS.reviewer.pw}   (reviewer on Northwind only)`);
  console.log(`  readonly / ${CREDS.readonly.pw}   (read_only on Northwind)`);
  console.log('====================================================\n');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
