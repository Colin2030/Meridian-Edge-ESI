import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';
import { query } from '../db';

// ============================================================================
// Content-addressed blob storage (VIEW-ONLY).
// ----------------------------------------------------------------------------
// Files (natives, audit-report attachments, and — in later phases — batch item
// files) are stored ONCE on disk under a path derived from their SHA-256, so
// identical content is never stored twice. The original file name is NEVER used
// as the storage name (it is kept as metadata on the referencing row) — this
// removes file-name collisions, deduplicates identical natives, and lets any
// stored file be verified later by re-hashing it.
//
// On-disk layout (under config.blobsDir):
//   <blobsDir>/<aa>/<bb>/<sha256>
// where aa = first two hex chars of the SHA-256 and bb = next two, so a single
// directory never holds an unbounded number of files.
//
// The `blobs` table (migration 011) is the index: one row per distinct hash with
// its byte size, MIME type and a reference count. put() upserts the row and
// increments ref_count; identical content re-put only bumps the count and never
// rewrites the file.
//
// This module adds NO processing/forensic capability — it only stores and serves
// bytes supplied to it, and verifies integrity.
// ============================================================================

/** Absolute root of the on-disk blob store (config.blobsDir, default <uploads>/blobs). */
export function blobsRoot(): string {
  return config.blobsDir;
}

/** Content-addressed on-disk path for a hash: <blobsDir>/aa/bb/<sha256>. */
export function blobPath(sha256: string): string {
  const h = sha256.toLowerCase();
  return path.join(config.blobsDir, h.slice(0, 2), h.slice(2, 4), h);
}

export interface PutResult {
  sha256: string;
  size: number;
  /** TRUE when identical content was already stored (only the ref-count was bumped). */
  deduplicated: boolean;
}

/** Hex SHA-256 of a buffer. */
export function sha256OfBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Hex SHA-256 of a file on disk (streamed, so arbitrarily large files are fine). */
export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

class IntegrityError extends Error {
  code = 'hash_mismatch';
  constructor(public expected: string, public actual: string) {
    super(`Integrity check failed: expected SHA-256 ${expected} but content hashed to ${actual}`);
    this.name = 'IntegrityError';
  }
}
export { IntegrityError };

/**
 * Upsert the blobs index row for a stored hash and bump its reference count.
 * Called inside put()/putFile() once the bytes are on disk.
 */
async function recordBlob(sha256: string, size: number, mimeType?: string): Promise<void> {
  await query(
    `INSERT INTO blobs (sha256, byte_size, mime_type, ref_count)
       VALUES ($1,$2,$3,1)
     ON CONFLICT (sha256) DO UPDATE
       SET ref_count = blobs.ref_count + 1,
           mime_type = COALESCE(blobs.mime_type, EXCLUDED.mime_type)`,
    [sha256.toLowerCase(), size, mimeType || null]
  );
}

/**
 * Store a buffer in the blob store, deduplicated by content hash.
 * When `expectedSha256` is supplied and the content hashes to a different value,
 * the write is REJECTED (IntegrityError) and nothing is stored (verify at the door).
 */
export async function put(
  buf: Buffer,
  opts: { mimeType?: string; expectedSha256?: string } = {}
): Promise<PutResult> {
  const sha256 = sha256OfBuffer(buf);
  if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256) {
    throw new IntegrityError(opts.expectedSha256.toLowerCase(), sha256);
  }
  const dest = blobPath(sha256);
  let deduplicated = true;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Write atomically: temp file + rename, so a crash never leaves a partial blob.
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    deduplicated = false;
  }
  await recordBlob(sha256, buf.length, opts.mimeType);
  return { sha256, size: buf.length, deduplicated };
}

/**
 * Store an existing file in the blob store, deduplicated by content hash. The
 * source file is COPIED (left in place); the original file name is not used as the
 * storage name. Streams the hash so large natives do not load wholly into memory.
 */
export async function putFile(
  srcPath: string,
  opts: { mimeType?: string; expectedSha256?: string } = {}
): Promise<PutResult> {
  const sha256 = await sha256OfFile(srcPath);
  if (opts.expectedSha256 && opts.expectedSha256.toLowerCase() !== sha256) {
    throw new IntegrityError(opts.expectedSha256.toLowerCase(), sha256);
  }
  const size = fs.statSync(srcPath).size;
  const dest = blobPath(sha256);
  let deduplicated = true;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    fs.copyFileSync(srcPath, tmp);
    fs.renameSync(tmp, dest);
    deduplicated = false;
  }
  await recordBlob(sha256, size, opts.mimeType);
  return { sha256, size, deduplicated };
}

/** Does the blob store hold this hash (both on disk and indexed)? */
export async function has(sha256: string): Promise<boolean> {
  if (!sha256) return false;
  if (!fs.existsSync(blobPath(sha256))) return false;
  const { rows } = await query<{ one: number }>(`SELECT 1 AS one FROM blobs WHERE sha256=$1`, [sha256.toLowerCase()]);
  return rows.length > 0;
}

/** Read a stored blob into a buffer, or null when it is not present on disk. */
export function get(sha256: string): Buffer | null {
  const p = blobPath(sha256);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

/** On-disk path for a stored blob (for streaming downloads), or null when absent. */
export function getPath(sha256: string): string | null {
  const p = blobPath(sha256);
  return fs.existsSync(p) ? p : null;
}
