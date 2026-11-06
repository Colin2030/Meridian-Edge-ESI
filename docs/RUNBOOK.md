# Meridian Edge — On-Premise Administrator Runbook

**Meridian Edge Ltd** · ESI review platform (view-only) · on-premise, air-gapped deployment
Package version: see the `VERSION` file at the root of this package.

This runbook is written for a system administrator installing Meridian Edge onto a
customer-owned **Debian/Ubuntu** server with **no internet access**. The package is
fully self-contained: the compiled server, the built web interface and all
production Node.js dependencies are bundled. You do **not** need a package registry.

> Meridian Edge is a **view-only** platform for reviewing *pre-processed* electronic
> stored information (ESI). It does not itself process, collect or transform source
> evidence — it ingests already-prepared loadfiles/page images and lets reviewers
> search, tag, bookmark, comment and export.

---

## 1. What is in this package

```
meridian-edge-onprem-<version>/
├── VERSION                     Package version and build timestamp
├── README.md                   Short overview (points here)
├── install.sh                  Idempotent installer (run as root)
├── uninstall.sh                Uninstaller (service/vhost; optional purge & drop-db)
├── migrate.sh                  Manual DB migration wrapper (upgrade path)
├── run-local.sh                No-root local/developer run (no systemd/nginx)
├── docs/
│   └── RUNBOOK.md              This document
└── app/                        The application payload copied to the install prefix
    ├── dist/                   Compiled Express server (JavaScript)
    ├── web/dist/               Built React single-page app (static assets)
    ├── migrations/             SQL migrations (001…008), idempotent
    ├── node_modules/           VENDORED production dependencies (air-gap ready)
    ├── scripts/
    │   ├── migrate-prod.js     Migration runner (plain JS, production deps only)
    │   └── bootstrap-admin.js  First system-administrator creator
    ├── deploy/
    │   ├── meridian-edge.service   systemd unit TEMPLATE
    │   └── nginx.conf.template     nginx vhost TEMPLATE
    ├── package.json            Production manifest (start/migrate/bootstrap-admin)
    ├── package-lock.json
    └── .env.example            Fully documented environment template
```

The embedded **Ed25519 licence public key** (`dist/lib/licensePublicKey.js`) is
included — it is required to verify uploaded `.melic` licences. The **private**
signing key is held only by Meridian Edge Ltd and is never part of any deployment.

### What's new in 1.2.0

- **The per-request upload file-count cap is configurable** via `MAX_UPLOAD_FILES`
  in `.env` (default `2000`), replacing the previous hard-coded limit of 2000. It
  is a file **count** (distinct from the `MAX_UPLOAD_BYTES` byte-size cap); raise
  it when a single Concordance/EDRM chunk legitimately contains more files.
  Exceeding it now returns a clean **HTTP 413** (with a `code` and the effective
  `limit`) instead of an opaque 500.
- **Chunked-import control-number overlap reporting** — re-importing a control
  number that already exists updates the document **in place** (no duplicate), and
  the overlap is surfaced in the import's error/notes field and the
  `import.completed` audit detail.
- Upload-limit wording in this runbook and `.env.example` corrected.

This release is packaging + limits + documentation changes only; the platform
remains **view-only** for pre-processed ESI.

### What's new in 1.1.0

- **Large / multi-GB dataset uploads** are supported. The cap is configurable via
  `MAX_UPLOAD_BYTES` in `.env` (default `0` = unlimited); the nginx template
  streams bodies through (`client_max_body_size 64g`, `proxy_request_buffering
  off`) with 3600s proxy/body timeouts.
- **EDRM XML import migration** `008_edrm_xml.sql` is included — this package
  ships migrations **001–008** (1.0.0 shipped 001–007).
- **A no-root local / developer run path** (`run-local.sh`) — see §1b.

This release is packaging + upload-limit changes only; the platform remains
**view-only** for pre-processed ESI.

---

## 1a. Two supported install modes

| | **A — Production install** | **B — Local / developer run** |
|---|---|---|
| Command | `sudo ./install.sh --server-name <fqdn>` | `./run-local.sh` |
| Privileges | **root** (sudo) | **none** (unprivileged user) |
| Sets up | service user, systemd unit, nginx vhost, `.env` + generated secret, migrations, starts service | local `app/.env`, migrations, runs server in the foreground |
| Listens on | `127.0.0.1:4100` behind nginx (port 80/443) | `127.0.0.1:4600` directly (no proxy) |
| Target OS | **systemd Linux** (Debian/Ubuntu) | **Linux or macOS** |
| Persistence | survives reboots (systemd) | runs until you Ctrl-C |
| Use for | customer-owned production servers | evaluation / local development |

The **application itself** is portable (plain Node.js + a reachable PostgreSQL),
so the local/dev path works on Linux or macOS. The **production `install.sh`**
specifically targets systemd Linux hosts (it creates a service user, a systemd
unit and an nginx vhost); do not run it on macOS.

---

## 1b. Local / developer install (no root required)

Use this on a workstation to evaluate or develop against Meridian Edge without
installing anything system-wide — no root, no systemd, no nginx, no service user.

**Prerequisites:** Node.js 18+ and a reachable PostgreSQL (14+). Nothing else.

```bash
tar -xzf meridian-edge-onprem-<version>.tar.gz
cd meridian-edge-onprem-<version>

# Optional: a throwaway local PostgreSQL via Docker (matches the default DATABASE_URL)
docker run -d --name meridian-pg \
  -e POSTGRES_USER=meridian -e POSTGRES_PASSWORD=meridian \
  -e POSTGRES_DB=meridian_edge -p 127.0.0.1:5432:5432 postgres:16

# Create the first admin and start the server (foreground):
ADMIN_PASSWORD='a-strong-password-min-12' ./run-local.sh
```

Then browse to `http://127.0.0.1:4600` and log in as `admin`.

What `run-local.sh` does (idempotent; safe to Ctrl-C and re-run):

1. Refuses to run as root; checks Node 18+.
2. Checks PostgreSQL is reachable via `DATABASE_URL`; if not, prints the Docker
   one-liner above and exits.
3. On first run, creates `app/.env` with `NODE_ENV=development`, `PORT=4600`
   (deliberately not 4100, so it never clashes with a production install), a
   generated `SESSION_SECRET` (`openssl rand -hex 48`), and `MAX_UPLOAD_BYTES=0`.
   An existing `app/.env` is never overwritten.
4. Runs the migrations with the plain-JS runner (`scripts/migrate-prod.js`).
5. If `ADMIN_PASSWORD` is set, bootstraps the first admin (skipped automatically
   if any user already exists).
6. Starts `node dist/index.js` in the foreground, bound to `127.0.0.1`.

Overrides (environment variables): `DATABASE_URL`, `PORT`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD`, `MAX_UPLOAD_BYTES`.

> This path is for local use only. For a real deployment use the production
> installer (§5), which adds the systemd unit, nginx reverse proxy and hardening.

---

## 2. Prerequisites (provided by the customer)

Install these from your own OS packages or offline APT mirror **before** running
`install.sh`. The installer checks for them and fails with a clear message if a
required one is missing.

| Component | Version | Required? | Notes |
|-----------|---------|-----------|-------|
| Debian / Ubuntu Linux | current LTS | yes | systemd-based host |
| Node.js runtime | **18+** | yes | `node -v`. The bundled deps are pure-JS and portable. |
| PostgreSQL server | **14+** | yes | A dedicated local database. |
| `postgresql-client` (`psql`) | 14+ | recommended | For DB creation and administration. |
| nginx | any current | yes* | Reverse proxy. *Skip with `--no-nginx` if you front the app another way. |
| `poppler-utils` (`pdftoppm`) | any | for imports | Renders imported PDF pages to images. Viewing existing data does not need it. |
| `unzip` | any | for imports | Expands zipped loadfile packages at import time. |
| `tesseract-ocr` | any | optional | Only if you enable OCR (`ENABLE_OCR=true`) to index image-only pages for search. |

Example (on a host with an offline APT mirror configured):

```bash
sudo apt-get install -y postgresql postgresql-client nginx poppler-utils unzip
# Optional, only if you will enable OCR:
sudo apt-get install -y tesseract-ocr
# Node.js 18+: install from your offline mirror or a NodeSource .deb you have staged.
```

---

## 3. Transfer and unpack the package

Copy the tarball onto the target host (USB / internal transfer), then:

```bash
tar -xzf meridian-edge-onprem-<version>.tar.gz
cd meridian-edge-onprem-<version>
```

---

## 4. Prepare the PostgreSQL database

Create a dedicated role and database. Choose a strong password.

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE meridian WITH LOGIN PASSWORD 'choose-a-strong-password';
CREATE DATABASE meridian_edge OWNER meridian;
SQL
```

The schema uses the `pgcrypto` extension; migration `001_init.sql` creates it with
`CREATE EXTENSION IF NOT EXISTS pgcrypto`. On most distributions this requires the
`postgresql-contrib` package and is created automatically by the owning role. If your
policy forbids role-level extension creation, have a superuser run once:

```bash
sudo -u postgres psql -d meridian_edge -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
```

Your connection string will be, for example:

```
postgresql://meridian:choose-a-strong-password@127.0.0.1:5432/meridian_edge
```

---

## 5. Install

Run the installer as root. At minimum give it your server's hostname so it can
write the nginx vhost:

```bash
sudo ./install.sh --server-name review.example.gov.uk
```

Useful options:

| Flag | Default | Purpose |
|------|---------|---------|
| `--prefix DIR` | `/opt/meridian-edge` | Install location |
| `--user NAME` | `meridian` | Dedicated service account (created if missing) |
| `--server-name NAME` | — | nginx `server_name` / FQDN |
| `--port N` | `4100` | App port (bound to `127.0.0.1` only) |
| `--no-nginx` | — | Skip nginx vhost (front the app yourself) |
| `--no-migrate` | — | Skip running migrations during install |

What `install.sh` does (idempotent — safe to re-run to upgrade):

1. Verifies Node 18+, systemd, nginx (unless `--no-nginx`) and openssl; warns if `psql` is absent.
2. Creates the dedicated **system service user** (no login shell).
3. Copies `app/` into the install prefix (refreshing code on an upgrade).
4. On first install only, creates `.env` from `.env.example` and generates a strong
   `SESSION_SECRET` with `openssl rand -hex 48`. An existing `.env` is never overwritten.
5. Creates the uploads/data directory and sets ownership to the service user; locks `.env` to `600`.
6. Renders and installs the **systemd unit** (symlinked into `/etc/systemd/system/`) and enables it.
7. Renders and installs the **nginx vhost** (symlinked into `/etc/nginx/conf.d/`), runs `nginx -t`, reloads.
8. Runs database **migrations** (only once `DATABASE_URL` is valid).
9. Starts the service (only once `DATABASE_URL` is valid).

If you run `install.sh` before editing `DATABASE_URL`, it installs everything but
skips migrations and the start, and tells you the exact follow-up commands.

---

## 6. Configure `.env`

Edit `/opt/meridian-edge/.env` and set at least `DATABASE_URL`:

```bash
sudo nano /opt/meridian-edge/.env
# set DATABASE_URL=postgresql://meridian:...@127.0.0.1:5432/meridian_edge
sudo chmod 600 /opt/meridian-edge/.env
```

Then apply migrations and start:

```bash
sudo -u meridian /opt/meridian-edge/migrate.sh
sudo systemctl restart meridian-edge
```

### Environment variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | no | `production` | Runtime mode. Keep `production` on a customer host. |
| `PORT` | no | `4100` | TCP port the server listens on (bound to `127.0.0.1`). Must match the nginx `proxy_pass` port. |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string `postgresql://USER:PASSWORD@HOST:PORT/DBNAME`. URL-encode special characters in the password. |
| `SESSION_SECRET` | **yes** | insecure dev value | Secret used to sign authentication (JWT) tokens. Generate with `openssl rand -hex 48`. `install.sh` sets this automatically. Changing it invalidates all existing sessions. |
| `UPLOADS_DIR` | no | `<prefix>/uploads` | Absolute path for rendered page images and staged imports. Point at a larger/separate volume if needed; the service user must own it. |
| `MAX_UPLOAD_BYTES` | no | `0` (unlimited) | Largest single file, in **bytes**, accepted on the HTTP import/upload path. `0` = no application-level size cap (bounded only by free disk and the nginx `client_max_body_size`). Set a positive value to enforce a hard byte cap. |
| `MAX_UPLOAD_FILES` | no | `2000` | Maximum **number** of files accepted in a single import request (a file count, not a byte size). Raise it when a single Concordance/EDRM chunk legitimately contains more files. Exceeding it returns HTTP 413 with a `code` and the effective `limit`. |
| `INGEST_ALLOWED_ROOTS` | no | `/home/ubuntu,/mnt,/media,/srv` | Comma-separated absolute directories the server-side “network/folder location” import may read from. Restrict to your mounted ESI shares (e.g. `/mnt/esi-shares,/srv/esi`). |
| `ENABLE_OCR` | no | `false` | When `true`, image-only pages are OCR'd at import for search. Requires `tesseract-ocr`. Does not alter source documents. |

> **Never** print or commit the completed `.env` — it contains the database password
> and the signing secret. It is created mode `600`, owned by the service user.

---

## 7. Create the first administrator

On a **clean** database (no users yet), create the first system administrator.
`bootstrap-admin.js` refuses to run if any user already exists, so it can never add
a hidden admin to a live system.

```bash
cd /opt/meridian-edge
sudo -u meridian ADMIN_USERNAME=admin ADMIN_PASSWORD='a-strong-password-min-12' \
     node scripts/bootstrap-admin.js
```

Omit `ADMIN_PASSWORD` to be prompted interactively (hidden input, with confirmation).

Supported variables: `ADMIN_USERNAME` (default `admin`), `ADMIN_PASSWORD` (required,
≥ 12 characters), `ADMIN_DISPLAY_NAME` (default `System Administrator`),
`ADMIN_EMAIL` (optional). The action is recorded in the audit log.

A system administrator bypasses licence enforcement, so they can log in immediately
on a fresh install (before any licence is uploaded) to complete setup.

---

## 8. Activate the licence

1. Log in at `https://<your-server-name>/` as the bootstrapped administrator.
2. Go to **Admin → Licence** and upload your signed `.melic` licence file.
3. The platform verifies it against the embedded public key and activates access for
   non-administrator users.

Obtain the `.melic` file from Meridian Edge Ltd. Only one licence is active at a time.

---

## 9. Upgrades

To deploy a newer package version:

1. Transfer and unpack the new tarball.
2. Re-run the installer with the same options:
   ```bash
   sudo ./install.sh --server-name review.example.gov.uk
   ```
   It refreshes the code, keeps your existing `.env`, runs any new migrations
   (all migrations are idempotent and tracked by `IF NOT EXISTS` guards — nothing is
   dropped) and restarts the service.

You can also run migrations on their own at any time:

```bash
sudo -u meridian /opt/meridian-edge/migrate.sh
```

---

## 10. Backup and restore

- **Database** (the authoritative store):
  ```bash
  sudo -u postgres pg_dump -Fc meridian_edge > meridian_edge_$(date +%F).dump
  # restore:
  sudo -u postgres pg_restore -d meridian_edge --clean meridian_edge_YYYY-MM-DD.dump
  ```
- **Uploads/data directory** (`/opt/meridian-edge/uploads` or your `UPLOADS_DIR`):
  back it up with `tar`/`rsync` alongside the database dump.
- Keep a copy of `.env` in your secrets store; it holds `SESSION_SECRET` and the DB
  credentials.

---

## 11. Uninstall

```bash
sudo ./uninstall.sh                     # stop + disable service, remove unit & vhost
sudo ./uninstall.sh --purge             # ALSO delete app dir and uploads/data
sudo ./uninstall.sh --purge --drop-db   # ALSO drop the database (typed confirmation)
sudo ./uninstall.sh --remove-user       # also remove the service account
```

By default the database and application data are **preserved**. Dropping the database
requires the `--drop-db` flag *and* typing the database name to confirm. Take a
`pg_dump` first.

---

## 12. Service operation & troubleshooting

```bash
systemctl status meridian-edge          # service state
journalctl -u meridian-edge -f          # live logs
systemctl restart meridian-edge         # restart after .env changes
curl -fsS http://127.0.0.1:4100/api/health   # should return {"status":"ok",...}
```

Common issues:

| Symptom | Likely cause / fix |
|---------|--------------------|
| Service keeps restarting | `DATABASE_URL` wrong/unreachable, or `SESSION_SECRET` missing. Check `journalctl -u meridian-edge`. |
| `FATAL: DATABASE_URL is not set` | `.env` missing the value, or the service user cannot read `.env`. |
| `users table does not exist` on bootstrap | Migrations have not run — `sudo -u meridian /opt/meridian-edge/migrate.sh`. |
| 502 from nginx | App not listening — check the service; confirm nginx `proxy_pass` port matches `PORT`. |
| Imports fail to render pages | Install `poppler-utils` (and `unzip` for zipped loadfiles). |
| Login works for admin but other users are blocked | Upload a valid `.melic` licence under Admin → Licence. |

The server binds `127.0.0.1` only; all external access must go through nginx.

---

## 13. Security notes

- Terminate TLS at nginx for any real deployment — see the commented 443 block in
  `deploy/nginx.conf.template`. Redirect HTTP → HTTPS.
- `.env` is mode `600` and owned by the service user; keep it that way.
- The systemd unit applies hardening (`NoNewPrivileges`, `PrivateTmp`,
  `ProtectSystem=full`, `ProtectKernelTunables`, etc.).
- The service runs as an unprivileged, no-login system user.
- Restrict `INGEST_ALLOWED_ROOTS` to only the directories that hold ESI loadfiles.
