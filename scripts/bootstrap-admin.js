#!/usr/bin/env node
/*
 * Meridian Edge — first system administrator bootstrap.
 *
 * Creates the INITIAL system_admin account on a clean installation. This is the
 * documented way to obtain the first login on a brand-new database; from there
 * all further users are managed in-app by that administrator.
 *
 * Design:
 *   - Plain CommonJS using only PRODUCTION dependencies (pg, bcryptjs, dotenv),
 *     so it runs on an air-gapped host with `npm ci --omit=dev` node_modules.
 *   - Idempotent & SAFE: refuses to run if ANY user already exists, so it can
 *     never be used to silently add a back-door admin to a populated system.
 *   - Reads configuration from environment variables; if ADMIN_PASSWORD is not
 *     set it prompts interactively (hidden input) when run on a terminal.
 *
 * Environment variables:
 *   ADMIN_USERNAME       (default: "admin")
 *   ADMIN_PASSWORD       required (>= 12 chars) — via env or interactive prompt
 *   ADMIN_DISPLAY_NAME   (default: "System Administrator")
 *   ADMIN_EMAIL          (optional)
 *   DATABASE_URL         required (read from .env)
 *
 * Usage:
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD='<strong>' node scripts/bootstrap-admin.js
 *   # or interactively:
 *   node scripts/bootstrap-admin.js
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const readline = require('readline');

const MIN_PASSWORD_LEN = 12;

function fail(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

// Prompt for a value on the terminal. When `hidden` is true the typed characters
// are not echoed (used for the password).
function prompt(questionText, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      const stdout = process.stdout;
      // Mute echo by intercepting the output stream writes while the question is active.
      const onData = () => {};
      rl._writeToOutput = function (stringToWrite) {
        if (stringToWrite.includes(questionText)) stdout.write(stringToWrite);
        // otherwise swallow (hide typed chars)
      };
      rl.question(questionText, (answer) => {
        rl.history = [];
        rl.close();
        stdout.write('\n');
        process.stdin.removeListener('data', onData);
        resolve(answer);
      });
    } else {
      rl.question(questionText, (answer) => { rl.close(); resolve(answer.trim()); });
    }
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL is not set (check your .env). Run migrations first.');

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const displayName = (process.env.ADMIN_DISPLAY_NAME || 'System Administrator').trim();
  const email = (process.env.ADMIN_EMAIL || '').trim() || null;
  let password = process.env.ADMIN_PASSWORD || '';

  if (!username) fail('ADMIN_USERNAME must not be empty.');

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Confirm the schema exists (migrations must have run first).
    const reg = await client.query("SELECT to_regclass('public.users') AS t");
    if (!reg.rows[0] || !reg.rows[0].t) {
      fail('The "users" table does not exist. Run database migrations first (./migrate.sh or npm run migrate).');
    }

    // SAFETY: never create an admin on a system that already has users.
    const { rows } = await client.query('SELECT count(*)::int AS n FROM users');
    if (rows[0].n > 0) {
      console.log(
        'A user account already exists (' + rows[0].n + ' user(s) in the database).\n' +
        'bootstrap-admin only runs on a clean install and will NOT modify an existing\n' +
        'system. Manage further accounts from the in-app Admin area, or reset the\n' +
        'database if this is intentional.'
      );
      process.exit(0);
    }

    // Obtain the password (env or interactive prompt).
    if (!password) {
      if (!process.stdin.isTTY) {
        fail('ADMIN_PASSWORD is not set and no interactive terminal is available. ' +
             'Set ADMIN_PASSWORD in the environment and re-run.');
      }
      password = await prompt('Choose a password for "' + username + '": ', true);
      const confirm = await prompt('Confirm password: ', true);
      if (password !== confirm) fail('Passwords did not match.');
    }
    if (!password || password.length < MIN_PASSWORD_LEN) {
      fail('ADMIN_PASSWORD must be at least ' + MIN_PASSWORD_LEN + ' characters.');
    }

    const hash = bcrypt.hashSync(password, 10);

    // can_create_cases exists from migration 005; system admins bypass it anyway,
    // but set TRUE for completeness. active TRUE so the account can log in.
    await client.query(
      `INSERT INTO users (username, email, display_name, password_hash, is_system_admin, active, can_create_cases)
       VALUES ($1,$2,$3,$4,TRUE,TRUE,TRUE)`,
      [username, email, displayName, hash]
    );

    // Record the bootstrap in the audit trail (user_id references the new row).
    const newId = (await client.query('SELECT id FROM users WHERE username=$1', [username])).rows[0].id;
    await client.query(
      `INSERT INTO audit_log (user_id, action, target, detail)
       VALUES ($1,'admin.bootstrap',$2,'Initial system administrator created via bootstrap-admin')`,
      [newId, 'user:' + newId]
    );

    console.log('\n==================================================');
    console.log(' First system administrator created successfully.');
    console.log('   username : ' + username);
    console.log('   name     : ' + displayName);
    if (email) console.log('   email    : ' + email);
    console.log('   role     : system administrator');
    console.log('--------------------------------------------------');
    console.log(' Log in at your server URL and upload the .melic');
    console.log(' licence under Admin > Licence to activate the');
    console.log(' platform for non-admin users.');
    console.log('==================================================\n');
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
