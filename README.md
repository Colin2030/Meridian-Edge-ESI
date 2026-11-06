# Meridian Edge ESI — On-Premise Distribution

**Meridian Edge Ltd** — a **view-only** ESI review platform for digital forensics, eDiscovery and regulatory investigations. Search, review, bookmark, comment on and organise *pre-processed* ESI (TIFFs/PDFs with Concordance `.DAT`/`.OPT` loadfiles and EDRM XML) on your own infrastructure, including secure or air-gapped networks.

This repository is the distribution point for the self-contained on-premise install package and its installation materials.

---

## ⬇️ Download

Get the latest self-contained package from the [**Releases**](https://github.com/Colin2030/Meridian-Edge-ESI/releases/latest) page:

**`meridian-edge-onprem-<version>.tar.gz`**

It bundles the compiled server, the built web interface and all production Node.js dependencies — **no internet or package registry is required on the target host**. The install scripts and the full runbook in this repository are also included inside the package.

> **Licensing.** Meridian Edge is commercial, licensed software. It requires a valid, Meridian-signed licence file (`.melic`) issued by Meridian Edge Ltd for normal use — without one, standard users cannot access cases. A bootstrapped *system administrator* can log in to install the licence and manage the platform. To obtain a licence, contact Meridian Edge Ltd (colin@meridianedge.co.uk)

---

## Two ways to run

| Mode | Command | What it sets up | Use when |
|------|---------|-----------------|----------|
| **A — Production** | `sudo ./install.sh --server-name <fqdn>` | Service user, systemd unit, nginx vhost, `.env` + generated secret, migrations. Targets **systemd Linux** (Debian/Ubuntu). | Deploying on a customer-owned server. |
| **B — Local / developer** | `./run-local.sh` | A local `.env` and the app in the foreground on `127.0.0.1`. **No root, no systemd, no nginx.** Works on **Linux or macOS**. | Trying it out / developing locally. |

### Prerequisites

- **Production:** Debian/Ubuntu, Node.js 18+, PostgreSQL 14+, nginx (plus `poppler-utils` and `unzip` for document import; `tesseract-ocr` only if OCR is enabled).
- **Local / developer:** Node.js 18+ and a reachable PostgreSQL 14+. `run-local.sh` prints a one-line Docker command if you want a throwaway Postgres for development.

## Quick start (production)

```bash
tar -xzf meridian-edge-onprem-<version>.tar.gz
cd meridian-edge-onprem-<version>

# Create the database (full SQL in docs/RUNBOOK.md)
sudo -u postgres psql -c "CREATE ROLE meridian LOGIN PASSWORD 'strong-pw';"
sudo -u postgres psql -c "CREATE DATABASE meridian_edge OWNER meridian;"

# Install (service user, systemd unit, nginx vhost; runs migrations)
sudo ./install.sh --server-name review.example.gov.uk

# Set DATABASE_URL in /opt/meridian-edge/.env, then migrate + start
sudo -u meridian /opt/meridian-edge/migrate.sh
sudo systemctl restart meridian-edge

# Create the first administrator (clean DB only)
cd /opt/meridian-edge
sudo -u meridian ADMIN_USERNAME=admin ADMIN_PASSWORD='choose-a-strong-password' \
     node scripts/bootstrap-admin.js
```

## Quick start (local / developer)

```bash
tar -xzf meridian-edge-onprem-<version>.tar.gz
cd meridian-edge-onprem-<version>

export DATABASE_URL='postgres://user:pass@localhost:5432/meridian_edge'
./run-local.sh          # generates .env, runs migrations, starts on 127.0.0.1:4600
```

## In this repository

| Path | Purpose |
|------|---------|
| `install.sh` | Production installer (systemd + nginx). Flags: `--server-name`, `--no-nginx`. |
| `run-local.sh` | No-root local/developer run path. |
| `migrate.sh` | Apply database migrations. |
| `uninstall.sh` | Remove a production install. |
| `docs/RUNBOOK.md` | Full administrator runbook (database setup, licensing, backups, upgrades, troubleshooting). |
| `docs/THIRD-PARTY-NOTICES.md` | Open-source component attributions bundled with the build. |
| `CHANGELOG.md` | Release history. |
| `VERSION` | Current package version and build timestamp. |

---

© Meridian Edge Ltd. Commercial software, licensed by Meridian Edge Ltd. See licensing note above.
