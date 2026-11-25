#!/usr/bin/env node
// HomeBase connector daemon. Dials the hub (outbound only), registers its agents and runs them.
//   npm run dev:connector -- --hub http://127.0.0.1:8787 --pair ABCD-EFGH --name proxmox-dev-01
import "./env";
import { resolve } from "node:path";
import { ApprovalServer, decidePermission } from "./adapters/claude-approvals";
import { BackupMonitor } from "./backup-health";
import { JobWatcher } from "./jobs";
import { buildAuthProof, checkClaude, createClaudeCodeAdapter, type ClaudeReadiness, type ClaudeRunFacts } from "./adapters/claude-code";
import { createMockAdapter } from "./adapters/mock";
import { BrowserService, mergeExtraMcp } from "./browser/service";
import {
  APPROVED_FOLDERS_PATH, CLAUDE_AUTH_LABEL, CONFIG_PATH, devPairingCode, forget, loadClaudeConfig, loadSaved, mockAgents, modelFacts, parseArgs, privatePaths, save, type SavedConfig,
} from "./config";
import { FolderService } from "./folders";
import { FileService } from "./files";
import { TerminalService } from "./terminal";
import { CommsAgent } from "./gmail/comms";
import { ImageStudio } from "./images/studio";
import { expandHome } from "./config";
import { HubLink, type AgentDef } from "./HubLink";
import { ATTACHMENT_CAPABILITY, FILES_CAPABILITY, TERMINAL_CAPABILITY } from "@homebase/protocol";
import { protectRoot, protectedRoots } from "./policy";
import { NotesAgent } from "./vault/agent";

const args = parseArgs(process.argv.slice(2));
const log = (...a: unknown[]) => console.log("[connector]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pair(): Promise<SavedConfig> {
  for (let attempt = 0; ; attempt++) {
    const code = args.pair ?? devPairingCode();
    if (!code) {
      if (attempt === 0) log("waiting for a pairing code (pass --pair <code>, set HB_PAIR_CODE, or start the hub in dev mode)...");
    } else {
      try {
        const res = await fetch(`${args.hub}/v1/pair`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, kind: "connector", name: args.name, platform: process.platform }),
        });
        const json: any = await res.json();
        if (res.ok) {
          const cfg = { hub: args.hub, token: json.token, connectorId: json.deviceId, name: args.name };
          save(cfg);
          log(`paired as ${cfg.connectorId}; token saved to ${CONFIG_PATH}`);
          return cfg;
        }
        if (args.pair) {
          console.error(`[connector] pairing failed: ${json?.error?.message ?? res.status}`);
          process.exit(1);
        }
        if (attempt % 10 === 0) log(`pairing not accepted yet (${json?.error?.message ?? res.status}); retrying`);
      } catch {
        if (attempt % 10 === 0) log(`hub not reachable at ${args.hub}; retrying`);
      }
    }
    if (attempt > 150) {
      console.error("[connector] gave up pairing after 5 minutes");
      process.exit(1);
    }
    await sleep(2000);
  }
}

async function main() {
  let cfg = loadSaved();
  if (cfg && cfg.hub !== args.hub && process.argv.includes("--hub")) cfg = null;
  if (!cfg || args.pair) cfg = await pair();

  // The scripted Dev and Site ops agents register only in demo mode (HOMEBASE_DEMO=1).
  const demoAgents = mockAgents();
  const mock = demoAgents.length ? createMockAdapter({ speed: args.speed }) : null;
  const agents: AgentDef[] = demoAgents.map((a) => ({ ...a, adapter: mock! }));
  if (demoAgents.length) log(`demo mode: registering the mock agents ${demoAgents.map((a) => a.key).join(", ")}`);

  // The Claude agent (ARCHITECTURE.md 6.4): the official Claude Code CLI under this machine's own login.
  const claude = loadClaudeConfig();
  let readiness: ClaudeReadiness | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  const approvals = new ApprovalServer();
  let lastRun: ClaudeRunFacts | null = null;
  let proofSentAt = 0;
  // Images in the Claude agent's sessions: OpenAI through the Codex CLI, and Claude's own SVGs (docs/MULTI-PROVIDER-PLAN.md).
  let studio: ImageStudio | null = null;
  // The browser for the Claude agent (docs/BROWSER-AGENT-PLAN.md): a Chrome with a profile of its own, gated here and watched from the app.
  let browser: BrowserService | null = null;
  // Folders for the Claude agent (ARCHITECTURE.md 6.6): this machine's allowlist, and the folder browser behind the app's picker.
  // The config file's sandbox, projectDirs and addDirs are in it as before; folders approved from the app are kept beside it.
  const folders = new FolderService({
    config: claude, storePath: APPROVED_FOLDERS_PATH, privatePaths: privatePaths(), protectedRoots, host: args.name, log,
    // The agent's registration lists what is approved, so every device sees a new folder right away.
    onChange: () => link?.updateAgent(claude.key, { workspaces: folders.workspaces(), folders: folders.facts() }),
  });
  // Files, the editor and the terminal for the owner (issue #3): this machine, as this user. HB_FILES / HB_TERMINAL turn them off.
  const terminal = new TerminalService({ log });
  const files = new FileService({
    host: args.name, protectedRoots, log, terminal: () => terminal.available,
    workspaces: () => (claude.enabled ? folders.approved().filter((f) => !f.missing).map((f) => ({ label: f.label, path: f.path })) : []),
  });
  log(`files for the owner: ${files.enabled ? "on" : "off"}; terminal: ${terminal.available ? "on" : "off"}`);
  /** Sends the agent's current note and auth facts to the hub. */
  const publish = () => {
    proofSentAt = Date.now();
    if (claude.enabled) link?.updateAgent(claude.key, { statusNote: readiness?.note ?? null, auth: buildAuthProof(claude, readiness, lastRun), ...(studio ? { images: studio.facts() } : {}) });
    if (comms) link?.updateAgent(comms.config.key, comms.registration());
    if (notes) link?.updateAgent(notes.config.key, notes.registration());
  };
  let comms: CommsAgent | null = null;
  let notes: NotesAgent | null = null;
  const refresh = async () => {
    const before = readiness;
    readiness = await checkClaude(claude);
    comms?.setCli(readiness);
    notes?.setCli(readiness);
    const changed = before?.note !== readiness.note || before?.version !== readiness.version;
    // The check runs every minute; the "last check" time in the app moves every ten, to keep the change log quiet.
    if (link && (changed || Date.now() - proofSentAt > 10 * 60_000)) publish();
    if (link && before?.note !== readiness.note) log(readiness.ok ? "Claude agent is ready" : `Claude agent is not ready: ${readiness.note}`);
    return readiness;
  };
  let link: HubLink | null = null;
  // Backup alerts (CONFIGURATION.md): watches backup.sh's status file, when there is one, and raises P1 inbox items.
  const backups = new BackupMonitor({ emit: (item) => link?.ingestInbox(item) ?? false, log });
  // Background jobs (AGENTS.md): when a job an agent started with hbjob ends, the hub wakes its session to report.
  const jobs = new JobWatcher({ emit: (job) => link?.sendJobDone(job) ?? false, log });
  if (backups.enabled) log(`backup alerts: watching ${backups.config.statusFile} every ${backups.config.checkMs / 60_000} min (${backups.config.mode})`);
  if (claude.enabled) {
    readiness = await checkClaude(claude);
    if (claude.auth === "subscription" && process.env.ANTHROPIC_API_KEY) {
      log("ANTHROPIC_API_KEY is set; it is removed from the Claude agent's environment so runs use the Claude Code login, not API billing.");
    }
    log(readiness.ok
      ? `Claude agent ready: Claude Code ${readiness.version ?? "?"}, model ${claude.model}, auth ${CLAUDE_AUTH_LABEL[claude.auth]}, sandbox ${claude.sandboxDir}`
      : `Claude agent registered but not ready: ${readiness.note}`);
    if (process.env.HB_IMAGES !== "0") {
      const hub = cfg;
      studio = new ImageStudio({
        dataDir: resolve(expandHome(process.env.HOMEBASE_DATA_DIR ?? process.env.DATA_DIR ?? resolve(claude.sandboxDir, ".."))),
        hub: () => ({ url: hub.hub, token: hub.token }), host: args.name, log, claudeModel: claude.model,
        onChange: () => publish(),
      });
      // Asks the Codex CLI whether it is installed and signed in. A machine without it still gets Claude's own graphics.
      await studio.start();
    }
    if (process.env.HB_BROWSER !== "0") {
      const hub = cfg;
      browser = new BrowserService({
        dataDir: resolve(expandHome(process.env.HOMEBASE_DATA_DIR ?? process.env.DATA_DIR ?? resolve(claude.sandboxDir, ".."))),
        hub: () => ({ url: hub.hub, token: hub.token }), log,
      });
      log(browser.available ? `Browser for agents ready: ${browser.exe}, profile ${browser.profileDir}` : "Browser for agents: no browser found on this machine (set HB_BROWSER_EXE)");
    }
    // Offered only when this machine has a browser to run.
    const web = browser?.available ? browser : null;
    const images = studio;
    agents.push({
      key: claude.key, name: claude.name, kind: "claude",
      description: `Claude, running on this machine under ${claude.auth === "subscription" ? "your own Claude Code login" : "an API key"}. Works in a sandbox folder or an allowlisted project. In Manual mode every edit and command waits for your approval${claude.modes.includes("auto") ? "; in Auto it works end to end without asking (secrets and the notes vault stay off limits)" : ""}.`,
      // ATTACHMENT_CAPABILITY: pictures the owner attaches reach Claude as image content blocks on the stream-json input.
      capabilities: ["code", "files", "shell", "web", ATTACHMENT_CAPABILITY, ...(images ? ["images"] : []), ...(web ? web.capabilities : []), `model:${claude.model}`],
      workspaces: folders.workspaces(),
      folders: folders.facts(),
      permissionProfile: claude.permissionProfile,
      statusNote: readiness.note,
      modes: claude.modes,
      ...modelFacts(claude),
      auth: buildAuthProof(claude, readiness, lastRun),
      ...(images ? { images: images.facts() } : {}),
      adapter: (images ? (a: ReturnType<typeof createClaudeCodeAdapter>) => images.wrap(a) : (a: ReturnType<typeof createClaudeCodeAdapter>) => a)(createClaudeCodeAdapter({
        config: claude, approvals, log, folders,
        // The image tools are routed and capped inside the studio; every other tool goes through the usual policy.
        ...(images ? { decide: images.decide, extraMcp: images.extraMcp } : {}),
        // The browser's tools sit beside whatever else the agent has. They are gated inside the browser service, for any provider.
        ...(web ? { decide: web.decideWith(images ? images.decide : decidePermission), extraMcp: mergeExtraMcp(images?.extraMcp, web.extraMcp), redactToolOutput: web.redact } : {}),
        onRunFacts: (facts) => {
          lastRun = facts;
          publish();
        },
        // Re-check before a run when the last answer is bad or older than a minute.
        readiness: async () => (readiness && readiness.ok && Date.now() - readiness.checkedAt < 60_000 ? readiness : refresh()),
      })),
    });
    poll = setInterval(() => void refresh(), 60_000);
    poll.unref();

    // The Comms agent (ARCHITECTURE.md 8.4): the same CLI, with only the Gmail tools and read access to its own folder.
    if (process.env.HB_COMMS !== "0") {
      comms = new CommsAgent({
        base: claude, approvals, log,
        cliReadiness: async () => (readiness && readiness.ok && Date.now() - readiness.checkedAt < 60_000 ? readiness : refresh()),
        emitInbox: (item) => link?.ingestInbox(item) ?? false,
        onChange: () => {
          if (link && comms) link.updateAgent(comms.config.key, comms.registration());
        },
      });
      comms.setCli(readiness);
      await comms.start();
      log(comms.status.connected ? `Comms agent ready: Gmail connected as ${comms.status.account}, sandbox ${comms.config.sandboxDir}` : `Comms agent registered but not ready: ${comms.note}`);
      agents.push({ ...comms.registration(), adapter: comms.adapter });
    }

    // The Notes agent (NOTES-PLAN.md 8): the same CLI, with read-only built-ins and the vault tools, working in the Obsidian vault.
    if (process.env.HB_NOTES !== "0") {
      notes = new NotesAgent({
        base: claude, approvals, log,
        cliReadiness: async () => (readiness && readiness.ok && Date.now() - readiness.checkedAt < 60_000 ? readiness : refresh()),
        emitIndex: (frame) => link?.sendVaultIndex(frame) ?? false,
        onChange: () => {
          if (link && notes) link.updateAgent(notes.config.key, notes.registration());
        },
      });
      notes.setCli(readiness);
      // No other agent may read, write or run commands in the vault; only the Notes agent reaches it, through the vault service.
      protectRoot(notes.git?.root ?? notes.vaultRoot);
      await notes.start();
      protectRoot(notes.git?.root ?? notes.vaultRoot);
      log(notes.service ? `Notes agent ready: vault ${notes.vaultRoot}, ${notes.service.size} notes, time zone ${notes.tz}` : `Notes agent registered but not ready: ${notes.note}`);
      agents.push({ ...notes.registration(), adapter: notes.adapter });
    }
  }

  link = new HubLink({
    hubUrl: cfg.hub, token: cfg.token, name: cfg.name, log,
    agents,
    onReady: () => {
      notes?.sendFullIndex();
      try {
        backups.check();
      } catch (err) {
        log("backup alerts:", (err as Error).message);
      }
      browser?.onReady();
    },
    onBrowser: (frame) => browser?.onHubFrame(frame),
    hostCapabilities: [...(files.enabled ? [FILES_CAPABILITY] : []), ...(terminal.available ? [TERMINAL_CAPABILITY] : [])],
    onFilesRequest: (op, fargs) => files.handle(op, fargs),
    onTerminal: (frame) => terminal.onFrame(frame),
    // The hub forgets this connector's terminals when the link drops, so the shells end with it.
    onDisconnect: () => terminal.closeAll(),
    onVaultRequest: (op, args) => (notes ? notes.handleRequest(op, args) : Promise.reject(new Error("This connector has no vault."))),
    onFoldersRequest: (agentKey, op, fargs, meta) =>
      claude.enabled && agentKey === claude.key ? folders.handle(op, fargs, meta) : Promise.reject(Object.assign(new Error("This agent does not take folders."), { code: "unsupported" })),
    onUnauthorized: async () => {
      // Revoked, or the hub database was recreated. Forget the token and pair again.
      forget();
      link?.stop();
      if (poll) clearInterval(poll);
      backups.stop();
      jobs.stop();
      void approvals.stop();
      void comms?.stop();
      void notes?.stop();
      void studio?.stop();
      void browser?.stop();
      if (args.pair) {
        console.error("[connector] token rejected. Run again with a new --pair code.");
        process.exit(1);
      }
      log("token rejected; pairing again");
      await sleep(1500);
      main();
    },
  });
  browser?.attach((frame) => link?.sendBrowser(frame) ?? false);
  terminal.attach((frame) => link?.sendTerminal(frame) ?? false);
  link.start();
  backups.start();
  jobs.start();
  const stop = () => {
    link?.stop();
    terminal.closeAll();
    // The browser is a child of this process: close it with the connector.
    void browser?.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main();
