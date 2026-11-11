#!/usr/bin/env node
/*
 * purge-expired.js — permanently remove soft-deleted records past retention.
 *
 * Phase 3 of the v1.4.0 "Remontoire delivery" epic (request 10). Soft-deleted
 * cases, imports and documents live for a retention window (7 days). This script
 * permanently removes everything whose retention_until has passed, decrements the
 * blob ref-counts of purged documents' native files, and deletes any blob file
 * that reaches ref_count 0. Case-level audit entries (request 8) are KEPT.
 *
 * It is IDEMPOTENT and SCHEDULER-SAFE: running it when nothing is due is a no-op,
 * and running it repeatedly causes no harm. It is deliberately NOT wired to any
 * scheduler — an operator runs it (e.g. from cron / a timer) in Phase 5. Example:
 *
 *   # dev
 *   set -a; . .env.dev; set +a; node scripts/purge-expired.js
 *   # production (on the air-gapped server)
 *   set -a; . /path/to/.env; set +a; node scripts/purge-expired.js
 *
 * Build the server first (npm run build) so dist/ exists.
 */
'use strict';

try { require('dotenv').config(); } catch (_) { /* dotenv optional; env may be pre-sourced */ }

async function main() {
  let retention;
  try {
    retention = require('../dist/lib/retention');
  } catch (e) {
    console.error('Could not load dist/lib/retention.js — run `npm run build` first.');
    console.error(e.message);
    process.exit(1);
  }
  const started = Date.now();
  const result = await retention.purgeExpired(new Date());
  const ms = Date.now() - started;
  console.log('[purge-expired] completed in %dms:', ms, JSON.stringify(result));
  // Close the pg pool so the process exits cleanly.
  try { require('../dist/db').pool.end(); } catch (_) { /* ignore */ }
}

main().catch((e) => {
  console.error('[purge-expired] failed:', e);
  process.exit(1);
});
