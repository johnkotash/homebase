# Agents

The connector registers its agents with the hub; each one appears on every device. To add one, add a definition in `apps/connector/src/config.ts` (adapter, workspace, tools, modes). There is no "New agent" screen yet.

| Agent | What it does | Limits |
|---|---|---|
| Claude agent | Coding and ops in its own workspace, through the Claude Code CLI | Manual / Auto / Plan; secret files and catastrophic commands are blocked in every mode |
| Comms | Gmail: search, read, draft, send drafts | `gmail.readonly` + `gmail.compose` only; every send needs an approval |
| Notes | Reads, searches and appends to an Obsidian vault | No delete, rename, move or rewrite; every change is a git commit |
| Dev, Site ops | Scripted mock agents for trying the app; registered only with `HOMEBASE_DEMO=1` | Simulated |

## Claude agent

Each run starts the official `claude` CLI on the connector machine in headless stream-json mode, with the login already on that machine. HomeBase never reads the CLI's credential files, removes `ANTHROPIC_*` and `CLAUDE_CODE_*` variables from the child's environment (so a run cannot switch to API billing), and records the auth mode on every run. Runs count against your Claude plan's usage limits. If the CLI is missing or logged out, the agent shows a note on every device and the connector re-checks every minute.

**Approvals.** The connector hands the CLI a local MCP permission-prompt tool, so every tool call the CLI would ask about reaches HomeBase's policy (`apps/connector/src/policy.ts`), which allows it, asks you, or blocks it.

| Mode | What the agent may do without asking |
|---|---|
| **Manual** (default) | Read inside the working directory. Every write, edit and command waits for you |
| **Auto** | Everything: edits, any command, web fetches and downloads, and acting in its browser, end to end without asking. You take on the risk. Still asks only for browser steps that buy, delete or hand something over, and email sends |
| **Plan** | Research read-only and propose a plan; a card offers "Approve & run in Auto", "Approve & run in Manual" or "Keep planning" |

Secret files (`~/.claude`, `~/.ssh`, `.env`, …) are blocked in every mode and cannot be approved. Auto is a permission policy, not a sandbox: an allowed `npm test` runs whatever the project's script does, so use it in workspaces you trust. The mode is on every run and approval, and each auto-approved call is a timeline event and an audit-log row (`GET /v1/audit`).

**Folders.** The agent starts in its sandbox (`data/claude-workspace` locally). Other folders must be allowlisted in `claude-agent.json` or approved from the app; a session stays in the folder it started in and follow-ups resume the same Claude session. Credential folders, the home folder and the vault can never be added.

## Comms agent (Gmail)

The same CLI with far fewer powers: Gmail tools (`gmail_search`, `gmail_read_thread`, `gmail_list_drafts`, `gmail_create_draft`, `gmail_update_draft`, `gmail_send_draft`) and read-only file tools in its own folder. No shell, no writing files, no web. Setup: [GMAIL-SETUP.md](GMAIL-SETUP.md).

- **Sending** is gated in code, in every mode: the draft is read back from Gmail and shown in full (From, To, Cc, Bcc, Subject, text) as a high-risk approval. A rejection returns `DENIED`; a draft that changed after approval is not sent; at most 10 sends an hour (`HB_GMAIL_SEND_CAP`).
- **Email is untrusted**: everything the agent reads is wrapped as third-party data, hidden text is stripped, and likely prompt-injection raises a P1 inbox item.
- **Inbox**: while connected, new INBOX mail becomes inbox items every 3 minutes (sender, subject, snippet; bodies never go to the hub). Mail is never marked read or labelled.
- `HB_ORG_NAME` and `HB_COMMS_OWNER_NAME` personalise its instructions and sign-off.

Try it without a mailbox: `node --import tsx apps/connector/test/e2e-comms.ts` (real CLI on `haiku`, local fake of the Gmail API).

## Notes agent

The Notes tab is an Obsidian vault held on the connector machine (`HB_NOTES_VAULT`, the folder with `_Index.md` and `Daily Notes/`; its git repository may be a parent folder). The vault service (`apps/connector/src/vault/`) confines reads to the vault, indexes notes, searches with ripgrep, and only ever appends.

- Dictations and typed additions are filed into monthly daily-note files (`Daily Notes/<year>/<Month>.md`, `## YYYYMMDD` headings), with client items also in `Daily Notes/Clients/<client>/<year>/<Month>.md`, using the names and aliases in `Clients.md`. A verbatim transcript is kept under `Daily Notes/RAW/AI Transcriptions/`; the rest of `RAW` is human-only.
- Answers cite notes as wikilinks. Note text in the vault is data, never instructions; the vault's own `CLAUDE.md` files are the agent's rules.
- Each agent change is one commit by "HomeBase Notes Agent"; outside edits are swept into `external:` commits; pushes are plain (never forced) and stop if the remote diverged. Undo with `git revert`.

Try it without a vault: `node --import tsx apps/connector/test/e2e-notes.ts` (real CLI on `haiku`, throwaway vault).

## Agent browser and images

- **Browser**: when Chrome is available on the connector machine (on a headless Linux server with `xvfb`), agents get browser tools; you can watch the page live and take over from the app. Pages on the machine itself, the LAN and the tailnet are refused.
- **Images**: with the Codex CLI installed and signed in, agents can generate images (per-run and per-hour caps). Pictures you attach to a message reach the agent as image content.

Code comments sometimes cite design notes such as `NOTES-PLAN.md`, `BROWSER-AGENT-PLAN.md` or `MULTI-PROVIDER-PLAN.md`; those are internal planning documents that are not published. [ARCHITECTURE.md](ARCHITECTURE.md) is the public design reference.
