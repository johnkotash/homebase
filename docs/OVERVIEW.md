# HomeBase overview

What HomeBase is and how the pieces connect, in a few minutes. Running it: [SELF-HOSTING.md](SELF-HOSTING.md). Agents: [AGENTS.md](AGENTS.md). Full design: [ARCHITECTURE.md](ARCHITECTURE.md).

## What it is

A self-hosted command center for running work through AI agents. The phone (or a browser, or the desktop app) is where you:
- talk to agents by voice or text, in sessions grouped into projects;
- approve what they want to do, with Manual / Auto / Plan modes;
- triage one inbox of things that need attention, each on an SLA clock;
- read and dictate notes.

Every device shows the same data, kept in sync in real time.

## How it fits together

```
  Phone (Expo Android)    Browser    Desktop (Electron)
          \                  |              /
           \         WebSocket + HTTP      /        over Tailscale, or an SSH tunnel
            +------------- Hub ------------+
            |  Hono + ws + SQLite: change log (seq), devices, approvals, audit log
            +--------------+---------------+
                           | outbound WebSocket
                      Connector
                      - runs agents as child processes
                      - policy: Manual / Auto / Plan, risk rules
                      - Gmail service (read + drafts, sends gated)
                      - vault service (Obsidian notes, git commits)
                      - agent browser, image generation
                           |
                 claude CLI (the machine's own login) + per-agent MCP servers
```

- **Hub** (`apps/server`): source of truth for app data. Every change gets a sequence number; clients send changes from an outbox and catch up from a cursor (0 means a full snapshot). Sync code: `packages/sync-client`; shared types: `packages/protocol`.
- **Connector** (`apps/connector`): pairs with the hub like a device, registers agents and runs them. Each Claude agent is `claude -p` in stream-json mode with its own working directory, its own tools and an MCP permission-prompt tool, so every tool call is decided by HomeBase's policy and anything risky becomes an approval card.
- **Clients** (`apps/client`, `apps/desktop`): one Expo codebase for Android and web; Electron wraps the web build, so every surface has the same screens. Monochrome UI, color only for P0/P1 and for the few tones an agent may give its own words.
- **First start**: the hub creates an empty workspace (owner, SLA policies, neutral settings). `HOMEBASE_DEMO=1` adds invented sample content instead; `npm run remove-demo` takes it out again ([CONFIGURATION.md](CONFIGURATION.md#demo-content)).
- **Sessions and projects**: a session is a chat with an agent that resumes where it stopped; it is filed in a project or sits in Unsorted. The hub keeps each session's latest run status, a one-line digest and the owner's "where I left off" note. Rules: `packages/protocol/src/sessions.ts`.

## Ground rules

- Claude runs only through the official CLI on the connector machine's own login. No API keys by default, never `--dangerously-skip-permissions`.
- Email is untrusted input; sends always need an approval. Gmail scopes stay read + compose.
- The Notes agent never deletes, renames, moves or rewrites notes, and never force-pushes the vault.
- Nothing about one deployment lives in the code: see [CONFIGURATION.md](CONFIGURATION.md).
