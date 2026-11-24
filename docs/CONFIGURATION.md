# Configuration

Nothing about one deployment is built into the code. Settings come from the environment, with neutral defaults.

| Where | Read by | What goes there |
|---|---|---|
| `~/.config/homebase/homebase.env` (or `HOMEBASE_ENV_FILE`) | hub, connector, `npm run pair-code`, `devapp` | Server settings below. Real environment variables win. Template: `scripts/server/homebase.env.example`. The file is read by a shell, so quote values with spaces: `HB_ORG_NAME="Acme Studio"` |
| `claude-agent.json` (`HB_CLAUDE_CONFIG`; default `apps/connector/claude-agent.json`) | connector | The Claude agent: model, folders, tools, modes |
| `.env.local` in the repo (untracked; copy `.env.example`) | build scripts, `apps/client/app.config.js`, `scripts/deploy.sh` | Build settings. Only `HOMEBASE_*` keys are read from it |
| `~/.config/homebase/denylist.txt` (untracked) | `scripts/scan-secrets.mjs` | Your private names, hosts and emails to block from commits |

Keep secrets out of all of these except the files under `~/homebase-data/secrets` (mode 600) that the Gmail setup creates.

## Hub

| Variable | Default | Meaning |
|---|---|---|
| `HOMEBASE_HOST` | `127.0.0.1` | Bind address; a comma-separated list of specific addresses is allowed (e.g. `127.0.0.1,<tailscale-ip>`). `0.0.0.0` is refused |
| `HOMEBASE_PORT` | `8787` | Port |
| `HOMEBASE_DATA_DIR` | `./data` | Database and runtime data |
| `HOMEBASE_PUBLIC_URL` | unset | The address devices use; printed at start |
| `HOMEBASE_BOOT_CODES` | `1` | `0`: do not mint and print pairing codes at start (use `npm run pair-code`) |
| `HOMEBASE_WEB_DIR` | `apps/client/dist` | Web client served at `/`; `off` to disable |
| `HOMEBASE_WORKSPACE_NAME` | `HomeBase` | Workspace name when the database is created |
| `HOMEBASE_DEMO` | off | `1`: fill a new database with invented demo content, and have the connector register the scripted Dev and Site ops agents. See [Demo content](#demo-content) |
| `DEV_MODE`, `SIM_INTERVAL_SEC`, `SLA_TICK_MS` | `1`, `0`, `30000` | Development switches |

## Connector and agents

| Variable | Default | Meaning |
|---|---|---|
| `HB_HUB` | `http://127.0.0.1:8787` | Hub address |
| `HB_CONNECTOR_CONFIG` | `apps/connector/.connector.json` | Where the connector keeps its token |
| `HB_CONNECTOR_NAME` | `<hostname>-connector` | Name shown in the app |
| `HB_ORG_NAME` | unset | Business or team the Comms and Notes agents work for; unset, they work for "the owner" |
| `HB_CLAUDE`, `HB_CLAUDE_MODEL`, `HB_CLAUDE_MAX_TURNS`, `HB_CLAUDE_COMMAND` | on, from config | Claude agent switches and overrides |
| `HB_FOLDERS_FILE`, `HB_BROWSE_ROOTS`, `HB_APP_FOLDERS` | next to the config, `~`, on | Folders approved from the app, where the folder browser may look, and whether the app may approve folders |
| `HB_COMMS`, `HB_COMMS_MODEL`, `HB_COMMS_OWNER_NAME` | on | Comms agent; the owner's first name for signing drafts |
| `HB_GMAIL_SEND_CAP`, `HB_GMAIL_POLL_SEC`, `HB_GMAIL_CLIENT_JSON`, `HB_GMAIL_SECRETS_DIR` | `10`, `180`, `<data>/secrets/…` | Gmail limits and file locations |
| `HB_NOTES`, `HB_NOTES_VAULT`, `HB_NOTES_TZ`, `HB_NOTES_MODEL` | on, `~/vault`, `America/New_York` | Notes agent: the vault root (folder with `_Index.md` and `Daily Notes/`) and the owner's time zone |
| `HB_NOTES_AUTHOR_EMAIL` | `notes-agent@homebase.local` | Email on the Notes agent's vault commits |
| `HB_BROWSER`, `HB_BROWSER_EXE`, `HB_BROWSER_PROFILE`, `HB_BROWSER_IDLE_MIN` | on, auto-detected, `<data>/browser/profile` | Agent browser |
| `HB_IMAGES`, `HB_IMAGES_PER_RUN`, `HB_IMAGES_PER_HOUR`, `HB_CODEX_COMMAND` | on | Image generation through the Codex CLI |
| `HOMEBASE_PUBLIC_HOST` | machine hostname | Host `devapp` prints in the URLs it gives agents |
| `TZ` | system | The connector's clock (the agent browser's hours rule) |

### `claude-agent.json`

Everything has a default (locally the sandbox is `data/claude-workspace`); `~` is expanded. Example, close to the server template `scripts/server/claude-agent.server.json`:

```json
{
  "enabled": true,
  "auth": "subscription",
  "command": "claude",
  "model": "sonnet",
  "permissionProfile": "strict",
  "modes": ["manual", "auto", "plan"],
  "sandboxDir": "~/homebase-data/claude-workspace",
  "projectDirs": ["~/projects"],
  "tools": ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "PowerShell", "TodoWrite", "WebSearch", "WebFetch"]
}
```

Leave `"auto"` out of `modes` and every write and command stays behind an approval whatever the app asks for. `auth: "api_key"` keeps `ANTHROPIC_API_KEY` in the agent's environment; the default `subscription` strips it.

## Demo content

A new database starts empty: the workspace (named from `HOMEBASE_WORKSPACE_NAME`), the owner, three SLA policies (standard one business day, P0 one hour, P1 four business hours) and neutral settings with no priority senders.

`HOMEBASE_DEMO=1` (also `true`, `yes`, `on`) is for screenshots and trying the app. The hub seeds a new database with invented sessions, runs, approvals, inbox items, notes, simulated integrations and demo priority senders; the connector (which reads the same `homebase.env`) registers the scripted Dev and Site ops agents. It changes nothing in a database that already exists.

`npm run remove-demo` takes that content out of an existing database and keeps everything else. Without flags it is a dry run that lists each row it would remove and the row counts. `-- --apply` removes it through the hub's change log, so paired devices drop the rows on their next sync, after writing a backup next to the database. It refuses while the database is open in another process: stop the hub (and turn `HOMEBASE_DEMO` off for the connector) first. `-- --db <file>` points it at another database. What counts as demo: rows dated up to 60 seconds after the workspace was created, the `dev` and `ops` mock agents and everything of theirs, `simulated` integrations, and `.example` priority senders.

## Build (`.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `HOMEBASE_APP_ID` | `dev.homebase.app` | Android package and Windows installer app id. A different id is a different app (pairing is per app) |
| `HOMEBASE_PUBLISHER` | `HomeBase contributors` | Author and copyright in the desktop installer |
| `HOMEBASE_SSH_HOST` | unset | Default host for `scripts/deploy.sh` |
| `EXPO_PUBLIC_HUB_URL` | unset | Pair-screen default baked into a phone build. Pass it as `--hub-url` to `npm run android -- --release`; never set it for the web export |
| `HB_BUILD_DIR` | `C:\hb` | Windows only: short mirror folder for the Android native build (path-length limit) |
