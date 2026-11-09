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

/** Display NAME: filename/subject/title variant, else control number. */
export function displayName(m: Meta, controlNumber: string): string {
  return firstNonEmpty(m, ['File Name', 'FILENAME', 'SUBJECT', 'Email Subject', 'Title']) || controlNumber;
}

/** Whether a distinct filename is present (so the UI can show the control number as a sub-label). */
export function hasFileName(m: Meta): boolean {
  return !!firstNonEmpty(m, ['File Name', 'FILENAME']);
}

/** Display TYPE (friendly): DOCTYPE, friendly FILETYPE label, raw FILETYPE, native_type, else 'Unknown'. */
export function displayType(m: Meta, nativeType?: string | null): string {
  const mime = firstNonEmpty(m, ['FILETYPE']);
  return (
    firstNonEmpty(m, ['DOCTYPE']) ||
    friendlyMime(mime) ||
    mime ||
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
