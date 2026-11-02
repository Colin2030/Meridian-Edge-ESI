import fs from 'fs';

/** Concordance standard delimiters */
export const CONCORDANCE = {
  FIELD: '\u0014', // ASCII 20 (0x14) — shown as ¶
  QUOTE: '\u00FE', // ASCII 254 (0xFE) — shown as þ
  MULTI: ';',      // ASCII 59 multi-value separator
};

export interface DatParseResult {
  fields: string[];
  rows: Record<string, string>[];
  delimiterSet: { field: string; quote: string; multi: string; kind: 'concordance' | 'csv' | 'tsv' };
}

function detectDelimiters(headerLine: string): DatParseResult['delimiterSet'] {
  if (headerLine.includes(CONCORDANCE.FIELD)) {
    return { field: CONCORDANCE.FIELD, quote: CONCORDANCE.QUOTE, multi: CONCORDANCE.MULTI, kind: 'concordance' };
  }
  if (headerLine.includes('\t')) {
    return { field: '\t', quote: '"', multi: ';', kind: 'tsv' };
  }
  return { field: ',', quote: '"', multi: ';', kind: 'csv' };
}

/** Split a single line respecting a text qualifier/quote char. */
function splitLine(line: string, field: string, quote: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === quote) {
      // CSV-style doubled quote escape
      if (inQuote && line[i + 1] === quote) {
        cur += quote;
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === field && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Parse a .DAT metadata loadfile (Concordance-delimited, CSV, or TSV). */
export function parseDat(content: string): DatParseResult {
  // Normalise newlines; drop BOM.
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = text.split('\n');
  // Find first non-empty line as header.
  let hIdx = 0;
  while (hIdx < rawLines.length && rawLines[hIdx].trim() === '') hIdx++;
  if (hIdx >= rawLines.length) return { fields: [], rows: [], delimiterSet: detectDelimiters('') };
  const headerLine = rawLines[hIdx];
  const d = detectDelimiters(headerLine);
  const fields = splitLine(headerLine, d.field, d.quote).map((f) => f.trim());

  const rows: Record<string, string>[] = [];
  for (let i = hIdx + 1; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.trim() === '') continue;
    const cells = splitLine(line, d.field, d.quote);
    const row: Record<string, string> = {};
    fields.forEach((fname, idx) => {
      row[fname] = (cells[idx] ?? '').trim();
    });
    rows.push(row);
  }
  return { fields, rows, delimiterSet: d };
}

export interface OptPage {
  imageKey: string;
  volume: string;
  fullPath: string;
  docBreak: boolean;
  pageCount?: number;
}
export interface OptDocument {
  firstKey: string;
  pages: OptPage[];
}

/** Parse a .OPT (Opticon) image cross-reference file. */
export function parseOpt(content: string): OptDocument[] {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const pages: OptPage[] = [];
  for (const line of lines) {
    const parts = line.split(',');
    // ImageKey,Volume,FullPath,DocBreak,FolderBreak,BoxBreak,PageCount
    pages.push({
      imageKey: (parts[0] || '').trim(),
      volume: (parts[1] || '').trim(),
      fullPath: (parts[2] || '').trim(),
      docBreak: ((parts[3] || '').trim().toUpperCase() === 'Y'),
      pageCount: parts[6] ? parseInt(parts[6].trim(), 10) || undefined : undefined,
    });
  }
  // Group into documents on DocBreak=Y
  const docs: OptDocument[] = [];
  let current: OptDocument | null = null;
  for (const p of pages) {
    if (p.docBreak || current === null) {
      current = { firstKey: p.imageKey, pages: [p] };
      docs.push(current);
    } else {
      current.pages.push(p);
    }
  }
  return docs;
}

/** Common field aliases (case-insensitive) → normalised key. */
const FIELD_ALIASES: Record<string, string[]> = {
  control_number: ['docid', 'begdoc', 'beg_doc', 'batesbeg', 'bates_beg', 'controlnumber', 'control_number', 'control number', 'begbates', 'prodbeg'],
  beg_attach: ['begattach', 'beg_attach', 'attachbeg'],
  end_attach: ['endattach', 'end_attach', 'attachend'],
  text_path: ['textpath', 'text_path', 'ocrpath', 'extractedtext', 'text', 'ocr'],
  native_path: ['nativepath', 'native_path', 'nativelink', 'native', 'filepath', 'file_path'],
  date: ['date', 'datesent', 'date_sent', 'docdate', 'date_created'],
  from: ['from', 'author', 'sender'],
  to: ['to', 'recipient', 'recipients'],
  subject: ['subject', 'title', 're'],
  filename: ['filename', 'file_name', 'file'],
};

export function identifyField(fieldNames: string[], target: keyof typeof FIELD_ALIASES): string | null {
  const aliases = FIELD_ALIASES[target];
  for (const fn of fieldNames) {
    const norm = fn.toLowerCase().replace(/[\s_-]/g, '');
    for (const a of aliases) {
      if (norm === a.replace(/[\s_-]/g, '')) return fn;
    }
  }
  return null;
}

export function buildFieldMap(fieldNames: string[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  (Object.keys(FIELD_ALIASES) as (keyof typeof FIELD_ALIASES)[]).forEach((k) => {
    map[k] = identifyField(fieldNames, k);
  });
  return map;
}
