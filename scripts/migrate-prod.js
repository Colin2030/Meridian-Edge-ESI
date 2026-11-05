#!/usr/bin/env node
/*
 * Meridian Edge — production database migration runner.
 *
 * Applies every migrations/NNN_*.sql file in ascending order. Each file is
 * idempotent (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS), so
 * running this repeatedly is safe — it is BOTH the clean-install and the upgrade
 * path. Nothing is dropped.
 *
 * Plain CommonJS using only the production `pg` + `dotenv` dependencies, so it
 * runs on an air-gapped host from `npm ci --omit=dev` node_modules WITHOUT
 * ts-node (which is a dev-only dependency and is not shipped).
 */
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { Client } = require('pg');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('FATAL: DATABASE_URL is not set (check your .env).');
    process.exit(1);
  }

  // migrations/ sits next to this script's parent (the install prefix root).
  const dir = path.resolve(__dirname, '..', 'migrations');
  if (!fs.existsSync(dir)) {
    console.error('FATAL: migrations directory not found at ' + dir);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.error('FATAL: no .sql migration files found in ' + dir);
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      process.stdout.write('Applying ' + f + ' ... ');
      await client.query(sql);
      console.log('ok');
    }
    console.log('Migrations complete (' + files.length + ' file(s) applied).');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
