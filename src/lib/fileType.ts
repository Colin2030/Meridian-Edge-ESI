// Shared SQL for deriving a document's file-type bucket, used by BOTH the ECA
// file-type breakdown (cases.ts /eca) and the document-list file-type filter
// (documents.ts) so the counts shown in the filter UI always match exactly what
// the filter returns.
//
// The bucket is derived robustly so it works across loadfile schemas (see
// displayFields.ts for the full rationale):
//   1. Explicit filename extension (metadata 'File Name' or 'FILENAME'),
//      e.g. preferred_supplier.eml -> 'eml'.
//   2. Friendly FILETYPE/MIME label, e.g. message/rfc822 -> 'Email'.
//   3. Raw FILETYPE value if unmapped.
//   4. native_type (e.g. 'tiff').
//   5. 'Unknown'.
//
// For email corpora with no filename extension this yields the meaningful bucket
// 'Email' (from the MIME type) instead of lumping everything into 'Unknown'.
//
// metaCol / nativeCol are the SQL references to the documents columns (e.g.
// 'metadata'/'native_type' or 'd.metadata'/'d.native_type' when aliased).

import { friendlyMimeSql } from './displayFields';

// Extract the lowercased extension from the first non-empty filename variant,
// stripping any extracted-row child suffix (name.csv_row_N -> name.csv). The
// [^.] guard requires a non-dot character before the final dot so leading-dot
// dotfiles (.gitignore) yield NULL rather than a spurious extension.
export function fileTypeExtSql(metaCol = 'metadata'): string {
  const name = `COALESCE(NULLIF(${metaCol}->>'File Name',''), NULLIF(${metaCol}->>'FILENAME',''))`;
  return `lower(substring(regexp_replace(${name}, '_row_[0-9]+$', '', 'i') from '[^.]\\.([A-Za-z0-9]+)$'))`;
}

export function fileTypeBucketSql(metaCol = 'metadata', nativeCol = 'native_type'): string {
  const mime = `NULLIF(${metaCol}->>'FILETYPE','')`;
  return `COALESCE(
    ${fileTypeExtSql(metaCol)},
    ${friendlyMimeSql(mime)},
    ${mime},
    NULLIF(${nativeCol},''),
    'Unknown')`;
}

// ============================================================================
// Content-based native type detection (VIEW-ONLY).
// ----------------------------------------------------------------------------
// "Detect file type from content, never from the extension": determine a native's
// MIME type from its first bytes, using any DECLARED type (a FILETYPE/MIMETYPE
// column or manifest mimeType) only as a HINT. In real exports a large share of
// attachments carry the wrong extension, so the extension is a weak signal. This
// inspects magic bytes only — it performs no extraction or forensic processing.
// ============================================================================

/**
 * Detect a MIME type from a file's leading bytes (magic numbers). Returns null when
 * the signature is not recognised, so the caller can fall back to a declared value.
 */
export function detectMimeFromBytes(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  const ascii = (n: number) => b.subarray(0, n).toString('latin1');

  // Container / office / zip-based (OOXML) — all begin PK\x03\x04.
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    // Look for OOXML / ODF markers in the local file name entries.
    const head = b.subarray(0, Math.min(b.length, 4000)).toString('latin1');
    if (head.includes('word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (head.includes('xl/')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (head.includes('ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (head.includes('mimetypeapplication/vnd.oasis.opendocument')) return 'application/vnd.oasis.opendocument.text';
    return 'application/zip';
  }
  // PDF
  if (ascii(5) === '%PDF-') return 'application/pdf';
  // Legacy MS Office / Outlook .msg (OLE2 compound file)
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/x-ole-storage';
  // TIFF (little- or big-endian)
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return 'image/tiff';
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // GIF
  if (ascii(3) === 'GIF') return 'image/gif';
  // RFC 822 email (.eml) — heuristic on common headers near the start.
  {
    const head = b.subarray(0, Math.min(b.length, 2000)).toString('latin1');
    if (/^(from|received|return-path|message-id|date|subject|to|mime-version)\s*:/im.test(head)
        && /\n(subject|from|to|date)\s*:/im.test(head)) {
      return 'message/rfc822';
    }
  }
  return null;
}

/** Map a filename extension to a MIME type (last-resort hint). */
export function mimeFromExtension(filename: string): string | null {
  const ext = (filename.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase();
  if (!ext) return null;
  const map: Record<string, string> = {
    pdf: 'application/pdf', tif: 'image/tiff', tiff: 'image/tiff',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html',
    eml: 'message/rfc822', msg: 'application/vnd.ms-outlook',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip', rtf: 'application/rtf', json: 'application/json', xml: 'application/xml',
  };
  return map[ext] || null;
}

/**
 * Resolve a native's authoritative MIME type. Order: a DECLARED value (from a
 * FILETYPE/MIMETYPE column or manifest) when it looks like a real MIME type, then
 * content detection from the bytes, then the filename extension, then null. The
 * declared value is a HINT — content detection is preferred over the extension.
 */
export function resolveNativeMime(
  declared: string | undefined,
  filename: string | undefined,
  buf?: Buffer | null
): string | null {
  const dec = (declared || '').trim();
  const detected = buf ? detectMimeFromBytes(buf) : null;
  // A declared value that is a proper MIME type (type/subtype) is authoritative.
  if (dec && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(dec)) return dec.toLowerCase();
  // Otherwise prefer content detection, then the (declared non-MIME label or) extension.
  if (detected) return detected;
  if (dec) return dec; // a friendly label like "Email" / "PDF Document"
  return filename ? mimeFromExtension(filename) : null;
}
