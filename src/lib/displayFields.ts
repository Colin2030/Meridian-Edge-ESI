// Robust, reusable loadfile field-name mapping (SQL side).
//
// Different Concordance/EDRM loadfiles name the same logical field differently
// (e.g. one corpus uses metadata->>'File Name' + 'DOCTYPE' + 'DATE', another uses
// metadata->>'SUBJECT' + 'FILETYPE' + 'DATESENT'). These helpers derive the
// display Name / Type / Date / Subject consistently from whichever variant is
// present, treating empty strings as absent (NULLIF), so BOTH the backend SQL
// (documents.ts, cases.ts, fileType.ts) and the frontend (web/src/lib/
// displayFields.ts, which mirrors this exact precedence) show real values for
// every schema. Keep the two files in sync when editing either.
//
// metaCol / nativeCol are SQL references to the documents columns (e.g.
// 'metadata' / 'native_type', or 'd.metadata' / 'd.native_type' when aliased).

/**
 * SQL expression mapping a FILETYPE/MIME value to a friendly, human label
 * (e.g. message/rfc822 -> 'Email', application/pdf -> 'PDF'). Returns NULL for
 * an unmapped/absent value so callers can COALESCE down to the raw MIME value,
 * native_type, etc. `mimeExpr` must already be an SQL expression (commonly a
 * NULLIF(... ,'') wrapper).
 */
export function friendlyMimeSql(mimeExpr: string): string {
  const e = `lower(${mimeExpr})`;
  return `CASE
    WHEN ${e} = 'message/rfc822' THEN 'Email'
    WHEN ${e} IN ('application/vnd.ms-outlook','application/vnd.ms-tnef','application/mbox') THEN 'Email'
    WHEN ${e} = 'application/pdf' THEN 'PDF'
    WHEN ${e} IN ('application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document') THEN 'Word'
    WHEN ${e} IN ('application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') THEN 'Excel'
    WHEN ${e} IN ('application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation') THEN 'PowerPoint'
    WHEN ${e} = 'text/calendar' THEN 'Calendar'
    WHEN ${e} = 'text/html' THEN 'HTML'
    WHEN ${e} = 'application/rtf' THEN 'Rich Text'
    WHEN ${e} = 'application/pkcs7-signature' THEN 'Signature'
    WHEN ${e} IN ('application/zip','application/gzip','application/x-7z-compressed','application/x-rar-compressed') THEN 'Archive'
    WHEN ${e} LIKE 'text/%' THEN 'Text'
    WHEN ${e} LIKE 'image/%' THEN 'Image'
    WHEN ${e} LIKE 'application/vnd.ms-%' THEN 'Office'
    WHEN ${e} LIKE 'application/vnd.openxmlformats-%' THEN 'Office'
    ELSE NULL END`;
}

/** Display NAME: first non-empty filename/subject/title variant, else control number. */
export function displayNameSql(metaCol = 'metadata', controlCol = 'control_number'): string {
  return `COALESCE(
    NULLIF(${metaCol}->>'File Name',''),
    NULLIF(${metaCol}->>'FILENAME',''),
    NULLIF(${metaCol}->>'SUBJECT',''),
    NULLIF(${metaCol}->>'Email Subject',''),
    NULLIF(${metaCol}->>'Title',''),
    ${controlCol})`;
}

/** Display TYPE (friendly): DOCTYPE, then friendly FILETYPE label, then raw FILETYPE, then native_type, else 'Unknown'. */
export function displayTypeSql(metaCol = 'metadata', nativeCol = 'native_type'): string {
  const mime = `NULLIF(${metaCol}->>'FILETYPE','')`;
  return `COALESCE(
    NULLIF(${metaCol}->>'DOCTYPE',''),
    ${friendlyMimeSql(mime)},
    ${mime},
    NULLIF(${nativeCol},''),
    'Unknown')`;
}

/** Display DATE: first non-empty of DATE / Date Sent / DATESENT / DateSent. */
export function displayDateSql(metaCol = 'metadata'): string {
  return `COALESCE(
    NULLIF(${metaCol}->>'DATE',''),
    NULLIF(${metaCol}->>'Date Sent',''),
    NULLIF(${metaCol}->>'DATESENT',''),
    NULLIF(${metaCol}->>'DateSent',''))`;
}

/** Display SUBJECT (threads etc.): SUBJECT / Email Subject / Title / File Name / FILENAME. */
export function displaySubjectSql(metaCol = 'metadata'): string {
  return `COALESCE(
    NULLIF(${metaCol}->>'SUBJECT',''),
    NULLIF(${metaCol}->>'Email Subject',''),
    NULLIF(${metaCol}->>'Title',''),
    NULLIF(${metaCol}->>'File Name',''),
    NULLIF(${metaCol}->>'FILENAME',''))`;
}
