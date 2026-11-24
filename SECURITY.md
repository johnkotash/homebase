# Security policy

HomeBase runs AI agents with access to files, a shell, email and a browser on machines you own, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting for this repository: the **Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it, and the impact you expect. You will get an answer as soon as the maintainer can; please allow time for a fix before any disclosure.

In scope, for example: a way around the connector's approval policy or permission modes, reading secret files through an agent, prompt injection from email or web pages that leads to an action without approval, hub authentication or pairing flaws, cross-device token leaks, the agent browser reaching local or private-network addresses.

## Supported versions

Only the latest commit on `main` is supported while HomeBase is pre-1.0.

## Running it safely

- Keep the hub on loopback or a private address (Tailscale), never the open internet; it speaks plain HTTP unless you put `tailscale serve` or another TLS proxy in front.
- Use Auto mode only in workspaces whose scripts you trust: it is a permission policy, not a sandbox.
- Keep OAuth client files, tokens and backup keys in `~/homebase-data/secrets` or `~/.config/homebase` with restrictive permissions, never in the repository.
