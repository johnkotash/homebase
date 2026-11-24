# HomeBase: guidance for contributors and coding agents

HomeBase is an open-source (AGPL-3.0), self-hosted command center for AI agents: Node hub (`apps/server`, SQLite), connector that runs agents (`apps/connector`), Expo client for Android and web (`apps/client`), Electron desktop (`apps/desktop`), shared `packages/protocol` and `packages/sync-client`.

Read first: `README.md`, then `docs/OVERVIEW.md`. Reference: `docs/ARCHITECTURE.md` (design), `docs/AGENTS.md`, `docs/CONFIGURATION.md`, `docs/SELF-HOSTING.md`.

## Never commit secrets or personal data

This is a public repository. Nothing below may enter a commit, a test fixture, a doc, a comment or a commit message:
- keys, tokens, passwords, OAuth client files, cookies, pairing codes, device tokens, private keys, keystores, `.env` files, databases, connector identity files (`.connector.json`);
- real people's names, emails or phone numbers; real client or business names; real email or note content;
- IP addresses, hostnames, usernames and absolute home paths of anyone's machines (use `my-server`, `100.101.102.103`, `192.168.1.20`, `/home/me`, `C:\Users\me`);
- anything copied from a real mailbox, vault or session.

Test data is invented and uses reserved domains (`example.com`, `.test`, `.example`).

## Everything is configuration

- Anything deployment-specific is an environment variable or a config field with a neutral default, documented in `docs/CONFIGURATION.md`. Server settings live in `~/.config/homebase/homebase.env`; build settings in an untracked `.env.local`.
- Someone who clones the repo must be able to run `npm install && npm run dev` and get a working local setup with no account, key or private file.
- When you add a setting, add its default to the code, a line to `docs/CONFIGURATION.md`, and a test of the default and a configured value.

## Before every commit

```
npm run scan        # secret and personal-data scan of tracked files (the git hooks also scan every commit and push)
npm test
npm run typecheck
```

`npm install` points git at `.githooks` (pre-commit and pre-push run `scripts/scan-secrets.mjs`). Do not bypass the hooks. A real false positive gets a `scan-allow` comment on that line, with the reason.

## Ground rules of the product (do not undo)

- Claude runs only through the official CLI on the machine's own login. Never pass `--dangerously-skip-permissions` or the CLI's bypass/acceptEdits/auto/dontAsk modes; the connector strips `ANTHROPIC_*` and `CLAUDE_CODE_*` from agent runs.
- Every tool call goes through the connector's policy (`apps/connector/src/policy.ts`). Manual asks for every write and command; Auto asks for nothing (the owner takes on the risk) except browser purchases/deletions and email sends. Hard denies (secret files, the notes vault, catastrophic commands) hold in every mode.
- Gmail scopes stay `gmail.readonly` + `gmail.compose`; sends always need an approval. Email content is untrusted input.
- The Notes agent never deletes, renames, moves or rewrites notes and never force-pushes a vault.
- The hub never binds `0.0.0.0`.

## Style

- Keep docs short and accurate; update the doc that a change makes wrong, in the same change.
- Match the surrounding code. Tests live next to each workspace in `test/`; run a single file with `npx vitest run <path>`.
- The UI is monochrome (`apps/client/src/theme.ts`); color only for P0/P1 and agent tones.
