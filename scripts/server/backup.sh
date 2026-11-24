#!/usr/bin/env bash
# HomeBase off-machine backup with restic (encrypted on this machine before upload, deduplicated).
# Works with any restic repository: S3-compatible (Cloudflare R2, Backblaze B2, AWS), SFTP, local disk.
#
#   backup.sh init           create the restic repository (once)
#   backup.sh run            snapshot the database and back everything up (what the timer runs)
#   backup.sh restore-test   restore the latest database to a temp folder and check its integrity
#   backup.sh snapshots      list backups
#
# Settings: $HOMEBASE_BACKUP_ENV (default ~/.config/homebase/backup.env, mode 600), for example:
#   RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/homebase-backups
#   AWS_ACCESS_KEY_ID=...            (R2/B2/S3 key, limited to that bucket)
#   AWS_SECRET_ACCESS_KEY=...
#   AWS_DEFAULT_REGION=auto          (R2)
#   RESTIC_PASSWORD_FILE=~/.config/homebase/restic-password   (keep a copy OFF this machine)
# Optional: HOMEBASE_DATA_DIR (default ~/homebase-data), HOMEBASE_BACKUP_EXTRA (space-separated extra paths),
#           KEEP_HOURLY/KEEP_DAILY/KEEP_MONTHLY (48/30/12),
#           HOMEBASE_BACKUP_PING_URL (a healthchecks.io-style check: <url>/start, <url> on success, <url>/fail).
# Every `run` writes $HOMEBASE_DATA_DIR/.backup-status.json ({at, result: ok|failed, message, lastOkAt}),
# which the connector watches to raise inbox alerts (docs/CONFIGURATION.md, "Backup alerts").
set -uo pipefail

cmd="${1:-run}"
ENV_FILE="${HOMEBASE_BACKUP_ENV:-$HOME/.config/homebase/backup.env}"
DATA="${HOMEBASE_DATA_DIR:-$HOME/homebase-data}"
STATUS="$DATA/.backup-status.json"
STEP="setup"; REASON=""; DONE=0; ERRLOG=""

# Removes what must not leave this machine (repository address, key id, any URL) and keeps one short line.
scrub() {
  local s="$1"
  [[ -n "${RESTIC_REPOSITORY:-}" ]] && s="${s//"$RESTIC_REPOSITORY"/<repository>}"
  [[ -n "${AWS_ACCESS_KEY_ID:-}" ]] && s="${s//"$AWS_ACCESS_KEY_ID"/<key>}"
  printf '%s' "$s" | tr '\r\n\t' '   ' | tr -d '\000-\037' | sed -E 's#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+#<url>#g; s/ +/ /g' | cut -c1-200
}

# The previous lastOkAt (or `at` of an older status file that recorded a success), so a failure keeps it.
prev_ok() {
  [[ -f "$STATUS" ]] || return 0
  node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j.lastOkAt || (j.result === "ok" ? j.at : "") || "")); } catch {}' "$STATUS" 2>/dev/null || true
}

status() { # result, message
  local at last
  at="$(date -u +%FT%TZ)"; last="$(prev_ok)"
  [[ "$1" == ok ]] && last="$at"
  mkdir -p "$DATA" 2>/dev/null || true
  node -e '
    const fs = require("fs");
    const [file, at, result, message, lastOkAt] = process.argv.slice(1);
    fs.writeFileSync(file + ".tmp", JSON.stringify({ at, result, message, lastOkAt: lastOkAt || null }) + "\n");
    fs.renameSync(file + ".tmp", file);
  ' "$STATUS" "$at" "$1" "$(scrub "$2")" "$last" || echo "backup: could not write $STATUS" >&2
}

# Dead-man's switch. Never fails the backup, and never prints the URL (it is a token).
ping() { # suffix ("" | /start | /fail), body
  [[ -n "${HOMEBASE_BACKUP_PING_URL:-}" ]] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "${2:-}" "${HOMEBASE_BACKUP_PING_URL%/}$1" >/dev/null 2>&1 \
    || echo "backup: health-check ping${1:+ ($1)} failed (ignored)" >&2
}

# Runs one step; stderr goes to the log as before and its last line becomes the failure reason.
step() { # label, command...
  STEP="$1"; shift
  local rc=0
  "$@" 2>"$ERRLOG" || rc=$?
  cat "$ERRLOG" >&2
  if (( rc != 0 )); then
    local last; last="$(grep -v '^[[:space:]]*$' "$ERRLOG" | tail -n 1)"
    REASON="$STEP failed (exit $rc)${last:+: $last}"
    exit "$rc"
  fi
}

on_exit() {
  local rc=$?
  [[ -n "$ERRLOG" ]] && rm -f "$ERRLOG"
  (( DONE == 1 )) && return
  local why; why="$(scrub "${REASON:-$STEP stopped (exit $rc)}")"
  echo "backup: FAILED: $why" >&2
  status failed "$why"
  ping /fail "$why"
}

if [[ "$cmd" == run ]]; then
  ERRLOG="$(mktemp)"
  trap on_exit EXIT
fi

[[ -f "$ENV_FILE" ]] || { REASON="missing $ENV_FILE"; echo "backup: missing $ENV_FILE (see the header of this script)" >&2; exit 2; }
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
DATA="${HOMEBASE_DATA_DIR:-$HOME/homebase-data}"; DATA="${DATA/#\~/$HOME}"
STATUS="$DATA/.backup-status.json"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-}"; RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE/#\~/$HOME}"; export RESTIC_PASSWORD_FILE
[[ "$cmd" == run ]] && ping /start ""
[[ -n "${RESTIC_REPOSITORY:-}" ]] || { REASON="RESTIC_REPOSITORY not set in backup.env"; echo "backup: $REASON" >&2; exit 2; }
[[ -n "$RESTIC_PASSWORD_FILE" && -s "$RESTIC_PASSWORD_FILE" ]] || { REASON="RESTIC_PASSWORD_FILE missing or empty"; echo "backup: $REASON" >&2; exit 2; }
command -v restic >/dev/null || { REASON="restic is not installed"; echo "backup: $REASON" >&2; exit 2; }
set -e

CONF="$HOME/.config/homebase"
STAGE="$DATA/.backup-staging"
KEEP_HOURLY="${KEEP_HOURLY:-48}"; KEEP_DAILY="${KEEP_DAILY:-30}"; KEEP_MONTHLY="${KEEP_MONTHLY:-12}"

snapshot_db() {
  # A consistent copy of the live database (safe while the hub writes; WAL included).
  mkdir -p "$STAGE"; rm -f "$STAGE/homebase.db"
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const [src, dst] = process.argv.slice(1);
    const db = new DatabaseSync(src, { readOnly: true });
    db.exec(`VACUUM INTO ${JSON.stringify(dst).replace(/^"|"$/g, "\x27")}`);
    db.close();
  ' "$DATA/homebase.db" "$STAGE/homebase.db"
}

case "$cmd" in
  init) restic snapshots >/dev/null 2>&1 && echo "backup: repository already exists" || restic init ;;
  snapshots) restic snapshots ;;
  run)
    step "database snapshot" snapshot_db
    paths=("$STAGE" "$CONF")
    for p in attachments artifacts secrets claude-workspace comms-workspace browser connector.json gmail-sends.json gmail-state.json image-ledger.jsonl notes-dictations.json; do
      [[ -e "$DATA/$p" ]] && paths+=("$DATA/$p")
    done
    for p in "$HOME/.config/devapp" "$HOME/.config/systemd/user"; do [[ -e "$p" ]] && paths+=("$p"); done
    # shellcheck disable=SC2206
    [[ -n "${HOMEBASE_BACKUP_EXTRA:-}" ]] && paths+=(${HOMEBASE_BACKUP_EXTRA})
    step "restic backup" restic backup --tag homebase --one-file-system \
      --exclude 'node_modules' --exclude '.next' --exclude '.turbo' --exclude '.cache' --exclude '.venv' --exclude '.tools-venv' \
      --exclude '__pycache__' --exclude '*.log' \
      --exclude "$CONF/backup.env" --exclude "$CONF/restic-password" \
      --exclude "$DATA/browser/profile/*/Cache" --exclude "$DATA/browser/profile/*/Code Cache" --exclude "$DATA/browser/profile/*/GPUCache" \
      --exclude "$DATA/browser/profile/*/Service Worker/CacheStorage" --exclude "$DATA/browser/profile/Singleton*" \
      "${paths[@]}"
    rm -f "$STAGE/homebase.db"
    # Thin out old backups once a day (03:xx), and verify the repository's structure on Sundays.
    if [[ "$(date +%H)" == "03" ]]; then
      step "restic forget" restic forget --tag homebase --keep-hourly "$KEEP_HOURLY" --keep-daily "$KEEP_DAILY" --keep-monthly "$KEEP_MONTHLY" --prune
      if [[ "$(date +%u)" == "7" ]]; then step "restic check" restic check; fi
    fi
    msg="$(restic snapshots --tag homebase --latest 1 --compact 2>/dev/null | sed -n '3p' | tr -s ' ' || true)"
    DONE=1
    status ok "$msg"
    ping "" "$(scrub "$msg")"
    ;;
  restore-test)
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    restic restore latest --tag homebase --target "$tmp" --include "$STAGE/homebase.db"
    f="$tmp$STAGE/homebase.db"
    node -e '
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const ok = db.prepare("PRAGMA integrity_check").get();
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type=\x27table\x27").all().map(r => r.name);
      const counts = Object.fromEntries(["threads","messages","runs"].filter(t => rows.includes(t)).map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
      console.log("restore-test:", Object.values(ok)[0], JSON.stringify(counts));
      if (Object.values(ok)[0] !== "ok") process.exit(1);
    ' "$f"
    ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
