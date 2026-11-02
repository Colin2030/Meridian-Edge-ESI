// Shared helpers for GREP / regex ("Pattern") document search and keyword-list
// batch search. All matching runs against documents.extracted_text using
// PostgreSQL POSIX regular expressions (operators ~ and ~*). These helpers keep
// the full-text (tsvector) search path untouched.

import { pool } from '../db';

export interface PatternOptions {
  literal: boolean;        // true = escape regex metacharacters (default, safe for non-technical users)
  caseSensitive: boolean;  // true = operator ~ , false = operator ~* (default)
  wholeWord: boolean;      // true = wrap pattern in POSIX word boundaries \y...\y
}

export const DEFAULT_PATTERN_OPTIONS: PatternOptions = {
  literal: true,
  caseSensitive: false,
  wholeWord: false,
};

/** Parse the option flags off a query string / multipart body (all optional, string "true"/"false"). */
export function parsePatternOptions(src: Record<string, any>): PatternOptions {
  const flag = (v: any, def: boolean) => (v === undefined || v === null || v === '') ? def : (v === true || v === 'true' || v === '1');
  return {
    literal: flag(src.literal, DEFAULT_PATTERN_OPTIONS.literal),
    caseSensitive: flag(src.caseSensitive ?? src.case_sensitive, DEFAULT_PATTERN_OPTIONS.caseSensitive),
    wholeWord: flag(src.wholeWord ?? src.whole_word, DEFAULT_PATTERN_OPTIONS.wholeWord),
  };
}

/** Escape POSIX ERE/ARE metacharacters so a plain string is matched literally. */
export function escapePosixRegex(s: string): string {
  return s.replace(/[.^$*+?()\[\]{}|\\]/g, '\\$&');
}

/**
 * Build the POSIX regex pattern string for a single search term, honouring the
 * literal and whole-word options. Case sensitivity is applied via the chosen
 * operator (~ vs ~*), not the pattern, so the same pattern string works for both.
 */
export function buildPattern(term: string, opts: PatternOptions): string {
  let p = opts.literal ? escapePosixRegex(term) : term;
  if (opts.wholeWord) p = `\\y(?:${p})\\y`;
  return p;
}

/** The PostgreSQL regex operator for the given case-sensitivity. Fixed strings (never user input). */
export function regexOperator(caseSensitive: boolean): '~' | '~*' {
  return caseSensitive ? '~' : '~*';
}

/** Postgres error codes we translate into friendly client messages. */
export const PG_INVALID_REGEX = '2201B'; // invalid_regular_expression
export const PG_QUERY_CANCELED = '57014'; // statement_timeout fired

export class PatternError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Run a query on a dedicated client with a per-query statement_timeout (ms).
 * Translates invalid-regex and timeout Postgres errors into PatternError with a
 * friendly message and the right HTTP status, so callers never leak a 500.
 */
export async function queryWithTimeout<T = any>(
  sql: string,
  params: any[],
  timeoutMs: number,
): Promise<{ rows: T[]; rowCount: number }> {
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    // SET LOCAL only persists within a transaction block.
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
    const res = await client.query(sql, params);
    await client.query('COMMIT');
    return { rows: res.rows as T[], rowCount: res.rowCount || 0 };
  } catch (e: any) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    if (e && e.code === PG_INVALID_REGEX) {
      throw new PatternError(400, `Invalid pattern: ${(e.message || 'not a valid regular expression').replace(/^invalid regular expression:?\s*/i, '')}`);
    }
    if (e && e.code === PG_QUERY_CANCELED) {
      throw new PatternError(400, 'The pattern was too complex and timed out. Please narrow it (add more specific text, or disable "Regular expression").');
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Validate a single pattern cheaply; returns an error message if invalid, else null. */
export async function validatePattern(pattern: string): Promise<string | null> {
  try {
    await pool.query(`SELECT ''::text ~ $1`, [pattern]);
    return null;
  } catch (e: any) {
    if (e && e.code === PG_INVALID_REGEX) {
      return (e.message || 'not a valid regular expression').replace(/^invalid regular expression:?\s*/i, '');
    }
    throw e;
  }
}

// ---- JS-side snippet extraction (best-effort highlight) ----------------------

/** Build a JS RegExp approximating the POSIX pattern, for snippet highlighting only. */
export function buildJsRegex(term: string, opts: PatternOptions): RegExp | null {
  try {
    let body = opts.literal ? term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : term;
    if (opts.wholeWord) body = `\\b(?:${body})\\b`;
    const flags = 'g' + (opts.caseSensitive ? '' : 'i') + 's';
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

export interface Snippet { before: string; match: string; after: string; }

/**
 * Compute a context snippet around the first match of `re` in `text`.
 * Returns { before, match, after } (plain strings; the frontend wraps `match`
 * in a highlight). Returns null if nothing is found (caller may fall back to a
 * leading excerpt). Safe on multibyte text (operates on JS strings).
 */
export function makeSnippet(text: string | null | undefined, re: RegExp | null, ctx = 120): Snippet | null {
  if (!text || !re) return null;
  re.lastIndex = 0;
  const m = re.exec(text);
  if (!m || m[0].length === 0) return null;
  const start = m.index;
  const end = start + m[0].length;
  const from = Math.max(0, start - ctx);
  const to = Math.min(text.length, end + ctx);
  const clean = (s: string) => s.replace(/\s+/g, ' ');
  return {
    before: (from > 0 ? '… ' : '') + clean(text.slice(from, start)),
    match: text.slice(start, end),
    after: clean(text.slice(end, to)) + (to < text.length ? ' …' : ''),
  };
}

/** A plain leading excerpt (used when no highlightable match is found). */
export function leadingExcerpt(text: string | null | undefined, len = 200): Snippet | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return { before: clean.slice(0, len) + (clean.length > len ? ' …' : ''), match: '', after: '' };
}
