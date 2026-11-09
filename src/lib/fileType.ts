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
