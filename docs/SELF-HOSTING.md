# Self-hosting HomeBase

How to run the hub and the connector on an always-on machine and reach them from your devices. Placeholders: `<your-server>` is the server's SSH alias (from `~/.ssh/config`) or `user@host`; `<tailscale-ip>` is its tailnet address (`100.x.y.z`); `<tailnet>` is your tailnet's DNS name.

## 1. Server prerequisites

- Linux with systemd (Ubuntu or Debian tested), Node 24.3+ and npm, key-based SSH from your PC.
- [Tailscale](https://tailscale.com) on the server and on your devices (recommended), or SSH access from each PC.
- For the Claude agent: Claude Code installed on the server (`~/.local/bin/claude`). Log it in yourself once, on the server: run `claude` and complete the login; `claude auth status` should report a claude.ai login. HomeBase never logs in for you and never reads the credential files.
- Optional: Google Chrome and `xvfb` for the agent browser; the Codex CLI (`npm i -g @openai/codex`, then `codex login --device-auth`) for image generation; `ripgrep` for faster note search.

## 2. Deploy

From your PC, in the repo (Git Bash on Windows):

```
bash scripts/deploy.sh <your-server>          # or set HOMEBASE_SSH_HOST in .env.local
```

It copies the source to `~/homebase` on the server over SSH (no `node_modules`, builds, data, or local-only files) and runs `scripts/server/install.sh` there, which:

- installs the hub, connector, protocol and sync-client workspaces (the Expo and Electron apps are built on your PC, not on the server);
- creates `~/homebase-data` (database, connector token, agent workspaces, `secrets/` with mode 700) and `~/projects`;
- writes `~/.config/homebase/homebase.env` and `~/.config/homebase/claude-agent.json` from the examples in `scripts/server/`, only if they do not exist yet;
- installs and starts two systemd **user** services, `homebase-hub` and `homebase-connector`, and enables lingering so they run without a login session.

On first start the connector has no token, so `scripts/server/start-connector.sh` asks the hub for a single-use connector code and pairs with it. Running `deploy.sh` again is how you update; the database and pairings are kept. If `apps/client/dist` exists on your PC (`npm run build:web`) it is shipped too, and the hub serves it at `/`. Build it **without** `EXPO_PUBLIC_HUB_URL` so the page pairs with the address it was opened from.

## 3. Reach the hub

The hub speaks plain HTTP and listens on `127.0.0.1` by default; it refuses `0.0.0.0`. Pick one:

- **Tailscale Serve (recommended)**: `sudo tailscale serve --bg 8787` on the server. Devices use `https://<server>.<tailnet>.ts.net`, tailnet-only, with a valid certificate (enable MagicDNS and HTTPS certificates in the Tailscale admin console first). Never use `tailscale funnel`, which is public.
- **Tailnet address**: set `HOMEBASE_HOST=127.0.0.1,<tailscale-ip>` in `homebase.env` and restart the hub. Devices use `http://<tailscale-ip>:8787`. A browser treats plain http as insecure, so clipboard image paste, the microphone and notifications only work in the apps or over https.
- **SSH only**: the desktop app's **Via SSH** mode tunnels `127.0.0.1:18787` to the hub's loopback port; for anything else, `ssh -N -L 8788:127.0.0.1:8787 <your-server>`.

Set `HOMEBASE_PUBLIC_URL` to the address devices use; the hub prints it at start.

## 4. Pair devices

On the server: `cd ~/homebase && npm run pair-code` (single use, 10 minutes; `-- --ttl 1440` for a day). In the app: enter the hub's address and the code. Later codes can also come from **Settings → Devices** in any paired app.

- **Browser**: open the hub's address.
- **Desktop (Windows)**: `npm run desktop:dist` on your PC, run `dist-desktop/HomeBase-Setup-<version>.exe` (unsigned: SmartScreen → "More info" → "Run anyway"). First run asks Via SSH (`ssh <host>` must work in a terminal without a password; a key with a passphrase must be in ssh-agent) or Direct. Profile and pairing live in `%APPDATA%\HomeBase-desktop`; dictation downloads its speech model on first use.
- **Android (sideload)**: `npm run android -- --release --hub-url <hub address>` builds `dist-apk/HomeBase.apk`. Install it with `adb install -r dist-apk/HomeBase.apk`. On Android 16+ allow the "nearby devices" (local network) prompt, or pairing to a private address fails.

## 5. Operate

```
systemctl --user status homebase-hub homebase-connector
systemctl --user restart homebase-hub homebase-connector
journalctl --user -u homebase-hub -u homebase-connector -f
```

- Back up before every update: `~/homebase-data`, `~/homebase` and `~/.config/homebase`.
- **Off-machine backups**: `scripts/server/backup.sh` uses [restic](https://restic.net) (encrypted, deduplicated; S3-compatible, SFTP or local). Fill `~/.config/homebase/backup.env` (mode 600; variables in the script header) and a password file, keep a copy of the password elsewhere, then `backup.sh init`, `backup.sh run`, `backup.sh restore-test`, and enable the hourly timer: `cp scripts/server/homebase-backup.{service,timer} ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now homebase-backup.timer`.
  - **Alerts in HomeBase**: each run writes `~/homebase-data/.backup-status.json`; the connector turns a failed run, or no successful backup for 3 hours, into a P1 inbox item that clears itself on the next success ([CONFIGURATION.md](CONFIGURATION.md#backup-alerts)).
  - **Outside alert (dead-man's switch)**: catches a server that is down altogether. Create a check at [healthchecks.io](https://healthchecks.io) (or a self-hosted equivalent) with period 1 hour and grace 1 hour, and add its ping URL to `backup.env` as `HOMEBASE_BACKUP_PING_URL=...`. Each run pings `<url>/start`, then `<url>` or `<url>/fail` with a short reason. A failed ping never fails the backup, and the URL is never logged.
- **Long-running apps for agents**: `scripts/server/devapp` keeps a web app an agent built running as its own user service (`devapp start <name> <port> -- <command>`). Copy it to `~/.local/bin/devapp`. It prints `http://<host>:<port>`, where `<host>` is `HOMEBASE_PUBLIC_HOST` or the machine's hostname. `scripts/server/devapp-CLAUDE.md` is a CLAUDE.md you can give the agent's workspace.
- **Demo content**: a server never needs `HOMEBASE_DEMO`. A database first created by an older version (before the empty baseline) holds invented sample content; with the hub stopped, `npm run remove-demo` lists it and `npm run remove-demo -- --apply` removes it ([CONFIGURATION.md](CONFIGURATION.md#demo-content)).
- **Starting over**: stop both services, move `~/homebase-data` aside, start them again; every device pairs again.

## 6. Rules worth keeping

- Claude runs only through the official CLI on the server's own login, for your own use. A multi-user or hosted version must use per-user API keys.
- Never pass `--dangerously-skip-permissions`; the connector strips `ANTHROPIC_*` and `CLAUDE_CODE_*` from agent runs.
- Gmail scopes stay `gmail.readonly` + `gmail.compose`; sends always need an approval on a device.
- Keep secrets (OAuth client files, tokens, restic keys) in `~/homebase-data/secrets` or `~/.config/homebase`, never in the repo.
