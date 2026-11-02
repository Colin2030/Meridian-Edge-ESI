import { pool } from '../src/db';
import { config } from '../src/config';
import { runImport } from '../src/lib/ingest';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const caseId = parseInt(arg('case') || '', 10);
  const dat = arg('dat');
  const opt = arg('opt');
  const images = arg('images');
  const ocr = process.argv.includes('--ocr') || config.enableOcr;
  if (!caseId || !dat) {
    console.error('Usage: npm run import -- --case <id> --dat <file.dat> [--opt <file.opt>] [--images <dir>] [--ocr]');
    process.exit(1);
  }
  const res = await runImport({
    caseId, datPath: dat, optPath: opt, imagesDir: images, ocr,
    log: (m) => console.log(m),
  });
  console.log(`Done. set=${res.setId} docs=${res.docCount} pages=${res.pageCount}`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
