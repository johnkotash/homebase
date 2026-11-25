#!/usr/bin/env bash
# Run on the server, from the deployed repo (~/homebase): installs dependencies, writes the config
# files if they are missing, and installs + starts the two systemd user services.
# It never installs Claude Code and never touches its login.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"
CONF="$HOME/.config/homebase"
UNITS="$HOME/.config/systemd/user"

mkdir -p "$CONF" "$UNITS" "$HOME/homebase-data" "$HOME/projects"
# Gmail OAuth client file and token for the Comms agent live here, readable by this user only (docs/GMAIL-SETUP.md).
mkdir -p "$HOME/homebase-data/secrets" && chmod 700 "$HOME/homebase-data/secrets"
[ -f "$CONF/homebase.env" ] || cp scripts/server/homebase.env.example "$CONF/homebase.env"
[ -f "$CONF/claude-agent.json" ] || cp scripts/server/claude-agent.server.json "$CONF/claude-agent.json"

# Only what the hub and the connector need: the phone/web client (Expo) and the desktop app (Electron, Whisper)
# are built on the PC, so their dependencies (about 480 MB for desktop dictation alone) are not installed here.
# `npm ci` can refuse a lockfile written by another npm version; `npm install` with the same filter is the fallback.
WS=(-w @homebase/server -w @homebase/connector -w @homebase/protocol -w @homebase/sync-client --include-workspace-root)
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund "${WS[@]}" || npm install --no-audit --no-fund "${WS[@]}"; else npm install --no-audit --no-fund "${WS[@]}"; fi

# Agent tools on the PATH the connector gives its runs: hbjob (background jobs that report back) and devapp (long-running web apps).
mkdir -p "$HOME/.local/bin"
chmod +x scripts/server/hbjob scripts/server/devapp
ln -sf "$REPO/scripts/server/hbjob" "$HOME/.local/bin/hbjob"
[ -e "$HOME/.local/bin/devapp" ] || ln -s "$REPO/scripts/server/devapp" "$HOME/.local/bin/devapp"

sed "s#%h/homebase#$REPO#g" scripts/server/homebase-hub.service > "$UNITS/homebase-hub.service"
sed "s#%h/homebase#$REPO#g" scripts/server/homebase-connector.service > "$UNITS/homebase-connector.service"
systemctl --user daemon-reload
systemctl --user enable homebase-hub homebase-connector
systemctl --user restart homebase-hub
systemctl --user restart homebase-connector

# Keep the services running when nobody is logged in. Needs no password on most setups.
if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes; then
  loginctl enable-linger "$USER" 2>/dev/null || echo "NOTE: could not enable linger. Run once: sudo loginctl enable-linger $USER"
fi
systemctl --user --no-pager status homebase-hub homebase-connector | grep -E "●|Active:" || true
