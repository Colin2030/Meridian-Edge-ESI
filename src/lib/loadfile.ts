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

// ============================================================================
// EDRM XML 1.x loadfile parser
// ----------------------------------------------------------------------------
// Reads an EDRM XML loadfile (as produced by common processing engines, e.g.
// EDRM XML 1.2 / Nuix-style exports) into a normalised in-memory structure that
// the ingest pipeline maps onto the existing document / folder / family model.
//
// This is a READER only — it imports the OUTPUT of a processing engine. It adds
// no processing/forensic capability. Parsing is done with the vendored `saxes`
// SAX parser (no new runtime dependency); a 1–2 MB loadfile parses comfortably
// in memory.
//
// Schema handled (all inside <Root><Batch>):
//   <Fields>        field definitions (Key/Name/DataType/EDRMFieldMap)
//   <Documents>     <Document DocID DocType MimeType> with <FieldValues>,
//                   <Files><File FileType><ExternalFile FilePath FileName FileSize>,
//                   and <Locations><Location><Custodian><LocationURI><Description>
//   <Relationships> <Relationship Type ParentDocId ChildDocId>  (family/attachments)
//   <Folders>       nested <Folder FolderName> tree with <Document DocId> placements
//   <CustomBatchInfo> optional export-stats footer (captured as key/value strings)
// ============================================================================

export interface EdrmFieldDef {
  key: string;
  name: string;
  dataType: string;
  edrmFieldMap?: string;
}

export interface EdrmNativeRef {
  /** Directory portion of the native path, relative to the export root (e.g. "natives/55/27"). */
  dir: string;
  /** File name of the native (e.g. "<sha256>.bin"). */
  file: string;
  size?: number;
}

export interface EdrmLocation {
  custodian?: string;
  /** Original (URL-encoded) LocationURI as written in the loadfile. */
  uri?: string;
  /** Decoded LocationURI for display (percent-decoded, '+' → space). */
  uriDecoded?: string;
  description?: string;
}

export interface EdrmDocument {
  docId: string;
  docType: string; // "File" | "Message" | ...
  mimeType: string;
  /** All <FieldValues> child elements keyed by element name (field Key). */
  fieldValues: Record<string, string>;
  /** Native file reference (FileType="Native"), if present. */
  native?: EdrmNativeRef;
  location?: EdrmLocation;
  /** Parent document id taken from the PARENTDOCID field value, if present. */
  parentId?: string;
}

export interface EdrmRelationship {
  type: string; // "Container" | "Attachment" | ...
  parentId: string;
  childId: string;
}

export interface EdrmFolderNode {
  name: string;
  children: EdrmFolderNode[];
  /** Document ids placed directly in this folder (from <Document DocId> refs). */
  docIds: string[];
}

export interface EdrmParseResult {
  majorVersion: string;
  minorVersion: string;
  dataInterchangeType: string;
  fields: EdrmFieldDef[];
  documents: EdrmDocument[];
  relationships: EdrmRelationship[];
  /** Top-level folder nodes (the tree). */
  folders: EdrmFolderNode[];
  /** Optional export-stats footer as flat key/value strings. */
  stats: Record<string, string>;
}

/** Decode an EDRM LocationURI: percent-decode and treat '+' as a space. */
export function decodeLocationUri(uri: string): string {
  if (!uri) return '';
  try {
    return decodeURIComponent(uri.replace(/\+/g, ' '));
  } catch {
    // Malformed percent-escape — fall back to the '+'→space form only.
    return uri.replace(/\+/g, ' ');
  }
}

/**
 * Lightweight sniff: does this content look like an EDRM XML loadfile?
 * Checks the first portion only so it is cheap on large files.
 */
export function isEdrmXml(content: string): boolean {
  const head = content.slice(0, 4000);
  if (!/<\s*Root\b/i.test(head)) return false;
  // EDRM markers: a <Batch> container, or EDRM field maps / known sections.
  return /<\s*Batch\b/i.test(content.slice(0, 20000)) || /DataInterchangeType\s*=/i.test(head);
}

/** Parse an EDRM XML loadfile string into a normalised structure. */
export function parseEdrmXml(content: string): EdrmParseResult {
  // Require()d lazily so the pure DAT/OPT path has no dependency on saxes.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SaxesParser } = require('saxes') as typeof import('saxes');
  const parser = new SaxesParser({ xmlns: false });

  const result: EdrmParseResult = {
    majorVersion: '',
    minorVersion: '',
    dataInterchangeType: '',
    fields: [],
    documents: [],
    relationships: [],
    folders: [],
    stats: {},
  };

  // Element-name stack and a text buffer for the element currently open.
  const stack: string[] = [];
  let textBuf = '';

  // Current document being assembled (inside <Documents>).
  let curDoc: EdrmDocument | null = null;
  // Name of the <FieldValues> child element currently open (field Key).
  let curFieldKey: string | null = null;
  // Current <Location> being assembled.
  let curLoc: EdrmLocation | null = null;
  // Folder stack for the nested <Folders> tree.
  const folderStack: EdrmFolderNode[] = [];
  // Whether we are inside the <CustomBatchInfo> footer.
  let inBatchInfo = false;
  let batchInfoKey: string | null = null;

  const parentOf = () => (stack.length >= 2 ? stack[stack.length - 2] : '');

  parser.on('error', (e) => {
    throw new Error(`EDRM XML parse error: ${e.message}`);
  });

  parser.on('opentag', (node) => {
    const name = node.name;
    const attrs = node.attributes as Record<string, string>;
    const parent = stack.length ? stack[stack.length - 1] : '';
    stack.push(name);
    textBuf = '';

    switch (name) {
      case 'Root':
        result.majorVersion = attrs.MajorVersion || '';
        result.minorVersion = attrs.MinorVersion || '';
        result.dataInterchangeType = attrs.DataInterchangeType || '';
        break;
      case 'Field':
        if (parent === 'Fields') {
          result.fields.push({
            key: attrs.Key || '',
            name: attrs.Name || '',
            dataType: attrs.DataType || '',
            edrmFieldMap: attrs.EDRMFieldMap || undefined,
          });
        }
        break;
      case 'Document':
        if (parent === 'Documents') {
          // A real document record.
          curDoc = {
            docId: attrs.DocID || attrs.DocId || '',
            docType: attrs.DocType || '',
            mimeType: attrs.MimeType || '',
            fieldValues: {},
          };
        } else if (folderStack.length > 0) {
          // A folder placement reference: <Document DocId="..."/> inside a <Folder>.
          const id = attrs.DocId || attrs.DocID || '';
          if (id) folderStack[folderStack.length - 1].docIds.push(id);
        }
        break;
      case 'ExternalFile':
        if (curDoc && parent === 'File') {
          // Only capture Native files (this export carries FileType="Native" only,
          // but guard by walking up to the enclosing <File FileType>).
          curDoc.native = {
            dir: attrs.FilePath || '',
            file: attrs.FileName || '',
            size: attrs.FileSize ? parseInt(attrs.FileSize, 10) || undefined : undefined,
          };
        }
        break;
      case 'Location':
        if (curDoc) curLoc = {};
        break;
      case 'Relationship':
        if (parent === 'Relationships') {
          result.relationships.push({
            type: attrs.Type || '',
            parentId: attrs.ParentDocId || attrs.ParentDocID || '',
            childId: attrs.ChildDocId || attrs.ChildDocID || '',
          });
        }
        break;
      case 'Folder': {
        const nodeF: EdrmFolderNode = { name: attrs.FolderName || attrs.Name || '', children: [], docIds: [] };
        if (folderStack.length > 0) folderStack[folderStack.length - 1].children.push(nodeF);
        else result.folders.push(nodeF);
        folderStack.push(nodeF);
        break;
      }
      case 'CustomBatchInfo':
        inBatchInfo = true;
        break;
      default:
        // Inside <FieldValues>, a child element is a field value keyed by its name.
        if (curDoc && parent === 'FieldValues') {
          curFieldKey = name;
        } else if (inBatchInfo) {
          // Capture leaf stats elements (e.g. RowsWritten) as strings.
          batchInfoKey = name;
        }
        break;
    }
  });

  parser.on('text', (t) => {
    textBuf += t;
  });

  parser.on('closetag', (node) => {
    const name = node.name;
    const val = textBuf.trim();

    switch (name) {
      case 'Document':
        if (curDoc && parentOf() === 'Documents') {
          // PARENTDOCID field value → parentId
          if (curDoc.fieldValues.PARENTDOCID) curDoc.parentId = curDoc.fieldValues.PARENTDOCID;
          result.documents.push(curDoc);
          curDoc = null;
        }
        break;
      case 'Custodian':
        if (curLoc) curLoc.custodian = val;
        break;
      case 'LocationURI':
        if (curLoc) {
          curLoc.uri = val;
          curLoc.uriDecoded = decodeLocationUri(val);
        }
        break;
      case 'Description':
        if (curLoc) curLoc.description = val;
        break;
      case 'Location':
        if (curDoc && curLoc) {
          // Keep the first (primary) location.
          if (!curDoc.location) curDoc.location = curLoc;
          curLoc = null;
        }
        break;
      case 'Folder':
        folderStack.pop();
        break;
      case 'CustomBatchInfo':
        inBatchInfo = false;
        batchInfoKey = null;
        break;
      default:
        if (curDoc && curFieldKey && name === curFieldKey && parentOf() === 'FieldValues') {
          // Store field value (concatenate if repeated).
          curDoc.fieldValues[curFieldKey] = curDoc.fieldValues[curFieldKey]
            ? `${curDoc.fieldValues[curFieldKey]}; ${val}`
            : val;
          curFieldKey = null;
        } else if (inBatchInfo && batchInfoKey && name === batchInfoKey) {
          if (val) result.stats[batchInfoKey] = val;
          batchInfoKey = null;
        }
        break;
    }

    stack.pop();
    textBuf = '';
  });

  parser.write(content).close();
  return result;
}
