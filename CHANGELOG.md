# Changelog — Meridian Edge on-premise package

All notable changes to the on-premise deployment package are documented here.
Meridian Edge is a **view-only** ESI review platform; these releases change
packaging, limits and tooling only — they add no ESI processing/forensic
capability.

## 1.1.0

### Added
- **Large / multi-GB dataset uploads.** Upload size is configurable via
  `MAX_UPLOAD_BYTES` in `.env` (default `0` = unlimited). The bundled nginx
  template now streams request bodies straight through
  (`client_max_body_size 64g`, `proxy_request_buffering off`) with long
  (`3600s`) `proxy_read_timeout` / `proxy_send_timeout` / `client_body_timeout`
  for slow large transfers — applied in both the HTTP and the commented TLS
  server blocks.
- **EDRM XML import migration** `008_edrm_xml.sql`. This package now ships
  migrations **001–008**.
- **New local / developer run path** `run-local.sh` — runs the platform on a
  Linux or macOS workstation with **no root, no systemd and no nginx**. It checks
  Node 18+ and PostgreSQL reachability, creates a local `app/.env` (generated
  `SESSION_SECRET`, `NODE_ENV=development`, `PORT=4600`, `MAX_UPLOAD_BYTES=0`),
  runs migrations, optionally bootstraps the first admin, and starts the server
  in the foreground bound to `127.0.0.1`.
- Documentation for the **two supported install modes** (production
  `install.sh` vs local `run-local.sh`) in `README.md` and `docs/RUNBOOK.md`.

### Notes
- Rebuilt from current source (compiled `dist/`, built `web/dist/`, re-vendored
  production `node_modules/` via `npm ci --omit=dev`, pure-JS, air-gap ready).
- The package continues to embed **only** the Ed25519 licence **public** key
  (`dist/lib/licensePublicKey.js`); the private signing key is never distributed.

## 1.0.0

- Initial self-contained, air-gapped on-premise package: compiled server, built
  SPA, vendored production dependencies, migrations 001–007, `install.sh` /
  `uninstall.sh` / `migrate.sh`, systemd + nginx templates, and the
  administrator runbook.
