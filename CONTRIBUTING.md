# Contributing to HomeBase

Thanks for helping. HomeBase is early, so please open an issue to discuss anything larger than a small fix before you write it.

## Setup

```
npm install        # also points git at .githooks (secret scan on commit and push)
npm run dev        # hub + connector + web client; see README.md
```

Node 24.3+ and npm 11. For the Claude agent, Claude Code installed and logged in. Android builds need JDK 21 and the Android SDK; on Windows `scripts/android.mjs` mirrors the native build to a short folder (`HB_BUILD_DIR`, default `C:\hb`) because of the 260-character path limit.

## Before you open a pull request

```
npm run scan
npm test
npm run typecheck
```

CI runs the same, plus gitleaks over the full history.

- **No secrets and no personal data**, ever: no keys or tokens, no real names, emails, hosts, IPs, usernames or home paths, no real email or note content in fixtures. Use invented data on `example.com` / `.test` domains. The hooks block common cases; a genuine false positive gets a `scan-allow` comment explaining why.
- **Configuration, not constants**: anything specific to one deployment is an environment variable or config field with a neutral default, documented in `docs/CONFIGURATION.md` and covered by a test.
- **Tests**: add or update tests next to the code (`<workspace>/test`). Agents and the Gmail API have local fakes; tests never touch a real account, vault or network service.
- **Docs**: keep them short; fix the doc your change makes wrong in the same pull request.
- Keep the product's safety rules intact (see `CLAUDE.md`): approvals through the connector's policy, no permission-skipping flags, Gmail read + compose only, append-only notes.

## Personal denylist (optional, recommended)

To keep your own private strings (your hostname, email, client names) out of commits without writing them into the repo, list them in `~/.config/homebase/denylist.txt`, one per line (plain text, case-insensitive whole word, or `/regex/`). The scanner also reads `.git/hooks-denylist` and the `HOMEBASE_DENYLIST_FILE` / `HOMEBASE_DENYLIST` variables.

## License

By contributing you agree that your contribution is licensed under the AGPL-3.0, the license of this repository.
