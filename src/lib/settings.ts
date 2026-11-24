// Tiny key/value application-settings accessor backed by the app_settings table
// (migration 019). Used for cosmetic deployment branding (the login-page logo).
// This is a display/branding helper only — it does not touch ESI data, ingestion
// or the view-only security model.
import { query } from '../db';

export interface LoginLogoSetting {
  storedPath: string;        // relative to config.uploadsDir, e.g. branding/login-logo-<ts>.png
  originalFilename: string;  // the uploader's original file name (for admin display)
  mime: string;              // image/png | image/jpeg | image/svg+xml
  uploadedBy: number | null;
  uploadedAt: string;        // ISO timestamp
}

export const LOGIN_LOGO_KEY = 'login_logo';

/** Read a settings value by key, or null if unset. */
export async function getSetting<T = any>(key: string): Promise<T | null> {
  const { rows } = await query<{ value: T }>(`SELECT value FROM app_settings WHERE key=$1`, [key]);
  if (!rows.length) return null;
  const v = rows[0].value as any;
  // An empty object means "cleared" — treat as unset.
  if (v && typeof v === 'object' && Object.keys(v).length === 0) return null;
  return v ?? null;
}

/** Upsert a settings value. */
export async function setSetting(key: string, value: any, userId: number | null): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, JSON.stringify(value), userId]
  );
}

/** Clear a settings value (delete the row). */
export async function clearSetting(key: string): Promise<void> {
  await query(`DELETE FROM app_settings WHERE key=$1`, [key]);
}

/** Convenience: the current login-logo setting, or null when the default applies. */
export function getLoginLogo(): Promise<LoginLogoSetting | null> {
  return getSetting<LoginLogoSetting>(LOGIN_LOGO_KEY);
}
