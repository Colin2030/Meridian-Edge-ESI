import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { SAMPLE_DOCS, SampleDoc } from './sample_content';
import { CONCORDANCE } from '../src/lib/loadfile';

const LINES_PER_PAGE = 9;

function paginate(body: string): string[][] {
  const lines = body.split('\n');
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  return pages.length ? pages : [['']];
}

// Render each page of a TIFF doc as its own single-page TIFF (realistic Opticon layout).
// Returns the ordered list of per-page TIFF file paths.
function renderTiffPages(doc: SampleDoc, pages: string[][], imagesDir: string): string[] {
  const files: string[] = [];
  pages.forEach((pg, idx) => {
    const text = pg.join('\n');
    const pageFile = path.join(imagesDir, `${doc.control}.${String(idx + 1).padStart(3, '0')}.tiff`);
    execFileSync('convert', [
      '-background', 'white', '-fill', 'black', '-font', 'DejaVu-Sans-Mono',
      '-pointsize', '18', '-size', '900x',
      `caption:${text}`,
      '-bordercolor', 'white', '-border', '40x50',
      '-extent', '980x1386',           // ~A4 at ~120dpi so pages are uniform
      '-compress', 'LZW', pageFile,
    ], { stdio: 'ignore' });
    files.push(pageFile);
  });
  return files;
}

function renderPdf(pages: string[][], outFile: string) {
  execFileSync('python3', [path.resolve(__dirname, 'pdf_render.py'), outFile, JSON.stringify(pages)], { stdio: 'ignore' });
}

export interface GenResult { datPath: string; optPath: string; imagesDir: string; outDir: string; }

export function generateSamples(outDir: string): GenResult {
  const imagesDir = path.join(outDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const fields = ['DOCID', 'BEGATTACH', 'ENDATTACH', 'DATE', 'FROM', 'TO', 'SUBJECT', 'AUTHOR', 'DOCTYPE', 'FILENAME', 'CUSTODIAN', 'PAGECOUNT', 'EXTRACTED_TEXT'];
  const { FIELD, QUOTE } = CONCORDANCE;
  const q = (v: string) => `${QUOTE}${(v || '').replace(/\n/g, ' ')}${QUOTE}`;

  const datLines: string[] = [fields.map(q).join(FIELD)];
  const optLines: string[] = [];

  for (const doc of SAMPLE_DOCS) {
    const pages = paginate(doc.body);
    // .DAT row (metadata is identical regardless of native type)
    const row = [doc.control, doc.begAttach || '', doc.endAttach || '', doc.date, doc.from, doc.to, doc.subject, doc.author, doc.type, doc.filename, doc.custodian, String(pages.length), doc.body];
    datLines.push(row.map(q).join(FIELD));

    if (doc.native === 'pdf') {
      // One multi-page PDF; a single OPT line references it (DocBreak=Y, PageCount=N).
      const pdfFile = path.join(imagesDir, `${doc.control}.pdf`);
      renderPdf(pages, pdfFile);
      const rel = path.relative(imagesDir, pdfFile);
      optLines.push([doc.control, 'VOL001', rel, 'Y', '', '', String(pages.length)].join(','));
    } else {
      // One single-page TIFF per page; one OPT line per page, grouped by DocBreak=Y.
      const pageFiles = renderTiffPages(doc, pages, imagesDir);
      pageFiles.forEach((pf, idx) => {
        // First page's image key == control number (standard Opticon/BEGDOC convention).
        const key = idx === 0 ? doc.control : `${doc.control}.${String(idx + 1).padStart(3, '0')}`;
        const rel = path.relative(imagesDir, pf);
        optLines.push([key, 'VOL001', rel, idx === 0 ? 'Y' : '', '', '', idx === 0 ? String(pages.length) : ''].join(','));
      });
    }
  }

  const datPath = path.join(outDir, 'northwind.dat');
  const optPath = path.join(outDir, 'northwind.opt');
  fs.writeFileSync(datPath, datLines.join('\r\n') + '\r\n', 'utf8');
  fs.writeFileSync(optPath, optLines.join('\r\n') + '\r\n', 'utf8');
  return { datPath, optPath, imagesDir, outDir };
}

if (require.main === module) {
  const out = process.argv[2] || path.resolve(process.cwd(), 'sample-data');
  const r = generateSamples(out);
  // eslint-disable-next-line no-console
  console.log('Generated samples at', r.outDir, '\nDAT:', r.datPath, '\nOPT:', r.optPath);
}
