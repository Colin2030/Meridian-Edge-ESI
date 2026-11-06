#!/usr/bin/env bash
#
# Meridian Edge — uninstaller (run with sudo/root on the target host).
#
# By default this ONLY stops and removes the service and nginx vhost. The
# application files, the uploads/data directory and the database are LEFT IN
# PLACE unless you explicitly ask for their removal.
#
#   ./uninstall.sh                 # stop + disable service, remove unit + vhost
#   ./uninstall.sh --purge         # ALSO delete the app dir and uploads/data
#   ./uninstall.sh --purge --drop-db   # ALSO drop the PostgreSQL database (guarded)
#
set -euo pipefail

PREFIX="${PREFIX:-/opt/meridian-edge}"
SERVICE_USER="${SERVICE_USER:-meridian}"
PURGE=0
DROP_DB=0
REMOVE_USER=0

usage() {
  cat <<EOF
Meridian Edge uninstaller

Usage: sudo ./uninstall.sh [options]

Options:
  --prefix DIR     Install directory                 (default: $PREFIX)
  --user NAME      Service user                       (default: $SERVICE_USER)
  --purge          Remove the app directory AND the uploads/data directory
  --drop-db        Drop the PostgreSQL database (requires typed confirmation).
                   Implies nothing is backed up — take a dump first if unsure.
  --remove-user    Remove the dedicated service user account
  -h, --help       Show this help

Without --purge the application files and database are preserved.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --user) SERVICE_USER="$2"; shift 2;;
    --purge) PURGE=1; shift;;
    --drop-db) DROP_DB=1; shift;;
    --remove-user) REMOVE_USER=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

log()  { echo -e "\033[1;34m[uninstall]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "uninstall.sh must be run as root (use sudo)."

# Capture DATABASE_URL BEFORE any file removal (needed for --drop-db).
DB_URL=""
if [[ -f "$PREFIX/.env" ]]; then
  DB_URL="$(sed -n 's/^DATABASE_URL=\(.*\)$/\1/p' "$PREFIX/.env" | tail -n1)"
fi
UPLOADS_DIR="$(sed -n 's/^UPLOADS_DIR=\(.*\)$/\1/p' "$PREFIX/.env" 2>/dev/null | tail -n1 | tr -d '"' | tr -d "'")"
[[ -n "$UPLOADS_DIR" ]] || UPLOADS_DIR="$PREFIX/uploads"

# ----------------------------------------------------------------------------
# 1. Stop & disable the systemd service
# ----------------------------------------------------------------------------
if systemctl list-unit-files 2>/dev/null | grep -q '^meridian-edge\.service'; then
  log "Stopping and disabling meridian-edge service ..."
  systemctl stop meridian-edge 2>/dev/null || true
  systemctl disable meridian-edge 2>/dev/null || true
fi
rm -f /etc/systemd/system/meridian-edge.service
systemctl daemon-reload 2>/dev/null || true

# ----------------------------------------------------------------------------
# 2. Remove nginx vhost
# ----------------------------------------------------------------------------
if [[ -e /etc/nginx/conf.d/meridian-edge.conf ]]; then
  log "Removing nginx vhost ..."
  rm -f /etc/nginx/conf.d/meridian-edge.conf
  if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || true
  fi
fi

# ----------------------------------------------------------------------------
# 3. Optional: drop the database (guarded)
# ----------------------------------------------------------------------------
if [[ $DROP_DB -eq 1 ]]; then
  [[ -n "$DB_URL" && "$DB_URL" != *CHANGE_ME* ]] || die "--drop-db: no usable DATABASE_URL found in $PREFIX/.env."
  command -v psql >/dev/null 2>&1 || die "--drop-db: psql client not found."
  # Parse the database name (last path segment, minus any ?query).
  DB_NAME="${DB_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
  [[ -n "$DB_NAME" ]] || die "--drop-db: could not parse database name from DATABASE_URL."
  # Maintenance URL: connect to the 'postgres' DB on the same server to drop the target.
  ADMIN_URL="${DB_URL%/*}/postgres"
  warn "About to DROP DATABASE \"$DB_NAME\". THIS PERMANENTLY DELETES ALL CASE DATA."
  read -r -p "Type the database name ('$DB_NAME') to confirm: " CONFIRM
  [[ "$CONFIRM" == "$DB_NAME" ]] || die "Confirmation did not match — database NOT dropped."
  log "Dropping database \"$DB_NAME\" ..."
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" \
    && log "Database dropped." \
    || die "Failed to drop database (is it still in use?)."
fi

# ----------------------------------------------------------------------------
# 4. Optional: purge application files and data
# ----------------------------------------------------------------------------
if [[ $PURGE -eq 1 ]]; then
  log "Purging application directory $PREFIX ..."
  rm -rf "$PREFIX"
  if [[ "$UPLOADS_DIR" != "$PREFIX"/* && -d "$UPLOADS_DIR" ]]; then
    log "Purging external uploads directory $UPLOADS_DIR ..."
    rm -rf "$UPLOADS_DIR"
  fi
else
  log "Left application files in $PREFIX and data intact (use --purge to remove)."
fi

# ----------------------------------------------------------------------------
# 5. Optional: remove the service user
# ----------------------------------------------------------------------------
if [[ $REMOVE_USER -eq 1 ]]; then
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Removing service user '$SERVICE_USER' ..."
    userdel "$SERVICE_USER" 2>/dev/null || warn "Could not remove user '$SERVICE_USER'."
  fi
fi

log "Uninstall complete."
[[ $DROP_DB -eq 0 ]] && log "The database was preserved (pass --drop-db to remove it)."
exit 0
