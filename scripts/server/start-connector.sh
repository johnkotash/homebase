#!/usr/bin/env bash
# Starts the connector. On first start (no saved token) it asks the hub's CLI for a single-use
# connector pairing code and pairs with it; later starts reuse the saved token.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE="${HOMEBASE_ENV_FILE:-$HOME/.config/homebase/homebase.env}"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
expand() { case "$1" in "~/"*) printf '%s' "$HOME/${1#\~/}" ;; *) printf '%s' "$1" ;; esac; }

HUB="${HB_HUB:-http://127.0.0.1:${HOMEBASE_PORT:-8787}}"
TOKEN_FILE="$(expand "${HB_CONNECTOR_CONFIG:-apps/connector/.connector.json}")"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "[connector] no saved token; waiting for the hub at $HUB"
  for _ in $(seq 1 60); do
    if node -e "fetch('$HUB/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
    sleep 2
  done
  CODE="$(node --import tsx apps/server/src/cli/pair-code.ts connector --raw)"
  echo "[connector] pairing with a fresh connector code"
  exec node --import tsx apps/connector/src/index.ts --hub "$HUB" --pair "$CODE"
fi
exec node --import tsx apps/connector/src/index.ts --hub "$HUB"
