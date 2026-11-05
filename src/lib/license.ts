// Meridian Edge — commercial licence verification, parsing and server state.
//
// OFFLINE licensing model (no phone-home, air-gapped friendly):
//  - A licence is a signed JSON payload describing the customer, seat count and
//    validity window.
//  - It is signed OFFLINE by "Meridian Edge HQ — Licence Manager" with the
//    Ed25519 PRIVATE key, and verified HERE with the embedded PUBLIC key.
//  - The platform never contacts a licence server.
//
// ---------------------------------------------------------------------------
// LICENCE FILE FORMAT (.melic)  — part B must produce EXACTLY this
// ---------------------------------------------------------------------------
// A licence file is a readable ASCII-armoured block:
//
//   -----BEGIN MERIDIAN EDGE LICENCE-----
//   <base64 of JSON.stringify(envelope)>
//   -----END MERIDIAN EDGE LICENCE-----
//
// where `envelope` is:
//   {
//     "payload":   <LicencePayload>,
//     "signature": "<base64 Ed25519 signature>",
//     "alg":       "ed25519",
//     "v":         1
//   }
//
// and LicencePayload is:
//   {
//     "licenceId": "<uuid>",
//     "product":   "Meridian Edge",
//     "customer":  "<name>",
//     "seats":     <int>,            // max number of ACTIVE users
//     "issuedAt":  "<ISO 8601>",
//     "validFrom": "<ISO 8601>",
//     "expiresAt": "<ISO 8601>",
//     "notes":     "<optional string>"
//   }
//
// The SIGNATURE is an Ed25519 signature over the CANONICAL JSON encoding of the
// payload: JSON.stringify with keys sorted recursively and no insignificant
// whitespace (see canonicalise() below), encoded as UTF-8 bytes. Both the
// signer (HQ) and the verifier (platform) MUST use the identical canonical form.

import crypto from 'crypto';
import { query } from '../db';
import { LICENSE_PUBLIC_KEY_PEM } from './licensePublicKey';

export const LICENCE_PRODUCT = 'Meridian Edge';
export const LICENCE_BEGIN = '-----BEGIN MERIDIAN EDGE LICENCE-----';
export const LICENCE_END = '-----END MERIDIAN EDGE LICENCE-----';

export interface LicencePayload {
  licenceId: string;
  product: string;
  customer: string;
  seats: number;
  issuedAt: string;
  validFrom: string;
  expiresAt: string;
  notes?: string;
}

export interface LicenceEnvelope {
  payload: LicencePayload;
  signature: string; // base64
  alg: string;       // 'ed25519'
  v: number;         // 1
}

export interface LicenceStatus {
  installed: boolean;
  valid: boolean;
  expired: boolean;
  customer: string | null;
  seats: number | null;
  seatsUsed: number;
  seatsRemaining: number | null;
  issuedAt: string | null;
  validFrom: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  licenceId: string | null;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Canonical JSON — stable, sorted-key, whitespace-free encoding.
// ---------------------------------------------------------------------------
export function canonicalise(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalise).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalise(value[k])).join(',') + '}';
}

// ---------------------------------------------------------------------------
// parseLicence — unwrap the armoured block (or raw base64 / raw JSON) into an
// envelope object. Throws on anything it cannot decode into the expected shape.
// ---------------------------------------------------------------------------
export function parseLicence(fileText: string): LicenceEnvelope {
  if (!fileText || !fileText.trim()) throw new Error('Licence file is empty.');
  let b64 = fileText.trim();

  if (b64.includes(LICENCE_BEGIN)) {
    const start = b64.indexOf(LICENCE_BEGIN) + LICENCE_BEGIN.length;
    const end = b64.indexOf(LICENCE_END);
    if (end < 0) throw new Error('Licence block is missing its END marker.');
    b64 = b64.slice(start, end);
  }
  // Strip all whitespace/newlines from inside the block.
  b64 = b64.replace(/\s+/g, '');

  let jsonText: string;
  // Allow either base64-wrapped JSON or a bare JSON envelope.
  if (b64.startsWith('{')) {
    jsonText = fileText.trim();
  } else {
    try {
      jsonText = Buffer.from(b64, 'base64').toString('utf8');
    } catch {
      throw new Error('Licence content is not valid base64.');
    }
  }

  let env: any;
  try {
    env = JSON.parse(jsonText);
  } catch {
    throw new Error('Licence content is not valid JSON.');
  }
  if (!env || typeof env !== 'object' || !env.payload || !env.signature) {
    throw new Error('Licence is missing its payload or signature.');
  }
  return env as LicenceEnvelope;
}

// ---------------------------------------------------------------------------
// verifyLicence — signature + structural + date-sanity checks (NOT expiry).
// Returns { valid, reason }. A valid-but-expired licence returns valid:true
// here; expiry is evaluated separately (isExpired / getLicenceStatus) so that
// an expired-but-authentic licence can still be stored and clearly reported.
// ---------------------------------------------------------------------------
export function verifyLicence(parsed: LicenceEnvelope): { valid: boolean; reason?: string } {
  try {
    if (!parsed || typeof parsed !== 'object') return { valid: false, reason: 'Malformed licence.' };
    if (parsed.alg !== 'ed25519') return { valid: false, reason: `Unsupported signature algorithm "${parsed.alg}".` };
    if (parsed.v !== 1) return { valid: false, reason: `Unsupported licence version "${parsed.v}".` };

    const p = parsed.payload;
    if (!p || typeof p !== 'object') return { valid: false, reason: 'Licence payload is missing.' };
    if (p.product !== LICENCE_PRODUCT) return { valid: false, reason: `Licence is not for ${LICENCE_PRODUCT} (product: "${p.product}").` };
    if (!p.licenceId) return { valid: false, reason: 'Licence is missing its licence id.' };
    if (!p.customer) return { valid: false, reason: 'Licence is missing the customer name.' };
    if (!Number.isInteger(p.seats) || p.seats < 0) return { valid: false, reason: 'Licence seat count is invalid.' };

    const issued = Date.parse(p.issuedAt);
    const from = Date.parse(p.validFrom);
    const until = Date.parse(p.expiresAt);
    if (Number.isNaN(issued) || Number.isNaN(from) || Number.isNaN(until)) {
      return { valid: false, reason: 'Licence contains an invalid date.' };
    }
    if (until < from) return { valid: false, reason: 'Licence expiry is before its valid-from date.' };

    // Signature check over canonical payload.
    const sig = Buffer.from(parsed.signature, 'base64');
    const data = Buffer.from(canonicalise(p), 'utf8');
    const ok = crypto.verify(null, data, LICENSE_PUBLIC_KEY_PEM, sig);
    if (!ok) return { valid: false, reason: 'Licence signature is invalid (not signed by Meridian Edge, or the licence has been altered).' };

    return { valid: true };
  } catch (e: any) {
    return { valid: false, reason: `Could not verify licence: ${e?.message || 'unknown error'}` };
  }
}

export function isExpired(p: LicencePayload, now: Date = new Date()): boolean {
  const until = Date.parse(p.expiresAt);
  if (Number.isNaN(until)) return true;
  return now.getTime() > until;
}

export function isNotYetValid(p: LicencePayload, now: Date = new Date()): boolean {
  const from = Date.parse(p.validFrom);
  if (Number.isNaN(from)) return false;
  return now.getTime() < from;
}

// ---------------------------------------------------------------------------
// Server licence state (in-memory cache of the active licence).
// Active licence = most recently installed row with active=true. Cached in
// memory and refreshed on upload via refreshLicenceCache().
// ---------------------------------------------------------------------------
let cachedEnvelope: LicenceEnvelope | null = null;
let cacheLoaded = false;

async function loadActiveFromDb(): Promise<LicenceEnvelope | null> {
  const { rows } = await query<{ raw_licence: string }>(
    `SELECT raw_licence FROM licences WHERE active=TRUE ORDER BY installed_at DESC, id DESC LIMIT 1`
  );
  if (!rows.length) return null;
  try {
    return parseLicence(rows[0].raw_licence);
  } catch {
    return null;
  }
}

export async function refreshLicenceCache(): Promise<void> {
  try {
    cachedEnvelope = await loadActiveFromDb();
  } catch {
    cachedEnvelope = null;
  }
  cacheLoaded = true;
}

export async function getActiveLicence(): Promise<LicenceEnvelope | null> {
  if (!cacheLoaded) await refreshLicenceCache();
  return cachedEnvelope;
}

async function countActiveUsers(): Promise<number> {
  const { rows } = await query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE active=TRUE`);
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// getLicenceStatus — the canonical status object used by the admin UI, the
// enforcement helpers and /api/auth/me.
// ---------------------------------------------------------------------------
export async function getLicenceStatus(now: Date = new Date()): Promise<LicenceStatus> {
  const env = await getActiveLicence();
  const seatsUsed = await countActiveUsers();

  if (!env) {
    return {
      installed: false, valid: false, expired: false,
      customer: null, seats: null, seatsUsed, seatsRemaining: null,
      issuedAt: null, validFrom: null, expiresAt: null, daysRemaining: null,
      licenceId: null, reason: 'No licence installed.',
    };
  }

  const check = verifyLicence(env);
  const p = env.payload;
  const expired = isExpired(p, now);
  const notYet = isNotYetValid(p, now);
  const until = Date.parse(p.expiresAt);
  const daysRemaining = Number.isNaN(until) ? null : Math.ceil((until - now.getTime()) / (24 * 3600 * 1000));

  let reason: string | undefined;
  let valid = check.valid;
  if (!check.valid) reason = check.reason;
  else if (expired) { valid = false; reason = 'Licence has expired.'; }
  else if (notYet) { valid = false; reason = 'Licence is not yet valid.'; }

  return {
    installed: true,
    valid,
    expired,
    customer: p.customer,
    seats: p.seats,
    seatsUsed,
    seatsRemaining: Math.max(0, p.seats - seatsUsed),
    issuedAt: p.issuedAt,
    validFrom: p.validFrom,
    expiresAt: p.expiresAt,
    daysRemaining,
    licenceId: p.licenceId,
    reason,
  };
}

// ---------------------------------------------------------------------------
// assertLicenceAllowsAccess — the shared gate used by requireAuth,
// requireApiToken and POST /login. System admins ALWAYS pass (so they can log
// in and upload a renewal). Everyone else needs an installed, authentic,
// in-window licence.
// ---------------------------------------------------------------------------
export async function assertLicenceAllowsAccess(
  user: { isSystemAdmin: boolean },
  now: Date = new Date()
): Promise<{ allowed: boolean; reason?: string }> {
  if (user.isSystemAdmin) return { allowed: true };
  const status = await getLicenceStatus(now);
  if (status.valid) return { allowed: true };
  return { allowed: false, reason: status.reason || 'No valid licence.' };
}

// ---------------------------------------------------------------------------
// seatsAvailableForActivation — used by the seat-cap guard. Returns how many
// MORE users may become active. If no valid licence, returns 0 (block adds),
// but existing active users are untouched. If the (authentic) licence is only
// expired, we still allow the seat count it specifies — expiry is enforced at
// login, not on seat maths — but a missing/invalid licence yields 0.
// ---------------------------------------------------------------------------
export async function getSeatInfo(): Promise<{ seats: number | null; seatsUsed: number; seatsRemaining: number; licensed: boolean }> {
  const env = await getActiveLicence();
  const seatsUsed = await countActiveUsers();
  if (!env) return { seats: null, seatsUsed, seatsRemaining: 0, licensed: false };
  const check = verifyLicence(env);
  if (!check.valid) return { seats: null, seatsUsed, seatsRemaining: 0, licensed: false };
  const seats = env.payload.seats;
  return { seats, seatsUsed, seatsRemaining: Math.max(0, seats - seatsUsed), licensed: true };
}
