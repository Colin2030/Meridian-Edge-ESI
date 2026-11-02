import fs from 'fs';
import path from 'path';
import { pool } from '../src/db';

async function main() {
  const dir = path.resolve(process.cwd(), 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    process.stdout.write(`Applying ${f} ... `);
    await pool.query(sql);
    console.log('ok');
  }
  console.log('Migrations complete.');
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
