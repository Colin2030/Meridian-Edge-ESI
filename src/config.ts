import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4100', 10),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  enableOcr: (process.env.ENABLE_OCR || 'false').toLowerCase() === 'true',
  uploadsDir: path.resolve(process.cwd(), 'uploads'),
  webDist: path.resolve(process.cwd(), 'web', 'dist'),
};
if (!config.databaseUrl) {
  // eslint-disable-next-line no-console
  console.error('FATAL: DATABASE_URL is not set (check .env)');
}
