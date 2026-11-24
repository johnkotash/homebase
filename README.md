# HomeBase

[![CI](https://github.com/johnkotash/homebase/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/johnkotash/homebase/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Node 24.3+](https://img.shields.io/badge/node-%E2%89%A524.3-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Platforms: Linux | Windows | Android](https://img.shields.io/badge/platforms-Linux%20%7C%20Windows%20%7C%20Android-lightgrey)
[![Secret scan: gitleaks](https://img.shields.io/badge/secret%20scan-gitleaks-orange)](.github/workflows/ci.yml)

HomeBase is a self-hosted command center for AI agents. A small hub runs on a machine you own, a connector next to it runs your agents (Claude Code on your own login, plus Gmail, notes and image helpers), and you follow, steer and approve their work from your phone, a browser or a desktop app, all kept in sync live.

<!-- Screenshots: to come (demo data only). -->

## Features

- **Sessions and projects**: chats with agents that resume where they stopped, filed in projects, with a one-line digest and "where I left off" notes.
- **Approvals and modes**: risky tool calls become approval cards on every device. Per agent and per chat: **Manual** (ask for every write and command), **Auto** (work end to end without asking; only purchases, deletions in the browser and email sends still ask), **Plan** (read-only until you approve a plan).
- **Live agent browser**: agents can drive a real Chrome on the connector machine, and you can watch and take over from the app.
- **Image attachments** on messages, and **image generation** through the Codex CLI.
- **Inbox with SLA clocks**: Gmail (read and draft only; every send needs your approval), monitors and other sources in one prioritized queue.
- **Notes agent** for an Obsidian vault: search, cited answers, dictated daily notes; append-only, every change a git commit.
- **Desktop app** (Windows installer) with local dictation, plus a web client served by the hub itself.
- **Works over Tailscale or SSH**: the hub listens on loopback or a private address; the desktop app can open its own SSH tunnel.

## How it fits together

```
 Phone / browser / desktop  <── WebSocket + HTTP ──>  Hub (apps/server: Hono, ws, SQLite)
                                                        ^
                                                        │ outbound WebSocket
                                                      Connector (apps/connector)
                                                        └─ runs agents: Claude Code CLI, Gmail, notes, browser, Codex images
```

- **Hub** (`apps/server`): source of truth. Every change gets a sequence number; clients catch up from a cursor.
- **Connector** (`apps/connector`): pairs with the hub like a device, registers agents and runs them as child processes. Its policy decides every tool call: allow, ask you, or block.
- **Clients**: one Expo codebase (`apps/client`) for Android and web; Electron (`apps/desktop`) wraps the web build. Shared types in `packages/protocol`, sync engine in `packages/sync-client`.

More: [docs/OVERVIEW.md](docs/OVERVIEW.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status and direction

HomeBase is early and self-hosted only. It works day to day for its author; expect rough edges.

- **Today**: hub and connector on your own Linux or Windows machine (macOS is untested); web client and Windows desktop installer; the Android app builds from source and can be sideloaded.
- **Coming**: Android and iOS apps in the stores (the mobile app is not released yet), signed desktop installers, push notifications, more agents.
- **Later**: an optional hosted version.

## Quick start (local)

Prerequisites: Node 24.3+ and npm 11. For the Claude agent, [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and logged in on the same machine (`claude auth status`). Git, if you want to contribute.

```
git clone <this repo> homebase && cd homebase
npm install
npm run dev
```

`npm run dev` starts the **hub** on `http://127.0.0.1:8787` (it creates `data/homebase.db` with an empty workspace and prints a device pairing code), the **connector** (it pairs itself on first run), and the **web client** on `http://localhost:8081`. Open the web client and enter the pairing code. Each further device needs its own code: **Settings → Devices** in a paired app, or `npm run pair-code`.

To try the app with invented sample sessions, inbox items, notes and two scripted agents, start with `HOMEBASE_DEMO=1` on a fresh `data/` folder; `npm run remove-demo` takes the sample content out again (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md#demo-content)).

To start fresh, stop everything and delete `data/` and `apps/connector/.connector.json`.

## Running it for real

- **Server (hub + connector)**: [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) covers installing on an always-on Linux box with systemd, reaching it over Tailscale or SSH, HTTPS, backups and updates.
- **Pair a device**: on the server, `npm run pair-code` prints a single-use code (10 minutes). Enter the hub's address and the code in the app.
- **Desktop installer (Windows)**: `npm run desktop:dist` builds `dist-desktop/HomeBase-Setup-<version>.exe` (unsigned, per-user; the first build after `npm install` downloads the Electron binary). On first run it asks how to reach the hub: **Via SSH** (it runs its own tunnel with your `~/.ssh/config`) or **Direct** (an address it can reach, e.g. over Tailscale).
- **Android (sideload)**: `npm run android -- --release --hub-url http://<your-server>:8787` builds `dist-apk/HomeBase.apk`, debug-signed.
- **Agents**: [docs/AGENTS.md](docs/AGENTS.md) (Claude agent, modes, Comms/Gmail, Notes), [docs/GMAIL-SETUP.md](docs/GMAIL-SETUP.md).

## Configuration

Everything deployment-specific is configuration with a neutral default: server settings in `~/.config/homebase/homebase.env` (see [scripts/server/homebase.env.example](scripts/server/homebase.env.example)), the Claude agent in `claude-agent.json`, and build settings (app id, publisher) in an untracked `.env.local` (see [.env.example](.env.example)). Reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Claude runs only through the official CLI on the machine's own login. HomeBase never asks for, stores or forwards Claude credentials, strips `ANTHROPIC_*` variables from agent runs, and never uses `--dangerously-skip-permissions`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm install` sets up git hooks that scan every commit and push for secrets and personal data. Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 John Kotash

AGPL-3.0, see [LICENSE](LICENSE). If you run a modified version of HomeBase as a network service for others, you must offer those users the source code of your version.
