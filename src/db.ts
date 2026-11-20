import { Pool, PoolClient } from 'pg';
import { config } from './config';

// Small pool — hosted Postgres caps at 25 connections.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 8,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
  // TCP keepalive stops the hosted load balancer / server dropping a connection
  // that is briefly idle between the short DB writes of a long synchronous render.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

// Primary root-cause fix: the managed server enforces idle_session_timeout=2min,
// which reaps a pooled connection left idle during a slow synchronous render
// (pdftoppm/convert block the event loop between short finalise writes). Disable
// it per-session; USERSET context so any role may set its own session. Best
// effort — a managed DB that refuses it just leaves the retry paths below to cope.
pool.on('connect', (client) => {
  client.query('SET idle_session_timeout = 0').catch(() => { /* best effort */ });
});

// Without this, an asynchronous error on an IDLE pooled client is an unhandled
// 'error' event and crashes the whole process.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[db] idle client error:', err?.message || err);
});

/** True for errors that mean the connection died and a retry on a fresh one is safe. */
export function isTransientConnError(e: any): boolean {
  const code = e?.code;
  if (code === 'ECONNRESET' || code === '57P01' || code === '57P02' || code === '57P03'
    || code === '08006' || code === '08003') return true;
  const msg = String(e?.message || e || '').toLowerCase();
  return msg.includes('terminating connection due to')
    || msg.includes('connection terminated')
    || msg.includes('server closed the connection')
    || msg.includes('connection ended');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number }> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await pool.query(text, params);
      return { rows: res.rows as T[], rowCount: res.rowCount || 0 };
    } catch (e) {
      lastErr = e;
      if (!isTransientConnError(e) || attempt === 2) throw e;
      await sleep(250 * (attempt + 1)); // 250ms, 500ms before fresh-connection retry
    }
  }
  throw lastErr;
}

export async function withTx<T>(fn: (q: (text: string, params?: any[]) => Promise<any>) => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    let client: PoolClient | null = null;
    let bad = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const result = await fn((text, params) => client!.query(text, params));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      lastErr = e;
      bad = isTransientConnError(e);
      if (client && !bad) {
        try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
        throw e;
      }
      // transient: fall through to retry on a fresh connection
    } finally {
      if (client) client.release(bad ? (lastErr as Error) : undefined);
    }
    if (attempt === 2) break;
    await sleep(250 * (attempt + 1));
  }
  throw lastErr;
}
