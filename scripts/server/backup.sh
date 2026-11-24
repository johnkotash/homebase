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
#           KEEP_HOURLY/KEEP_DAILY/KEEP_MONTHLY (48/30/12).
set -euo pipefail

ENV_FILE="${HOMEBASE_BACKUP_ENV:-$HOME/.config/homebase/backup.env}"
[[ -f "$ENV_FILE" ]] || { echo "backup: missing $ENV_FILE (see the header of this script)" >&2; exit 2; }
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE/#\~/$HOME}"; export RESTIC_PASSWORD_FILE
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set in $ENV_FILE}"
[[ -n "${RESTIC_PASSWORD_FILE:-}" && -s "$RESTIC_PASSWORD_FILE" ]] || { echo "backup: RESTIC_PASSWORD_FILE missing or empty" >&2; exit 2; }

DATA="${HOMEBASE_DATA_DIR:-$HOME/homebase-data}"
CONF="$HOME/.config/homebase"
STAGE="$DATA/.backup-staging"
STATUS="$DATA/.backup-status.json"
KEEP_HOURLY="${KEEP_HOURLY:-48}"; KEEP_DAILY="${KEEP_DAILY:-30}"; KEEP_MONTHLY="${KEEP_MONTHLY:-12}"

status() { # result, message
  printf '{"at":"%s","result":"%s","message":%s}\n' "$(date -u +%FT%TZ)" "$1" "$(printf '%s' "$2" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))')" > "$STATUS"
}

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

cmd="${1:-run}"
case "$cmd" in
  init) restic snapshots >/dev/null 2>&1 && echo "backup: repository already exists" || restic init ;;
  snapshots) restic snapshots ;;
  run)
    trap 'status failed "backup.sh run failed at line $LINENO"' ERR
    snapshot_db
    paths=("$STAGE" "$CONF")
    for p in attachments artifacts secrets claude-workspace comms-workspace browser connector.json gmail-sends.json gmail-state.json image-ledger.jsonl notes-dictations.json; do
      [[ -e "$DATA/$p" ]] && paths+=("$DATA/$p")
    done
    for p in "$HOME/.config/devapp" "$HOME/.config/systemd/user"; do [[ -e "$p" ]] && paths+=("$p"); done
    # shellcheck disable=SC2206
    [[ -n "${HOMEBASE_BACKUP_EXTRA:-}" ]] && paths+=(${HOMEBASE_BACKUP_EXTRA})
    restic backup --tag homebase --one-file-system \
      --exclude 'node_modules' --exclude '.next' --exclude '.turbo' --exclude '.cache' --exclude '.venv' --exclude '.tools-venv' \
      --exclude '__pycache__' --exclude '*.log' \
      --exclude "$CONF/backup.env" --exclude "$CONF/restic-password" \
      --exclude "$DATA/browser/profile/*/Cache" --exclude "$DATA/browser/profile/*/Code Cache" --exclude "$DATA/browser/profile/*/GPUCache" \
      --exclude "$DATA/browser/profile/*/Service Worker/CacheStorage" --exclude "$DATA/browser/profile/Singleton*" \
      "${paths[@]}"
    rm -f "$STAGE/homebase.db"
    # Thin out old backups once a day (03:xx), and verify the repository's structure on Sundays.
    if [[ "$(date +%H)" == "03" ]]; then
      restic forget --tag homebase --keep-hourly "$KEEP_HOURLY" --keep-daily "$KEEP_DAILY" --keep-monthly "$KEEP_MONTHLY" --prune
      [[ "$(date +%u)" == "7" ]] && restic check
    fi
    status ok "$(restic snapshots --tag homebase --latest 1 --compact 2>/dev/null | sed -n '3p' | tr -s ' ')"
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
