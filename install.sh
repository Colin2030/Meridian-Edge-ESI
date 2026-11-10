#!/usr/bin/env bash
#
# Meridian Edge — on-premise installer (run with sudo/root on the target host).
#
# Idempotent: safe to re-run to upgrade an existing install. It never drops the
# database and never overwrites an existing .env. See docs/RUNBOOK.md for the
# full runbook (prerequisites, DB creation, first-admin bootstrap, licence).
#
set -euo pipefail

# Ensure sbin dirs are on PATH. Minimal Debian installs (and sudo's secure_path)
# often omit these, which makes useradd, nginx and systemctl appear 'not found'
# even though they are installed. Prepend them so the installer is robust.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# ----------------------------------------------------------------------------
# Defaults (override with flags or environment variables)
# ----------------------------------------------------------------------------
PREFIX="${PREFIX:-/opt/meridian-edge}"
SERVICE_USER="${SERVICE_USER:-meridian}"
SERVER_NAME="${SERVER_NAME:-}"
PORT="${PORT:-4100}"
DO_NGINX=1
DO_MIGRATE=1
MIN_NODE_MAJOR=18

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$SELF_DIR/app"

usage() {
  cat <<EOF
Meridian Edge installer

Usage: sudo ./install.sh [options]

Options:
  --prefix DIR        Install directory            (default: $PREFIX)
  --user NAME         Dedicated service user        (default: $SERVICE_USER)
  --server-name NAME  nginx server_name / FQDN      (e.g. review.example.gov.uk)
  --port N            App port (127.0.0.1:N)         (default: $PORT)
  --no-nginx          Do not install the nginx vhost
  --no-migrate        Do not run DB migrations during install
  -h, --help          Show this help

Environment overrides: PREFIX, SERVICE_USER, SERVER_NAME, PORT, NODE_BIN.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --user) SERVICE_USER="$2"; shift 2;;
    --server-name) SERVER_NAME="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --no-nginx) DO_NGINX=0; shift;;
    --no-migrate) DO_MIGRATE=0; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

log()  { echo -e "\033[1;34m[install]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

# ----------------------------------------------------------------------------
# 0. Preconditions
# ----------------------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "install.sh must be run as root (use sudo)."
[[ -d "$APP_SRC" ]] || die "app payload not found at $APP_SRC — run this from the unpacked package."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be numeric (got '$PORT')."

# ----------------------------------------------------------------------------
# 1. Prerequisite checks (clear, actionable errors)
# ----------------------------------------------------------------------------
log "Checking prerequisites ..."

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || die "Node.js not found. Install Node.js ${MIN_NODE_MAJOR}+ (e.g. from your OS packages / offline mirror)."
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[[ "$NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ]] || die "Node.js ${MIN_NODE_MAJOR}+ required, found $("$NODE_BIN" -v). Upgrade Node.js."
log "  node: $("$NODE_BIN" -v) at $NODE_BIN"

command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this installer targets systemd hosts."

if ! command -v psql >/dev/null 2>&1; then
  warn "psql client not found. PostgreSQL 14+ must still be reachable via DATABASE_URL;"
  warn "installing the 'postgresql-client' package is recommended for administration."
fi

if [[ $DO_NGINX -eq 1 ]]; then
  command -v nginx >/dev/null 2>&1 || die "nginx not found. Install nginx, or re-run with --no-nginx to skip the vhost."
  log "  nginx: $(nginx -v 2>&1 | sed 's#nginx version: ##')"
fi

command -v openssl >/dev/null 2>&1 || die "openssl not found — needed to generate the session secret."

# ----------------------------------------------------------------------------
# 2. Dedicated service user
# ----------------------------------------------------------------------------
if id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Service user '$SERVICE_USER' already exists."
else
  log "Creating system service user '$SERVICE_USER' ..."
  useradd --system --home-dir "$PREFIX" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

# ----------------------------------------------------------------------------
# 3. Copy the application payload into the install prefix
# ----------------------------------------------------------------------------
log "Installing application to $PREFIX ..."
mkdir -p "$PREFIX"
# Copy payload WITHOUT clobbering an existing .env (there is none in the package,
# but be explicit). Everything else (dist, web, node_modules, migrations,
# scripts, package.json, deploy, .env.example) is refreshed = upgrade path.
cp -a "$APP_SRC"/. "$PREFIX"/
# Ship the manual migrate wrapper alongside the app for operators.
if [[ -f "$SELF_DIR/migrate.sh" ]]; then
  cp -a "$SELF_DIR/migrate.sh" "$PREFIX/migrate.sh"
  chmod +x "$PREFIX/migrate.sh"
fi
# Copy docs for on-host reference.
if [[ -d "$SELF_DIR/docs" ]]; then
  mkdir -p "$PREFIX/docs"
  cp -a "$SELF_DIR/docs"/. "$PREFIX/docs"/
fi

# ----------------------------------------------------------------------------
# 4. .env (create from template on first install only) + strong secret
# ----------------------------------------------------------------------------
ENV_FILE="$PREFIX/.env"
if [[ -f "$ENV_FILE" ]]; then
  log ".env already exists — leaving it untouched."
else
  log "Creating $ENV_FILE from .env.example and generating SESSION_SECRET ..."
  cp "$PREFIX/.env.example" "$ENV_FILE"
  SECRET="$(openssl rand -hex 48)"
  # Replace the placeholder secret and set NODE_ENV/PORT.
  sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=${SECRET}#" "$ENV_FILE"
  sed -i "s#^PORT=.*#PORT=${PORT}#" "$ENV_FILE"
  sed -i "s#^NODE_ENV=.*#NODE_ENV=production#" "$ENV_FILE"
  warn "Edit $ENV_FILE and set DATABASE_URL to your PostgreSQL instance before the service will work."
fi

# ----------------------------------------------------------------------------
# 5. Uploads directory (document data) with correct ownership
# ----------------------------------------------------------------------------
# Honour UPLOADS_DIR from .env if set; else default to <prefix>/uploads.
UPLOADS_DIR="$(sed -n 's/^UPLOADS_DIR=\(.*\)$/\1/p' "$ENV_FILE" | tail -n1 | tr -d '"' | tr -d "'")"
[[ -n "$UPLOADS_DIR" ]] || UPLOADS_DIR="$PREFIX/uploads"
log "Ensuring uploads directory $UPLOADS_DIR ..."
mkdir -p "$UPLOADS_DIR"

# Ownership: service user owns the app tree and data; .env locked down.
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$PREFIX"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$UPLOADS_DIR"
chmod 600 "$ENV_FILE"

# ----------------------------------------------------------------------------
# 6. systemd unit (rendered into the prefix, symlinked into /etc)
# ----------------------------------------------------------------------------
log "Installing systemd unit ..."
UNIT_SRC="$PREFIX/deploy/meridian-edge.service"
RW_LINE=""
# If uploads live outside the prefix, grant write access explicitly.
case "$UPLOADS_DIR" in
  "$PREFIX"/*) : ;;
  *) RW_LINE="ReadWritePaths=$UPLOADS_DIR" ;;
esac
sed -e "s#__SERVICE_USER__#${SERVICE_USER}#g" \
    -e "s#__SERVICE_GROUP__#${SERVICE_GROUP}#g" \
    -e "s#__PREFIX__#${PREFIX}#g" \
    -e "s#__NODE_BIN__#${NODE_BIN}#g" \
    "$APP_SRC/deploy/meridian-edge.service" > "$UNIT_SRC.tmp"
# Append optional ReadWritePaths just before [Install].
if [[ -n "$RW_LINE" ]]; then
  awk -v rw="$RW_LINE" '/^\[Install\]/ && !done {print rw"\n"; done=1} {print}' "$UNIT_SRC.tmp" > "$UNIT_SRC"
  rm -f "$UNIT_SRC.tmp"
else
  mv "$UNIT_SRC.tmp" "$UNIT_SRC"
fi
ln -sf "$UNIT_SRC" /etc/systemd/system/meridian-edge.service
systemctl daemon-reload
systemctl enable meridian-edge >/dev/null 2>&1 || true

# ----------------------------------------------------------------------------
# 7. nginx vhost (rendered into the prefix, symlinked into conf.d)
# ----------------------------------------------------------------------------
if [[ $DO_NGINX -eq 1 ]]; then
  if [[ -z "$SERVER_NAME" ]]; then
    warn "No --server-name given; skipping nginx vhost. Install it later with:"
    warn "  sed -e 's/__SERVER_NAME__/your.fqdn/' -e 's/__PROXY_PORT__/${PORT}/' \\"
    warn "    $PREFIX/deploy/nginx.conf.template | sudo tee /etc/nginx/conf.d/meridian-edge.conf"
    warn "  sudo nginx -t && sudo systemctl reload nginx"
  else
    log "Installing nginx vhost for server_name '$SERVER_NAME' ..."
    VHOST_SRC="$PREFIX/deploy/meridian-edge.conf"
    sed -e "s#__SERVER_NAME__#${SERVER_NAME}#g" \
        -e "s#__PROXY_PORT__#${PORT}#g" \
        "$APP_SRC/deploy/nginx.conf.template" > "$VHOST_SRC"
    ln -sf "$VHOST_SRC" /etc/nginx/conf.d/meridian-edge.conf
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      log "  nginx vhost installed and reloaded."
    else
      warn "nginx -t failed — vhost left in place but NOT reloaded. Run 'sudo nginx -t' to diagnose."
    fi
  fi
fi

# ----------------------------------------------------------------------------
# 8. Database migrations (idempotent; clean-install and upgrade path)
# ----------------------------------------------------------------------------
DB_SET="$(sed -n 's/^DATABASE_URL=\(.*\)$/\1/p' "$ENV_FILE" | tail -n1)"
if [[ $DO_MIGRATE -eq 1 ]]; then
  if [[ -z "$DB_SET" || "$DB_SET" == *CHANGE_ME* ]]; then
    warn "DATABASE_URL not configured yet — skipping migrations."
    warn "After editing $ENV_FILE, run:  sudo -u $SERVICE_USER $PREFIX/migrate.sh"
  else
    log "Running database migrations ..."
    sudo -u "$SERVICE_USER" env NODE_BIN="$NODE_BIN" bash -c "cd '$PREFIX' && '$NODE_BIN' scripts/migrate-prod.js"
  fi
fi

# ----------------------------------------------------------------------------
# 9. Start / restart the service
# ----------------------------------------------------------------------------
if [[ -n "$DB_SET" && "$DB_SET" != *CHANGE_ME* ]]; then
  log "Starting meridian-edge service ..."
  systemctl restart meridian-edge || warn "Service failed to start — check: journalctl -u meridian-edge -n 50"
else
  warn "Not starting the service yet (DATABASE_URL unset). Start it after configuring .env:"
  warn "  sudo systemctl start meridian-edge"
fi

# ----------------------------------------------------------------------------
# 10. Next steps
# ----------------------------------------------------------------------------
cat <<EOF

$(log "Installation complete.")

Install prefix : $PREFIX
Service user   : $SERVICE_USER
App port       : 127.0.0.1:$PORT
Uploads dir    : $UPLOADS_DIR
nginx vhost    : $( [[ $DO_NGINX -eq 1 && -n "$SERVER_NAME" ]] && echo "/etc/nginx/conf.d/meridian-edge.conf ($SERVER_NAME)" || echo "not installed" )

NEXT STEPS
----------
1. Ensure $PREFIX/.env has a valid DATABASE_URL (local PostgreSQL 14+).
   If you changed it after install, run migrations:
       sudo -u $SERVICE_USER $PREFIX/migrate.sh
       sudo systemctl restart meridian-edge

2. Create the FIRST system administrator (clean DB only):
       cd $PREFIX
       sudo -u $SERVICE_USER ADMIN_USERNAME=admin ADMIN_PASSWORD='<a strong password>' \\
            $NODE_BIN scripts/bootstrap-admin.js
   (Omit ADMIN_PASSWORD to be prompted interactively.)

3. Log in at your server URL as that administrator, then upload your signed
   .melic licence under  Admin > Licence  to activate access for other users.

Service control : systemctl {status|restart|stop} meridian-edge
Logs            : journalctl -u meridian-edge -f
Runbook         : $PREFIX/docs/RUNBOOK.md
EOF
