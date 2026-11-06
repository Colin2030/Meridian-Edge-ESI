import express from 'express';
import 'express-async-errors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import authRoutes from './routes/auth';
import caseRoutes from './routes/cases';
import docRoutes from './routes/documents';
import adminRoutes from './routes/admin';
import fileRoutes from './routes/files';
import importRoutes from './routes/imports';
import binderRoutes from './routes/binders';
import tokenRoutes from './routes/tokens';
import v1Routes from './routes/v1';
import licenceRoutes from './routes/licenses';
import { refreshLicenceCache } from './lib/license';

const app = express();
app.set('trust proxy', true);

// Security headers — allow same-origin framing under the Abacus preview, keep CSP tight & self-hosted only.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        frameAncestors: ["'self'", 'https://*.abacus.ai'],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: false,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Rebuild public host behind proxy (VM forwards X-Original-Host)
app.use((req, _res, next) => {
  const orig = req.headers['x-original-host'];
  if (orig && typeof orig === 'string') req.headers.host = orig;
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'meridian-edge' }));
app.use('/api/auth', authRoutes);
app.use('/api/cases', importRoutes);
app.use('/api/cases', binderRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api', docRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/v1', v1Routes);
app.use('/api/admin', licenceRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', fileRoutes);

// Serve built frontend (air-gap: all assets local)
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist, { index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.send('Meridian Edge API running. Frontend not built yet (run npm run build:web).'));
}

// error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(config.port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`Meridian Edge listening on http://127.0.0.1:${config.port} (env=${config.env})`);
  // Warm the licence cache at startup so the first request is not slowed and the
  // enforcement gate has state immediately.
  refreshLicenceCache().catch((e) => console.error('licence cache warm failed', e));
});
// Large ESI deliveries (multi-GB) can take a long time to stream in. Disable
// Node's per-request timeout so a slow/large upload is not aborted by the app
// itself, and keep headersTimeout >= keepAliveTimeout (a Node requirement).
// The real time limits then come from the reverse proxy / any CDN in front.
server.requestTimeout = 0; // 0 = no per-request timeout (default is 300s)
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
