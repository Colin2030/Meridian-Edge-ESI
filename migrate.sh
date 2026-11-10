#!/usr/bin/env bash
#
# Meridian Edge — database migration wrapper.
#
# Applies all pending SQL migrations. Migrations are idempotent (every statement
# uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so this is BOTH the clean-install
# and the upgrade path — re-running it is always safe and never drops data.
#
# Usage:
#   On the installed host (run as the service user, or via sudo):
#       sudo -u meridian /opt/meridian-edge/migrate.sh
#   Or directly in the install prefix:
#       cd /opt/meridian-edge && ./migrate.sh
#
# It reads DATABASE_URL from the .env file in the install prefix.
#
set -euo pipefail

# Ensure sbin dirs are on PATH. Minimal Debian installs (and sudo's secure_path)
# often omit these, which makes useradd, nginx and systemctl appear 'not found'
# even though they are installed. Prepend them so the installer is robust.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# Resolve the directory this script lives in (the install prefix / app root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# install.sh places this wrapper at the prefix root, with the app payload either
# directly alongside it (dist/, scripts/, migrations/) or under ./app. Support both.
if [[ -f "$SCRIPT_DIR/scripts/migrate-prod.js" ]]; then
  APP_DIR="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/app/scripts/migrate-prod.js" ]]; then
  APP_DIR="$SCRIPT_DIR/app"
else
  echo "ERROR: cannot locate scripts/migrate-prod.js next to $SCRIPT_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: no .env found in $APP_DIR — create it from .env.example first." >&2
  exit 1
fi

# Prefer an explicit NODE_BIN, else the node on PATH.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "ERROR: node not found on PATH. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

echo "Running migrations from $APP_DIR/migrations ..."
exec "$NODE_BIN" scripts/migrate-prod.js
