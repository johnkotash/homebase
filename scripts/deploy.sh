#!/usr/bin/env bash
# Copies this repo to a server over SSH (no node_modules, builds or data) and (re)installs the services.
#   bash scripts/deploy.sh <ssh-host> [remote-dir]   ssh-host: an alias from ~/.ssh/config or user@host (or set
#                                                     HOMEBASE_SSH_HOST in the environment or .env.local);
#                                                     remote-dir defaults to homebase (in the remote home)
# The web client the hub serves at / is the export built on this PC (`npm run build:web` -> apps/client/dist).
# When it is there it is shipped first, into <remote-dir>/apps/client/dist, swapped in whole. The server never
# builds it. HB_DEPLOY_WEB=0 skips it (the hub keeps the export it has).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${HOMEBASE_SSH_HOST:-}" ] && [ -f .env.local ]; then
  HOMEBASE_SSH_HOST="$(sed -n 's/^[[:space:]]*HOMEBASE_SSH_HOST=//p' .env.local | tail -n1 | tr -d '"\r ')"
fi
HOST="${1:-${HOMEBASE_SSH_HOST:-}}"
[ -n "$HOST" ] || { echo "usage: bash scripts/deploy.sh <ssh-host> [remote-dir]   (or set HOMEBASE_SSH_HOST)" >&2; exit 2; }
DIR="${2:-homebase}"
WEB=apps/client/dist
if [ "${HB_DEPLOY_WEB:-1}" != "0" ] && [ -f "$WEB/index.html" ]; then
  echo "[deploy] web client: $WEB ($(du -sh "$WEB" | cut -f1)) -> $HOST:$DIR/$WEB"
  REMOTE_WEB=$(cat <<EOF
set -e
cd ~
D="$DIR/$WEB"
mkdir -p "\$(dirname "\$D")"
rm -rf "\$D.new" "\$D.old"
mkdir -p "\$D.new"
tar -xzf - -C "\$D.new"
test -f "\$D.new/index.html"
if [ -d "\$D" ]; then mv "\$D" "\$D.old"; fi
mv "\$D.new" "\$D"
rm -rf "\$D.old"
EOF
)
  tar -czf - -C "$WEB" . | ssh -o BatchMode=yes "$HOST" "$REMOTE_WEB"
else
  echo "[deploy] web client: not shipped (no $WEB/index.html, or HB_DEPLOY_WEB=0)"
fi
tar -czf - \
  --exclude=node_modules --exclude=.expo --exclude=dist --exclude=dist-apk --exclude=dist-desktop --exclude=.claude --exclude=.git \
  --exclude=./data --exclude=./apps/client/android --exclude=./apps/client/ios \
  --exclude=.connector.json --exclude=claude-agent.json --exclude='*.log' --exclude='*.tsbuildinfo' --exclude=./docs/screenshots --exclude=CLAUDE.local.md --exclude='.env' --exclude='.env.*' \
  . | ssh -o BatchMode=yes "$HOST" "mkdir -p '$DIR' && tar -xzf - -C '$DIR' && bash '$DIR/scripts/server/install.sh'"
