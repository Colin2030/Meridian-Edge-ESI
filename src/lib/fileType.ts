// Shared SQL for deriving a document's file-type extension from its original
// filename (metadata "File Name"). Used by BOTH the ECA file-type breakdown
// (cases.ts /eca) and the document-list file-type filter (documents.ts) so the
// counts shown in the filter UI always match exactly what the filter returns.
//
// Behaviour: strip any extracted-row child suffix (name.csv_row_N -> name.csv),
// then take the final extension lowercased. The [^.] guard requires a non-dot
// character before the final dot, so leading-dot dotfiles (e.g. .gitignore)
// yield NULL rather than a spurious extension. NULL maps to 'Unknown' via the
// COALESCE in fileTypeBucketSql.
//
// metaCol is the SQL reference to the metadata jsonb column (e.g. 'metadata' or
// 'd.metadata' when the query aliases the documents table).

export function fileTypeExtSql(metaCol = 'metadata'): string {
  return `lower(substring(regexp_replace(${metaCol}->>'File Name', '_row_[0-9]+$', '', 'i') from '[^.]\\.([A-Za-z0-9]+)$'))`;
}

export function fileTypeBucketSql(metaCol = 'metadata'): string {
  return `COALESCE(${fileTypeExtSql(metaCol)}, 'Unknown')`;
}
