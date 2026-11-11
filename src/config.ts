import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4100', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  enableOcr: (process.env.ENABLE_OCR || 'false').toLowerCase() === 'true',
  // Maximum size (in bytes) of a single uploaded file on the HTTP import path.
  // Forensic ESI deliveries are routinely multi-GB, so this defaults to 0 =
  // NO application-level size cap (available disk space on UPLOADS_DIR / the
  // imports staging dir becomes the real limit). Set MAX_UPLOAD_BYTES to a
  // positive number of bytes to enforce a hard cap (e.g. 53687091200 = 50 GB).
  maxUploadBytes: Math.max(0, parseInt(process.env.MAX_UPLOAD_BYTES || '0', 10) || 0),
  // Maximum NUMBER of files accepted in a single multipart import request. This is
  // the ONLY application-level per-request cap enforced by Meridian Edge (the
  // "512 MB" figure some demo environments show is an nginx edge limit, not an
  // application limit — see MAX_UPLOAD_BYTES above, default 0 = no app byte cap).
  // Defaults to 2000; raise via MAX_UPLOAD_FILES when importing a large single
  // Concordance/EDRM chunk whose file count exceeds the default.
  maxUploadFiles: Math.max(1, parseInt(process.env.MAX_UPLOAD_FILES || '2000', 10) || 2000),
  // Directory where rendered page images and staged imports are stored.
  // Defaults to <cwd>/uploads; override with UPLOADS_DIR (absolute path) to keep
  // document data on a separate volume in a production deployment.
  uploadsDir: process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.resolve(process.cwd(), 'uploads'),
  // Content-addressed blob store root (natives, audit-report attachments, batch
  // files). Defaults to <uploadsDir>/blobs; override with BLOBS_DIR (absolute).
  blobsDir: process.env.BLOBS_DIR
    ? path.resolve(process.env.BLOBS_DIR)
    : path.resolve(process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.resolve(process.cwd(), 'uploads'), 'blobs'),
  webDist: path.resolve(process.cwd(), 'web', 'dist'),
  // Server-side ingest from a network/folder location (mounted SMB/NFS share or
  // BLOB storage mounted as a path). Only paths *within* one of these absolute
  // roots may be read, to prevent arbitrary filesystem reads. Override in
  // production via INGEST_ALLOWED_ROOTS (comma-separated absolute paths), e.g.
  //   INGEST_ALLOWED_ROOTS=/mnt/esi-shares,/srv/esi
  // Defaults cover the usual mount points for dev and typical deployments.
  ingestAllowedRoots: (process.env.INGEST_ALLOWED_ROOTS || '/home/ubuntu,/mnt,/media,/srv')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p)),
};
if (!config.databaseUrl) {
  // eslint-disable-next-line no-console
  console.error('FATAL: DATABASE_URL is not set (check .env)');
}
