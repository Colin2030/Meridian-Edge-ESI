// Robust, reusable loadfile field-name mapping (frontend side).
//
// Mirrors the precedence in src/lib/displayFields.ts and src/lib/fileType.ts so
// the file list, document viewer and binder all render real names/types/dates for
// every loadfile schema (Concordance 'File Name'/DOCTYPE/DATE, email corpora
// SUBJECT/FILETYPE/DATESENT, EDRM 'Email Subject'/'Date Sent'). Empty strings are
// treated as absent. Keep in sync with the backend helpers when editing either.

type Meta = Record<string, any> | null | undefined;

/** First non-empty (trimmed) string value from the given keys of the metadata object. */
function firstNonEmpty(m: Meta, keys: string[]): string | undefined {
  if (!m) return undefined;
  for (const k of keys) {
    const v = m[k];
    if (v != null && String(v).trim() !== '') return String(v);
  }
  return undefined;
}

// FILETYPE/MIME -> friendly label. Mirrors friendlyMimeSql in the backend.
function friendlyMime(mimeRaw?: string): string | undefined {
  if (!mimeRaw) return undefined;
  const e = mimeRaw.toLowerCase().trim();
  if (!e) return undefined;
  if (e === 'message/rfc822') return 'Email';
  if (['application/vnd.ms-outlook', 'application/vnd.ms-tnef', 'application/mbox'].includes(e)) return 'Email';
  if (e === 'application/pdf') return 'PDF';
  if (['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(e)) return 'Word';
  if (['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(e)) return 'Excel';
  if (['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'].includes(e)) return 'PowerPoint';
  if (e === 'text/calendar') return 'Calendar';
  if (e === 'text/html') return 'HTML';
  if (e === 'application/rtf') return 'Rich Text';
  if (e === 'application/pkcs7-signature') return 'Signature';
  if (['application/zip', 'application/gzip', 'application/x-7z-compressed', 'application/x-rar-compressed'].includes(e)) return 'Archive';
  if (e.startsWith('text/')) return 'Text';
  if (e.startsWith('image/')) return 'Image';
  if (e.startsWith('application/vnd.ms-')) return 'Office';
  if (e.startsWith('application/vnd.openxmlformats-')) return 'Office';
  return undefined;
}

// Extract the lowercased file extension from a filename, stripping any
// extracted-row child suffix (name.csv_row_N -> name.csv). The leading
// non-dot guard means leading-dot dotfiles (.gitignore) yield undefined
// rather than a spurious extension. Mirrors extFromNameSql in the backend.
function extFromName(name?: string): string | undefined {
  if (!name) return undefined;
  const base = name.replace(/_row_[0-9]+$/i, '');
  const m = base.match(/[^.]\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : undefined;
}

/** Display NAME: filename/subject/title variant, else control number. */
export function displayName(m: Meta, controlNumber: string): string {
  return firstNonEmpty(m, ['File Name', 'FILENAME', 'SUBJECT', 'Email Subject', 'Title']) || controlNumber;
}

/** Whether a distinct filename is present (so the UI can show the control number as a sub-label). */
export function hasFileName(m: Meta): boolean {
  return !!firstNonEmpty(m, ['File Name', 'FILENAME']);
}

// Display TYPE (friendly). Precedence: metadata DOCTYPE, friendly FILETYPE label,
// raw FILETYPE (these win for loadfile docs), THEN the real native file type for
// batch-ingested docs — extension from native_filename, friendly native_mime
// label, raw native_mime — and finally the viewer render kind (native_type) as a
// last-resort fallback, else 'Unknown'. Mirrors displayTypeSql in the backend.
export function displayType(
  m: Meta,
  nativeType?: string | null,
  nativeMime?: string | null,
  nativeFilename?: string | null,
): string {
  const mime = firstNonEmpty(m, ['FILETYPE']);
  const nMime = nativeMime && String(nativeMime).trim() ? String(nativeMime) : undefined;
  const nName = nativeFilename && String(nativeFilename).trim() ? String(nativeFilename) : undefined;
  return (
    firstNonEmpty(m, ['DOCTYPE']) ||
    friendlyMime(mime) ||
    mime ||
    extFromName(nName) ||
    friendlyMime(nMime) ||
    nMime ||
    (nativeType && String(nativeType).trim() ? String(nativeType) : undefined) ||
    'Unknown'
  );
}

/** Display DATE: DATE / Date Sent / DATESENT / DateSent. */
export function displayDate(m: Meta): string | undefined {
  return firstNonEmpty(m, ['DATE', 'Date Sent', 'DATESENT', 'DateSent']);
}

/** Display SUBJECT: SUBJECT / Email Subject / Title / File Name / FILENAME. */
export function displaySubject(m: Meta): string | undefined {
  return firstNonEmpty(m, ['SUBJECT', 'Email Subject', 'Title', 'File Name', 'FILENAME']);
}

/** Display FROM: FROM / Email From. */
export function displayFrom(m: Meta): string | undefined {
  return firstNonEmpty(m, ['FROM', 'Email From']);
}

/** Display TO: TO / Email To. */
export function displayTo(m: Meta): string | undefined {
  return firstNonEmpty(m, ['TO', 'Email To']);
}
