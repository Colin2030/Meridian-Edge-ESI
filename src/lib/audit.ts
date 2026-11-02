import { query } from '../db';

export async function audit(opts: {
  userId?: number | null;
  caseId?: number | null;
  action: string;
  target?: string | null;
  detail?: string | null;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (user_id, case_id, action, target, detail) VALUES ($1,$2,$3,$4,$5)`,
      [opts.userId ?? null, opts.caseId ?? null, opts.action, opts.target ?? null, opts.detail ?? null]
    );
  } catch (e) {
    // Never let audit failure break a request, but log it.
    // eslint-disable-next-line no-console
    console.error('audit error', e);
  }
}
