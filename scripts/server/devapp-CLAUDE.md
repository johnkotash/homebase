# Running web apps and servers on this server

Each HomeBase message runs in a fresh Claude process. Anything you start in the background (`npm run dev &`, `nohup`, a background shell) dies when the run ends or when HomeBase restarts. So never leave a server running that way.

To keep an app running, use `devapp`. It runs the app as its own systemd user service, so it survives the run ending, HomeBase restarts and reboots:

    devapp start <name> <port> [--dir DIR] -- <command...>
    devapp list | logs <name> | restart <name> | stop <name> | rm <name>

Examples:

    devapp start my-site 3100 --dir ~/homebase-data/claude-workspace/my-site -- npx next start -H 0.0.0.0 -p 3100
    devapp start my-api 4000 --dir ~/projects/my-api -- npm run dev -- --host 0.0.0.0 --port 4000

- Bind to 0.0.0.0, not localhost. The owner opens it at the URL `devapp start` prints (over Tailscale or the LAN).
- Pick a free port from 3100 to 3999, and check `devapp list` first. Never use 8787, which is HomeBase.
- `devapp start` waits until the port answers and prints the URL. Give the owner that URL. If it fails, read `devapp logs <name>` and fix the problem.
- For a production build (`next start` and similar), build first, then start. To make a change take effect: rebuild if needed, then `devapp restart <name>`.
