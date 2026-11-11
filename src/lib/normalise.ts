import fs from 'fs';
import path from 'path';

// ============================================================================
// Normalisation helpers for load-file import (VIEW-ONLY).
// ----------------------------------------------------------------------------
// "Be strict and specific about text": accept UTF-8 with or without a byte-order
// mark, normalise line endings, and store dates as ISO 8601 in UTC while KEEPING
// the original supplied value beside the normalised one. These add no processing
// capability — they only clean already-extracted text and already-supplied values
// so they load reliably.
// ============================================================================

/**
 * Decode a buffer as UTF-8, tolerating an optional byte-order mark, and normalise
 * line endings (CRLF and lone CR -> LF). UTF-16 LE/BE BOMs are also honoured so a
 * text file saved as UTF-16 (common from Windows tools) does not load as mojibake.
 */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    // UTF-16 LE BOM
    return normaliseNewlines(buf.subarray(2).toString('utf16le'));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE BOM — swap byte order then decode as LE.
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return normaliseNewlines(swapped.toString('utf16le'));
  }
  // UTF-8, with or without a BOM.
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return normaliseNewlines(text);
}

/** Normalise line endings: CRLF and lone CR both become LF. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Resolve a TEXTPATH/NATIVEPATH/TRANSLATEDTEXTPATH reference against the package
 * root. Handles Windows path separators, absolute paths, paths relative to the
 * root, and — as a robust fallback — a basename match against a prebuilt index of
 * files under the root (so a nested TEXT\ layout still resolves). Returns the
 * absolute path of the first candidate that exists, or null.
 */
export function resolveRefPath(
  sourceRoot: string | undefined,
  ref: string,
  basenameIndex?: Map<string, string>
): string | null {
  if (!ref) return null;
  const cleaned = ref.trim().replace(/^[\\/]+/, '');
  const candidates: string[] = [];
  if (path.isAbsolute(ref) ) candidates.push(ref);
  if (sourceRoot) {
    candidates.push(path.join(sourceRoot, cleaned));
    candidates.push(path.join(sourceRoot, cleaned.replace(/\\/g, '/')));
    candidates.push(path.join(sourceRoot, path.basename(cleaned.replace(/\\/g, '/'))));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  // Fallback: basename index (handles arbitrary nesting / separator mismatch).
  if (basenameIndex) {
    const base = path.basename(cleaned.replace(/\\/g, '/')).toLowerCase();
    const hit = basenameIndex.get(base);
    if (hit) return hit;
  }
  return null;
}

/** Build a basename(lowercase) -> absolute-path index of files under a root (first wins). */
export function buildBasenameIndex(files: string[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    if (!idx.has(base)) idx.set(base, f);
  }
  return idx;
}

export interface NormalisedDate {
  /** ISO-8601 in UTC, e.g. 2015-10-30T20:50:11.000Z — null when unparseable. */
  iso: string | null;
  /** The original supplied value, kept verbatim beside the normalised one. */
  original: string;
}

/**
 * Normalise a supplied date value to ISO-8601 UTC while keeping the original. Does
 * NOT guess ambiguous formats aggressively — it accepts what Date can parse
 * (ISO-8601, RFC 2822, and common load-file forms). Unparseable values keep
 * iso=null so the original is preserved and the gap is visible rather than wrong.
 */
export function isoDateUtc(value: string): NormalisedDate {
  const original = (value || '').trim();
  if (!original) return { iso: null, original };
  const t = Date.parse(original);
  if (Number.isNaN(t)) return { iso: null, original };
  return { iso: new Date(t).toISOString(), original };
}
