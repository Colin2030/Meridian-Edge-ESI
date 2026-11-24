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

/**
 * SQL expression extracting the lowercased file extension from a filename SQL
 * expression, stripping any extracted-row child suffix (name.csv_row_N -> name.csv).
 * The [^.] guard requires a non-dot character before the final dot so leading-dot
 * dotfiles (.gitignore) yield NULL rather than a spurious extension. `nameExpr`
 * must already be an SQL expression (commonly a NULLIF(... ,'') wrapper). Shared by
 * fileType.ts (fileTypeExtSql / fileTypeBucketSql) and displayTypeSql below.
 */
export function extFromNameSql(nameExpr: string): string {
  return `lower(substring(regexp_replace(${nameExpr}, '_row_[0-9]+$', '', 'i') from '[^.]\\.([A-Za-z0-9]+)$'))`;
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

// Display TYPE (friendly). Precedence: metadata DOCTYPE, then friendly FILETYPE
// label, then raw FILETYPE (these win for Concordance loadfile docs), THEN the
// EDRM-loadfile metadata clauses — extension from metadata 'File Name'/'FILENAME'
// and the friendly/raw metadata 'MIME Type' (the EDRM importer stores the real type
// in metadata and leaves native_mime/native_filename NULL, setting native_type to
// the render kind 'native'), THEN the real native file type for batch-ingested docs
// — extension from native_filename, friendly native_mime label, raw native_mime —
// and finally the viewer render kind (native_type) as a last-resort fallback, else
// 'Unknown'. The metadata 'File Name'/'MIME Type' clauses mirror the first clauses
// of fileTypeBucketSql in fileType.ts, so the list type column agrees with the ECA
// buckets for EDRM docs. Kept in sync with fileTypeBucketSql in fileType.ts and the
// frontend mirror in web/src/lib/displayFields.ts.
export function displayTypeSql(
  metaCol = 'metadata',
  nativeCol = 'native_type',
  nativeMimeCol = 'native_mime',
  nativeFilenameCol = 'native_filename',
): string {
  const mime = `NULLIF(${metaCol}->>'FILETYPE','')`;
  // EDRM importer key is literally 'MIME Type' (with a space), case-sensitive.
  const metaMime = `NULLIF(${metaCol}->>'MIME Type','')`;
  const metaName = `COALESCE(NULLIF(${metaCol}->>'File Name',''), NULLIF(${metaCol}->>'FILENAME',''))`;
  const nativeMime = `NULLIF(${nativeMimeCol},'')`;
  const nativeName = `NULLIF(${nativeFilenameCol},'')`;
  return `COALESCE(
    NULLIF(${metaCol}->>'DOCTYPE',''),
    ${friendlyMimeSql(mime)},
    ${mime},
    ${extFromNameSql(metaName)},
    ${friendlyMimeSql(metaMime)},
    ${metaMime},
    ${extFromNameSql(nativeName)},
    ${friendlyMimeSql(nativeMime)},
    ${nativeMime},
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
