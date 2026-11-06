#!/usr/bin/env bash
#
# Meridian Edge — local / developer run (NO root required)
# =========================================================
#
# This is the lightweight way to run Meridian Edge on a developer workstation
# (Linux or macOS). It does NOT install anything system-wide: no systemd unit,
# no nginx vhost, no service user, nothing under /etc or /opt. It simply:
#
#   1. checks you have Node 18+ and a reachable PostgreSQL;
#   2. creates a local app/.env (once) with a generated SESSION_SECRET;
#   3. runs the database migrations (plain-JS runner, production deps only);
#   4. optionally bootstraps the first admin (if ADMIN_PASSWORD is set);
#   5. starts the server in the foreground on http://127.0.0.1:<PORT>.
#
# It is idempotent and safe to Ctrl-C — re-running it just reuses the existing
# .env and re-applies (already-applied) migrations as no-ops.
#
# For a real production install (systemd + nginx on a Debian/Ubuntu host) use
# `sudo ./install.sh` instead — see README.md / docs/RUNBOOK.md.
#
# Environment overrides (all optional):
#   DATABASE_URL     PostgreSQL connection string. Default:
#                    postgresql://meridian:meridian@127.0.0.1:5432/meridian_edge
#   PORT             Port to listen on (127.0.0.1 only). Default: 4600
#                    (deliberately NOT 4100, to avoid clashing with a prod install).
#   ADMIN_USERNAME   First-admin username when bootstrapping (default: admin)
#   ADMIN_PASSWORD   If set, bootstrap the first admin (>=12 chars). If a user
#                    already exists, bootstrap is skipped automatically.
#   MAX_UPLOAD_BYTES Upload cap in bytes (default 0 = unlimited).
#
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SELF_DIR/app"

c_blue='\033[1;34m'; c_yellow='\033[1;33m'; c_red='\033[1;31m'; c_reset='\033[0m'
log()  { echo -e "${c_blue}[run-local]${c_reset} $*"; }
warn() { echo -e "${c_yellow}[warn]${c_reset} $*" >&2; }
die()  { echo -e "${c_red}[error]${c_reset} $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Sanity: never run as root (this path is deliberately unprivileged)
# ---------------------------------------------------------------------------
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  die "run-local.sh is for unprivileged local/dev use — do NOT run it as root. For a production install use: sudo ./install.sh"
fi

[[ -d "$APP_DIR" ]]              || die "application payload not found at $APP_DIR"
[[ -f "$APP_DIR/dist/index.js" ]] || die "compiled server not found ($APP_DIR/dist/index.js). Is this an unpacked release package?"

# ---------------------------------------------------------------------------
# 1. Check Node 18+
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node.js 18+ and try again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  die "Node.js 18+ required (found $(node -v)). Please upgrade."
fi
log "Node $(node -v) detected."

# ---------------------------------------------------------------------------
# 2. Resolve configuration defaults
# ---------------------------------------------------------------------------
PORT="${PORT:-4600}"
DATABASE_URL="${DATABASE_URL:-postgresql://meridian:meridian@127.0.0.1:5432/meridian_edge}"
MAX_UPLOAD_BYTES="${MAX_UPLOAD_BYTES:-0}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

# ---------------------------------------------------------------------------
# 3. Check PostgreSQL reachability (best-effort, non-fatal guidance)
# ---------------------------------------------------------------------------
db_reachable() {
  node -e '
    const { Client } = require("'"$APP_DIR"'/node_modules/pg");
    const c = new Client({ connectionString: process.argv[1], connectionTimeoutMillis: 4000 });
    c.connect().then(() => c.query("select 1")).then(() => { c.end(); process.exit(0); })
      .catch(() => process.exit(1));
  ' "$DATABASE_URL" >/dev/null 2>&1
}

log "Checking PostgreSQL at: ${DATABASE_URL%%\?*}"
if ! db_reachable; then
  warn "Could not connect to PostgreSQL using DATABASE_URL."
  cat >&2 <<EOF

  Meridian Edge needs a reachable PostgreSQL database. Options:

  (a) Use an existing PostgreSQL and point DATABASE_URL at it, e.g.:
        DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/meridian_edge' ./run-local.sh

  (b) Start a throwaway local PostgreSQL with Docker (no root if your user is in
      the 'docker' group), matching the default DATABASE_URL above:
        docker run -d --name meridian-pg \\
          -e POSTGRES_USER=meridian -e POSTGRES_PASSWORD=meridian \\
          -e POSTGRES_DB=meridian_edge \\
          -p 127.0.0.1:5432:5432 postgres:16
      (stop/remove later with:  docker rm -f meridian-pg )

  Then re-run ./run-local.sh
EOF
  die "PostgreSQL not reachable — see the guidance above."
fi
log "PostgreSQL is reachable."

# ---------------------------------------------------------------------------
# 4. Create local app/.env on first run (never overwrite an existing one)
# ---------------------------------------------------------------------------
ENV_FILE="$APP_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  log "Reusing existing $ENV_FILE (not overwritten)."
else
  [[ -f "$APP_DIR/.env.example" ]] || die ".env.example not found at $APP_DIR/.env.example"
  if command -v openssl >/dev/null 2>&1; then
    SESSION_SECRET="$(openssl rand -hex 48)"
  else
    SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  fi
  log "Creating $ENV_FILE for local development ..."
  cat > "$ENV_FILE" <<EOF
# Local / developer environment — generated by run-local.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# This file is for LOCAL DEV ONLY. Do not use it on a production host.
NODE_ENV=development
PORT=$PORT
DATABASE_URL=$DATABASE_URL
SESSION_SECRET=$SESSION_SECRET
# Uploads are stored here; keep it inside the unpacked package for dev.
UPLOADS_DIR=$APP_DIR/uploads
# 0 = unlimited upload size (large multi-GB datasets allowed).
MAX_UPLOAD_BYTES=$MAX_UPLOAD_BYTES
# Restrict server-side "network/folder location" imports during dev.
INGEST_ALLOWED_ROOTS=/tmp,/mnt,/media,/srv
ENABLE_OCR=false
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

mkdir -p "$APP_DIR/uploads"

# ---------------------------------------------------------------------------
# 5. Run database migrations (plain-JS runner — no ts-node, no dev deps)
# ---------------------------------------------------------------------------
cd "$APP_DIR"
log "Applying database migrations (001..00N) ..."
node scripts/migrate-prod.js

# ---------------------------------------------------------------------------
# 6. Optionally bootstrap the first administrator
# ---------------------------------------------------------------------------
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  log "Bootstrapping first admin '$ADMIN_USERNAME' (skipped automatically if a user already exists) ..."
  ADMIN_USERNAME="$ADMIN_USERNAME" ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    node scripts/bootstrap-admin.js || warn "Bootstrap skipped or failed (a user may already exist)."
else
  log "No ADMIN_PASSWORD set — skipping admin bootstrap. To create the first admin:"
  log "  ADMIN_PASSWORD='a-strong-password-min-12' ./run-local.sh"
fi

# ---------------------------------------------------------------------------
# 7. Start the server in the foreground (Ctrl-C to stop)
# ---------------------------------------------------------------------------
log "Starting Meridian Edge on http://127.0.0.1:$PORT  (NODE_ENV=development)"
log "Press Ctrl-C to stop. Nothing was installed system-wide."
exec node dist/index.js
