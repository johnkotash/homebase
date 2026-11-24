import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { CLAUDE_AUTH_LABEL, claudeModels, claudeWorkspaces, type ClaudeAgentConfig, type ClaudeAuthMode } from "../config";
import {
  AGENT_MARKUP_NOTE, EFFORT_LABEL, Effort as EffortSchema, ModelName, attachmentsSummary, modelLabel, sameModel, sniffImage,
  type AgentAuthProof, type Effort, type MessageAttachment,
} from "@homebase/protocol";
import type { PermissionMode, PermissionProfile, Verdict } from "../policy";
import { ApprovalServer, PERMISSION_PROMPT_TOOL, PLAN_TOOL, handlePermission, isInside, type PermissionEnv } from "./claude-approvals";
import { ClaudeStreamMapper, LineBuffer, type MappedAction } from "./claude-stream";
import type { AgentAdapter, RunContext, RunHandle } from "./types";
import { editDenyRule, type RunFolders } from "../folders";

/**
 * The Claude agent: one official Claude Code CLI process per run, in headless print mode with
 * streaming JSON on both pipes (ARCHITECTURE.md 6.4).
 *
 * Auth is whatever the CLI already has on this machine. In "subscription" mode that is the owner's
 * own Claude Code login. This file never opens, copies or logs the CLI's credential files; it only
 * makes sure no API key or foreign endpoint leaks into the child's environment, so a run cannot
 * quietly switch to API billing.
 */

// ---------------------------------------------------------------- environment

/** Variables that would change who pays or where requests go, or that mark a host Claude session. */
const CLAUDE_ENV = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|AWS_BEARER_TOKEN_BEDROCK$)/i;
/** Machine setup the CLI still needs. */
const KEEP_ENV = new Set(["CLAUDE_CODE_GIT_BASH_PATH"]);
/** How long the CLI waits on the approval tool. Approvals have no timeout on the HomeBase side. */
const APPROVAL_WAIT_MS = 24 * 3_600_000;

/** The same rule as CLAUDE_ENV, in words, for the auth view in the app. Names only. */
export const STRIPPED_PATTERNS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_*", "CLAUDE_CODE_*", "CLAUDE_AGENT_SDK_*", "AWS_BEARER_TOKEN_BEDROCK"];

export function buildChildEnv(base: NodeJS.ProcessEnv, auth: ClaudeAuthMode): { env: NodeJS.ProcessEnv; apiKeyStripped: boolean; stripped: number } {
  const env: NodeJS.ProcessEnv = {};
  let apiKeyStripped = false;
  let stripped = 0;
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const name = k.toUpperCase();
    if (CLAUDE_ENV.test(name) && !KEEP_ENV.has(name)) {
      if (name === "ANTHROPIC_API_KEY") {
        if (auth === "api_key") {
          env[k] = v;
          continue;
        }
        apiKeyStripped = true;
      }
      stripped++;
      continue;
    }
    env[k] = v;
  }
  env.MCP_TOOL_TIMEOUT = String(APPROVAL_WAIT_MS);
  return { env, apiKeyStripped, stripped };
}

// ---------------------------------------------------------------- command line

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_NOTE =
  "You are running as the owner's HomeBase agent. The owner reads your replies on a phone, so keep them short. " +
  "Some tool calls are approved or denied by the owner from the HomeBase app; if one is denied or blocked, do not work around it. " +
  "Each message runs in a fresh process, so anything you start in the background (a dev server, `&`, nohup) dies when the run ends. " +
  "To keep a web app or server running, use `devapp start <name> <port> [--dir DIR] -- <command>` (also `devapp list|logs|restart|stop|rm <name>`): " +
  "it runs as its own service that survives runs, HomeBase restarts and reboots. Bind to 0.0.0.0, use a free port in 3100-3999 (never 8787), " +
  "and give the owner the URL that devapp prints.";

/**
 * What is appended to the CLI's system prompt: the agent's own note (the general one above, or the Comms
 * or Notes agent's), then how HomeBase renders replies, including the toned text the agent may use
 * (:critical[...], :warning[...], :success[...], :info[...]). Every Claude agent gets the second part.
 *
 * It is passed on every run, but Claude Code 2.1.319 records a conversation's system prompt at its first
 * request and reuses that record on every resume (`--system-prompt-snapshot`, on by default) until the
 * conversation is compacted. So a session started before a change to this text keeps the old text for a
 * while; new sessions, and a session given a fresh agent session, get the new one at once.
 */
export const systemPromptFor = (cfg: Pick<ClaudeAgentConfig, "systemPrompt">) => `${cfg.systemPrompt ?? SYSTEM_NOTE}

${AGENT_MARKUP_NOTE}`;

/** Secrets the agent must not read even inside a working directory, where the CLI would not prompt. */
const DENY_RULES = ["Read(~/.claude/**)", "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(**/.env)", "Read(**/.env.*)"];

const MODE_LABEL: Record<PermissionMode, string> = { manual: "Manual", auto: "Auto", plan: "Plan" };

/**
 * The CLI's own permission mode for a HomeBase mode. Manual and Auto both run the CLI in its default
 * (ask) mode, so every write and command reaches the approval tool and HomeBase's policy decides; the
 * CLI's acceptEdits/auto/dontAsk modes are not used because they decide without it. Plan uses the CLI's
 * plan mode, which keeps the agent read-only until ExitPlanMode is allowed.
 */
export const cliPermissionMode = (mode: PermissionMode) => (mode === "plan" ? "plan" : "default");

/**
 * Where the CLI keeps its plan file during a plan run, relative to the working directory. Its default is
 * ~/.claude/plans, which the secret-read rules below (rightly) put off limits, and a plan that cannot be
 * written arrives empty. The folder is removed as soon as the plan is approved or the run ends.
 */
export const PLANS_DIR = ".homebase/plans";

export function removePlanFiles(cwd: string) {
  try {
    rmSync(join(cwd, ...PLANS_DIR.split("/")), { recursive: true, force: true });
    rmdirSync(join(cwd, PLANS_DIR.split("/")[0])); // only when nothing else is in it
  } catch {
    // not empty, or never created
  }
}

/**
 * The model and effort one run uses: what the hub asked for when this connector offers it, else the
 * agent's own configuration. `refused` names what was asked for and not allowed here, for the timeline.
 * Both values end up as single command-line words (`--model`, `--effort`): they are checked for shape.
 */
export function pickModel(cfg: Pick<ClaudeAgentConfig, "model" | "models" | "effort">, asked: { model?: unknown; effort?: unknown } = {}): { model: string; effort: Effort | null; refused: string[] } {
  const refused: string[] = [];
  let model = cfg.model;
  if (asked.model != null) {
    const p = ModelName.safeParse(asked.model);
    const hit = p.success ? claudeModels(cfg).find((m) => sameModel(m, p.data)) : undefined;
    if (hit) model = sameModel(hit, cfg.model) ? cfg.model : hit;
    else refused.push(`model ${String(asked.model).slice(0, 80)}`);
  }
  let effort: Effort | null = cfg.effort ?? null;
  if (asked.effort != null) {
    const p = EffortSchema.safeParse(asked.effort);
    if (p.success) effort = p.data;
    else refused.push(`effort ${String(asked.effort).slice(0, 20)}`);
  }
  return { model, effort, refused };
}

export function buildArgs(
  cfg: ClaudeAgentConfig,
  o: {
    resume: string | null; mcpConfig: string; maxTurns?: number; mode?: PermissionMode; model?: string; effort?: Effort | null;
    /** This run's extra folders (--add-dir). Left out: the config file's addDirs, as before. */
    addDirs?: string[];
    /** The extra folders that are read-only: the CLI is also told to deny file edits in them. */
    readOnlyDirs?: string[];
  },
): string[] {
  const plan = o.mode === "plan";
  const tools = plan && !cfg.tools.includes(PLAN_TOOL) ? [...cfg.tools, PLAN_TOOL] : cfg.tools;
  const effort = o.effort === undefined ? cfg.effort ?? null : o.effort;
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Per launch, so a resumed session can run on another model or effort than its last turn did.
    "--model", o.model ?? cfg.model,
    // No effort chosen anywhere: the flag is left out and the CLI uses its own default, as before.
    ...(effort ? ["--effort", effort] : []),
    "--max-turns", String(o.maxTurns ?? cfg.maxTurns),
    // Never bypassPermissions / --dangerously-skip-permissions: every prompt goes to the approval tool.
    "--permission-mode", cliPermissionMode(o.mode ?? "manual"),
    "--permission-prompt-tool", PERMISSION_PROMPT_TOOL,
    "--mcp-config", o.mcpConfig,
    "--strict-mcp-config",
    "--setting-sources", cfg.settingSources,
    "--disable-slash-commands",
    "--tools", tools.join(","),
    // --add-dir has no read-only form: it gives the file tools reach for reading and writing. So for a folder that was
    // added read-only the CLI gets a deny rule for edits there as well. A deny rule wins over any allow rule, including
    // one in a project's own settings; the connector's check at the approval tool is the other half.
    "--disallowedTools", ...DENY_RULES, ...(cfg.extraDisallowed ?? []), ...(o.readOnlyDirs ?? []).map(editDenyRule),
    "--append-system-prompt", systemPromptFor(cfg),
  ];
  const settings = { ...(cfg.settings ?? {}), ...(plan ? { plansDirectory: PLANS_DIR } : {}) };
  if (Object.keys(settings).length) args.push("--settings", JSON.stringify(settings));
  const addDirs = o.addDirs ?? cfg.addDirs;
  if (addDirs.length) args.push("--add-dir", ...addDirs);
  if (o.resume && UUID.test(o.resume)) args.push("--resume", o.resume);
  return args;
}

/** The run's working directory, or null when the request is outside the connector's allowlist. */
export function resolveCwd(cfg: ClaudeAgentConfig, requested: string | null): string | null {
  const allowed = claudeWorkspaces(cfg).map((w) => resolve(w.cwd));
  if (!requested) return allowed[0];
  const want = resolve(requested);
  return allowed.find((a) => isInside(want, a) && isInside(a, want)) ?? null;
}

/** Finds the executable without a shell. Returns null when it is not installed. */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (/[\\/]/.test(command)) return existsSync(command) ? command : null;
  const win = process.platform === "win32";
  const names = win ? [`${command}.exe`, command] : [command];
  const dirs = [...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin")];
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

// ---------------------------------------------------------------- readiness

/** What a run's first CLI message says about who is paying for it. Facts only. */
export interface ClaudeRunFacts {
  apiKeySource: string | null;
  model: string | null;
  at: number;
}

/**
 * The auth view for the app: how the agent authenticates, as far as the connector can see. Built from
 * the config, the readiness check and the last run's init message. It never contains a token, an
 * account or anything read from a credential file.
 */
export function buildAuthProof(cfg: ClaudeAgentConfig, readiness: ClaudeReadiness | null, last: ClaudeRunFacts | null, baseEnv: NodeJS.ProcessEnv = process.env): AgentAuthProof {
  return {
    authMode: cfg.auth,
    cliVersion: readiness?.version ?? null,
    apiKeySource: last?.apiKeySource ?? null,
    model: last?.model ?? cfg.model,
    envStripped: true,
    strippedPatterns: cfg.auth === "api_key" ? STRIPPED_PATTERNS.filter((p) => p !== "ANTHROPIC_API_KEY") : STRIPPED_PATTERNS,
    strippedCount: buildChildEnv(baseEnv, cfg.auth).stripped,
    loggedIn: readiness ? readiness.ok : null,
    checkedAt: readiness?.checkedAt ?? Date.now(),
    lastRunAt: last?.at ?? null,
  };
}

export interface ClaudeReadiness {
  ok: boolean;
  version: string | null;
  /** Shown on the agent in every client when the agent cannot run. */
  note: string | null;
  checkedAt: number;
}

export const NOTE_MISSING = "Claude Code CLI not found — install it on the connector machine";
export const NOTE_LOGGED_OUT = "Claude Code not logged in — run `claude` on the connector machine";

const run = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; stdout: string }>((done) => {
    execFile(file, args, { env, timeout: 20_000, windowsHide: true }, (err, stdout) => done({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout ?? "") }));
  });

/** Turns `claude auth status` output into a readiness note. Reads only the login flag and method. */
export function readinessFromAuthStatus(stdout: string, auth: ClaudeAuthMode): string | null {
  let j: any;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null; // an older CLI without JSON status: let the run itself report a problem
  }
  if (j?.loggedIn !== true) return NOTE_LOGGED_OUT;
  if (auth === "subscription" && typeof j.authMethod === "string" && j.authMethod !== "claude.ai") {
    return `Claude Code is signed in with "${j.authMethod}", not a claude.ai subscription — run \`claude\` and \`/login\` on the connector machine`;
  }
  return null;
}

/** Asks the CLI itself whether it is installed and signed in. Never touches its credential storage. */
export async function checkClaude(cfg: ClaudeAgentConfig, baseEnv: NodeJS.ProcessEnv = process.env): Promise<ClaudeReadiness> {
  const now = Date.now();
  const file = resolveCommand(cfg.command, baseEnv);
  if (!file) return { ok: false, version: null, note: NOTE_MISSING, checkedAt: now };
  if (/\.(cmd|bat)$/i.test(file)) return { ok: false, version: null, note: "Claude Code was found as a .cmd shim — install the native build (claude.exe) on the connector machine", checkedAt: now };
  const { env } = buildChildEnv(baseEnv, cfg.auth);
  const v = await run(file, ["--version"], env);
  if (v.code !== 0) return { ok: false, version: null, note: NOTE_MISSING, checkedAt: now };
  const version = v.stdout.trim().split(/\s+/)[0] || null;
  if (cfg.auth === "api_key") {
    const has = Object.keys(baseEnv).some((k) => k.toUpperCase() === "ANTHROPIC_API_KEY" && baseEnv[k]);
    return { ok: has, version, note: has ? null : "auth is \"api_key\" but ANTHROPIC_API_KEY is not set in the connector's environment", checkedAt: now };
  }
  const note = readinessFromAuthStatus((await run(file, ["auth", "status"], env)).stdout, cfg.auth);
  return { ok: !note, version, note, checkedAt: now };
}

// ---------------------------------------------------------------- process control

/** Stops the CLI and everything it started (shells, MCP helpers). */
export function killTree(child: ChildProcess) {
  if (child.exitCode != null) return;
  if (child.pid == null) return void child.kill();
  if (process.platform === "win32") {
    // child.kill() only ends the top process on Windows; taskkill /T takes the whole tree.
    const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    k.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM"); // the child leads its own process group (detached)
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.exitCode != null || child.pid == null) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 3000).unref();
}

export const userLine = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

/** One owner turn waiting for the agent: the words and any pictures attached to them. */
export interface Turn {
  text: string;
  attachments?: MessageAttachment[];
}

/** A picture ready for the CLI: its real type (read from the bytes) and the bytes as base64. */
export interface ImageBlock {
  mime: string;
  data: string;
}

/**
 * The stream-json line for one owner turn with pictures: each picture as an image content block, then the words
 * (pictures first, as Claude reads them best). With no words, the pictures go alone.
 */
export function userLineWithImages(text: string, images: ImageBlock[]): string {
  if (!images.length) return userLine(text);
  const content: Array<Record<string, unknown>> = images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } }));
  if (text.trim()) content.push({ type: "text", text });
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/** How long one picture may take to come from the hub before the turn goes without it (and says so). */
export const ATTACHMENT_FETCH_MS = 30_000;

/** Fetches a picture's bytes and checks they are an image Claude can read. */
export async function loadImageBlock(a: MessageAttachment, load: ((a: MessageAttachment) => Promise<Uint8Array>) | undefined, timeoutMs = ATTACHMENT_FETCH_MS): Promise<ImageBlock> {
  if (!load) throw new Error("this connector cannot fetch pictures from the hub");
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const bytes = await Promise.race([
      load(a),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the hub did not send it in time")), timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    const info = sniffImage(bytes);
    if (!info) throw new Error("it is not a PNG, JPEG, WebP or GIF image");
    return { mime: info.mime, data: Buffer.from(bytes).toString("base64") };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- adapter

export interface ClaudeAdapterOptions {
  config: ClaudeAgentConfig;
  approvals: ApprovalServer;
  /** Cached readiness; the adapter re-checks before a run when the last answer is stale or bad. */
  readiness?: () => Promise<ClaudeReadiness>;
  env?: NodeJS.ProcessEnv;
  /**
   * The connector's folder allowlist, for an agent the owner can give folders to. It decides the run's working
   * directory and which of the extra folders the hub asked for are really added. Left out: the working directory
   * must be the sandbox or a projectDir from the config, and the extra folders are the config's addDirs.
   */
  folders?: { resolveCwd(requested: string | null): string | null; resolveExtras(requested: unknown, cwd: string): RunFolders };
  /** Called with what each run's init message says about auth, for the auth view. */
  onRunFacts?: (facts: ClaudeRunFacts) => void;
  /** Replaces the generic tool policy (the Comms agent has a narrower one). The approval flow around it is unchanged. */
  decide?: (tool: string, input: Record<string, unknown>, env: PermissionEnv) => Verdict;
  /** More MCP servers for this run's CLI process, next to the approval tool. Called once per process. */
  extraMcp?: (ctx: RunContext, info: { cwd: string; mode: () => PermissionMode }) => Promise<{ servers: Record<string, unknown>; release(): void }>;
  /** A reason this agent cannot run right now, beyond the CLI's own readiness. */
  preflight?: () => Promise<string | null> | string | null;
  /** Rewrites a tool result before it goes on the run timeline (and so to the hub). */
  redactToolOutput?: (tool: string | null, output: string) => string;
  /** Test seam. */
  spawnFn?: typeof spawn;
  log?: (...a: unknown[]) => void;
}

type TurnResult = Extract<MappedAction, { type: "result" }>;
class Fail extends Error {}

export function createClaudeCodeAdapter(opts: ClaudeAdapterOptions): AgentAdapter {
  const cfg = opts.config;
  const spawnFn = opts.spawnFn ?? spawn;
  const baseEnv = opts.env ?? process.env;

  return {
    kind: "claude",
    start(ctx: RunContext): RunHandle {
      const queue: Turn[] = [{ text: ctx.run.prompt, ...(ctx.run.attachments?.length ? { attachments: ctx.run.attachments } : {}) }];
      // Pictures are fetched from the hub as soon as a turn arrives, so they are ready when the turn is written.
      const pictures = new Map<string, Promise<ImageBlock>>();
      const prefetch = (turn: Turn) => {
        for (const a of turn.attachments ?? []) {
          if (pictures.has(a.id)) continue;
          const p = loadImageBlock(a, ctx.loadAttachment);
          p.catch(() => {}); // reported when the turn is written
          pictures.set(a.id, p);
        }
      };
      prefetch(queue[0]);
      const remembered = new Set<string>();
      const startedAt = Date.now();
      let child: ChildProcess | null = null;
      let cancelled = false;
      let sessionId: string | null = ctx.run.resumeSessionRef && UUID.test(ctx.run.resumeSessionRef) ? ctx.run.resumeSessionRef : null;
      let costUsd = 0;
      let numTurns = 0;
      let lastOk: TurnResult | null = null;

      const stop = () => {
        cancelled = true;
        if (child) killTree(child);
      };
      ctx.signal.addEventListener("abort", stop, { once: true });

      // The hub can make the profile stricter; it can never loosen the connector's own setting.
      const profile: PermissionProfile = cfg.permissionProfile === "strict" || ctx.run.options?.permissionProfile === "strict" ? "strict" : "standard";
      // The mode comes from the owner through the hub; the connector only honours modes its own config lists.
      const wanted = ctx.run.options?.mode;
      let mode: PermissionMode = wanted === "auto" || wanted === "plan" ? (cfg.modes.includes(wanted) ? wanted : "manual") : "manual";
      const refusedMode = wanted && wanted !== mode ? String(wanted) : null;
      const say = (message: string, extra: Record<string, unknown> = {}) => ctx.emit("system", { message, mode, ...extra });
      const asked = Number(ctx.run.options?.maxTurns);
      const maxTurns = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.round(asked), cfg.maxTurns) : cfg.maxTurns;
      // Model and effort also come from the owner through the hub; only what this connector's config offers is run.
      const picked = pickModel(cfg, { model: ctx.run.options?.model, effort: ctx.run.options?.effort });

      /** One CLI process: feeds queued messages one turn at a time, ends when the queue is empty. */
      const runProcess = (file: string, cwd: string, dirs: RunFolders, extra: { servers: Record<string, unknown>; release(): void } | null): Promise<{ failed?: string; retryFresh?: boolean }> =>
        new Promise((settle) => {
          const mapper = new ClaudeStreamMapper();
          const lines = new LineBuffer();
          const resumed = sessionId;
          const binding = opts.approvals.bind((req) =>
            handlePermission(req, {
              // Read when each request arrives: the owner can change the mode while the run is live.
              env: () => ({ cwd, readRoots: dirs.read, writeRoots: dirs.write, profile, mode }),
              requestApproval: ctx.requestApproval,
              remembered,
              decide: opts.decide,
              onPlanApproved: (next) => {
                // The CLI already has the plan in hand; the file must not linger where `git add -A` would pick it up.
                removePlanFiles(cwd);
                mode = next === "auto" && cfg.modes.includes("auto") ? "auto" : "manual";
                say(`Plan approved · continuing in ${MODE_LABEL[mode]} mode`, { modeChanged: true, decision: "plan_approved" });
              },
              // Everything the policy decided without the owner goes on the timeline, and from there into the audit log.
              onDecision: (d) => {
                if (d.outcome === "blocked") {
                  say(`Blocked by policy: ${d.title}`, { decision: "blocked", tool: d.tool, title: d.title, summary: d.summary, reason: d.verdict.reason });
                } else if ((d.outcome === "auto" && d.verdict.reason !== "Read-only tool" && !(d.verdict.tier === "auto" && d.verdict.silent)) || d.outcome === "remembered") {
                  say(`Auto-approved: ${d.title}`, {
                    decision: "auto_approved", tool: d.tool, title: d.title, summary: d.summary,
                    reason: d.outcome === "remembered" ? "You approved this earlier in the run and chose to remember it" : d.verdict.reason,
                  });
                } else if (d.outcome === "plan_rejected") {
                  say("Plan sent back for changes", { decision: "plan_rejected" });
                }
              },
            }),
          );
          const { env, apiKeyStripped } = buildChildEnv(baseEnv, cfg.auth);
          // The CLI's own mode is fixed for the life of a process. A plan run that was approved continues in "default".
          const mcpConfig = extra ? JSON.stringify({ mcpServers: { ...JSON.parse(binding.mcpConfig).mcpServers, ...extra.servers } }) : binding.mcpConfig;
          const args = buildArgs(cfg, {
            resume: resumed, mcpConfig, maxTurns, mode, model: picked.model, effort: picked.effort,
            ...(opts.folders ? { addDirs: [...dirs.read, ...dirs.write], readOnlyDirs: dirs.read } : {}),
          });
          const planned = mode === "plan";
          let sawInit = false;
          let failure: string | null = null;
          let stdinOpen = true;
          let stderrTail = "";
          let processCost = 0;
          let exitTimer: ReturnType<typeof setTimeout> | null = null;

          const proc = spawnFn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: process.platform !== "win32" });
          child = proc;

          /**
           * Writes one owner turn. Pictures go as image content blocks. One that cannot be had is named on the
           * timeline and to the agent; it is never dropped quietly.
           */
          const write = async (turn: Turn) => {
            let line = userLine(turn.text);
            const pics = turn.attachments ?? [];
            if (pics.length) {
              prefetch(turn);
              const settled = await Promise.allSettled(pics.map((a) => pictures.get(a.id)!));
              const images = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
              const failed = settled.flatMap((s, i) => (s.status === "rejected" ? [{ a: pics[i], why: (s.reason as Error)?.message ?? String(s.reason) }] : []));
              let text = turn.text;
              if (failed.length) {
                ctx.emit("error", { message: `${attachmentsSummary(failed.length)} could not be given to Claude: ${failed.map((f) => `${f.a.name ?? f.a.id} (${f.why})`).join("; ")}` });
                text = `${text}${text.trim() ? "\n\n" : ""}[HomeBase: ${attachmentsSummary(failed.length)} the owner attached could not be loaded, so you cannot see ${failed.length === 1 ? "it" : "them"}. Say so in your reply.]`;
              }
              if (images.length) {
                const sent = pics.filter((a) => !failed.some((f) => f.a === a));
                say(`${attachmentsSummary(images.length)} attached to this message`, { attachments: sent.map((a) => ({ id: a.id, mime: a.mime, bytes: a.bytes, width: a.width, height: a.height })) });
              }
              line = userLineWithImages(text, images);
            }
            if (stdinOpen && proc.stdin?.writable) proc.stdin.write(line);
          };
          const closeStdin = () => {
            if (!stdinOpen) return;
            stdinOpen = false;
            proc.stdin?.end();
            // Closing stdin ends print mode. If the process lingers anyway, take the tree down.
            exitTimer = setTimeout(() => killTree(proc), 15_000);
            exitTimer.unref();
          };
          const abortWith = (message: string) => {
            failure = message;
            stdinOpen = false;
            killTree(proc);
          };

          const onAction = (a: MappedAction) => {
            if (a.type === "event") {
              const data = a.kind === "tool_result" && opts.redactToolOutput && typeof a.data.output === "string"
                ? { ...a.data, output: opts.redactToolOutput(typeof a.data.tool === "string" ? a.data.tool : null, a.data.output) } : a.data;
              return ctx.emit(a.kind, data, a.persist === false ? { persist: false } : undefined);
            }
            if (a.type === "init") {
              if (cfg.auth === "subscription" && a.apiKeySource && a.apiKeySource !== "none") {
                sawInit = true;
                return abortWith(`Claude Code picked up an API key (${a.apiKeySource}) while this agent is set to subscription login. The run was stopped so nothing is billed to an API key.`);
              }
              const first = !sawInit;
              sawInit = true;
              sessionId = a.sessionId;
              ctx.status("running", { sessionRef: a.sessionId });
              if (first) {
                opts.onRunFacts?.({ apiKeySource: a.apiKeySource, model: a.model, at: Date.now() });
                ctx.emit("system", {
                  message: `Claude session ${resumed === a.sessionId ? "resumed" : "started"} · ${modelLabel(a.model ?? picked.model)} · ${picked.effort ? `${EFFORT_LABEL[picked.effort]} effort` : "default effort"} · ${MODE_LABEL[mode]} mode · auth: ${CLAUDE_AUTH_LABEL[cfg.auth]}`,
                  auth: CLAUDE_AUTH_LABEL[cfg.auth], authMode: cfg.auth, apiKeySource: a.apiKeySource, apiKeyStrippedFromEnv: apiKeyStripped,
                  model: a.model, effort: picked.effort, sessionId: a.sessionId, resumed: resumed === a.sessionId, cwd, permissionProfile: profile, maxTurns, mode,
                  folders: [...dirs.read.map((path) => ({ path, access: "read" })), ...dirs.write.map((path) => ({ path, access: "write" }))],
                });
              }
              return;
            }
            // result
            if (a.costUsd != null) {
              costUsd += Math.max(0, a.costUsd - processCost); // the CLI reports a running total per process
              processCost = a.costUsd;
            }
            if (a.numTurns != null) numTurns += a.numTurns;
            if (!a.ok) {
              failure = a.error ?? "Claude reported an error.";
              if (/log ?in|authenticat|unauthori[sz]ed|oauth/i.test(failure)) failure = `${failure} — ${NOTE_LOGGED_OUT}`;
              return closeStdin();
            }
            lastOk = a;
            const next = queue.shift();
            if (next !== undefined && !cancelled) {
              ctx.status("running");
              void write(next);
            } else closeStdin();
          };

          proc.stdout?.setEncoding("utf8");
          proc.stdout?.on("data", (chunk: string) => {
            for (const l of lines.push(chunk)) for (const a of mapper.line(l)) onAction(a);
          });
          proc.stderr?.setEncoding("utf8");
          proc.stderr?.on("data", (chunk: string) => {
            stderrTail = (stderrTail + chunk).slice(-600);
          });
          proc.stdin?.on("error", () => {});
          proc.once("error", (err) => {
            binding.release();
            extra?.release();
            if (exitTimer) clearTimeout(exitTimer);
            child = null;
            settle({ failed: (err as NodeJS.ErrnoException).code === "ENOENT" ? NOTE_MISSING : `Could not start Claude Code: ${err.message}` });
          });
          proc.once("close", (code) => {
            for (const l of lines.flush()) for (const a of mapper.line(l)) onAction(a);
            binding.release();
            extra?.release();
            if (planned) removePlanFiles(cwd);
            if (exitTimer) clearTimeout(exitTimer);
            child = null;
            if (cancelled) return settle({});
            if (failure) {
              // A session that no longer exists on this machine: start a new one instead of failing the thread.
              if (resumed && !sawInit) return settle({ retryFresh: true });
              return settle({ failed: failure });
            }
            if (!lastOk && !sawInit) {
              if (resumed && /no conversation found/i.test(stderrTail)) return settle({ retryFresh: true });
              const tail = stderrTail.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
              return settle({ failed: `Claude Code exited with code ${code}${tail ? `: ${tail}` : ""}` });
            }
            if (!lastOk) return settle({ failed: `Claude Code exited (code ${code}) before finishing the turn.` });
            settle({});
          });

          void write(queue.shift()!);
        });

      const done = (async () => {
        const finish = () => ({ costUsd, numTurns, durationMs: Date.now() - startedAt });
        try {
          const ready = await opts.readiness?.();
          if (ready && !ready.ok) throw new Fail(ready.note ?? NOTE_MISSING);
          const blocked = await opts.preflight?.();
          if (blocked) throw new Fail(blocked);
          const file = resolveCommand(cfg.command, baseEnv);
          if (!file) throw new Fail(NOTE_MISSING);
          // The allowlist is checked here, on this machine, whatever the hub asked for: an unapproved folder never becomes a cwd.
          const cwd = opts.folders ? opts.folders.resolveCwd(ctx.run.cwd) : resolveCwd(cfg, ctx.run.cwd);
          if (!cwd) {
            throw new Fail(`"${ctx.run.cwd}" is not one of this connector's allowed working directories.${opts.folders ? " Approve the folder for read & write (Folders, in the app) or add it to the connector's config file, then send the message again." : ""}`);
          }
          mkdirSync(cwd, { recursive: true });
          const dirs: RunFolders = opts.folders ? opts.folders.resolveExtras(ctx.run.options?.folders, cwd) : { read: cfg.addDirs, write: [], notes: [] };
          await opts.approvals.start();
          if (refusedMode) say(`This connector does not allow ${refusedMode} mode; running in Manual.`, { modeChanged: true });
          if (picked.refused.length) say(`This connector does not offer ${picked.refused.join(" or ")}; running on ${modelLabel(picked.model)} instead.`);
          for (const note of dirs.notes) say(note, { folderNote: true });
          if (opts.folders && dirs.read.length + dirs.write.length) {
            say(`Extra folders: ${[...dirs.write.map((d) => `${basename(d)} (read & write)`), ...dirs.read.map((d) => `${basename(d)} (read-only)`)].join(", ")}`);
          }

          while (queue.length && !cancelled) {
            const pending = queue[0];
            const extra = opts.extraMcp ? await opts.extraMcp(ctx, { cwd, mode: () => mode }) : null;
            const r = await runProcess(file, cwd, dirs, extra);
            if (r.retryFresh) {
              ctx.emit("system", { message: "The earlier Claude session is no longer on this machine; starting a new one." });
              sessionId = null;
              queue.unshift(pending);
              continue;
            }
            if (r.failed) throw new Fail(r.failed);
          }
          if (cancelled) return ctx.status("cancelled", finish());
          const summary = (lastOk as TurnResult | null)?.summary ?? "";
          ctx.emit("result", { summary, costUsd, numTurns, auth: CLAUDE_AUTH_LABEL[cfg.auth] });
          ctx.status("succeeded", { summary, sessionRef: sessionId ?? undefined, ...finish() });
        } catch (err) {
          if (cancelled || ctx.signal.aborted) return ctx.status("cancelled", finish());
          const message = (err as Error).message ?? String(err);
          if (!(err instanceof Fail)) opts.log?.("claude adapter error:", message);
          ctx.emit("error", { message });
          ctx.status("failed", { error: message, sessionRef: sessionId ?? undefined, ...finish() });
        } finally {
          ctx.signal.removeEventListener("abort", stop);
        }
      })();

      return {
        // Delivered after the current turn's result; a process that already closed its input is followed by a resumed one.
        input: (text, attachments) => {
          const turn: Turn = { text, ...(attachments?.length ? { attachments } : {}) };
          prefetch(turn);
          queue.push(turn);
        },
        cancel: stop,
        // Manual and Auto differ only in what the approval tool decides, so the switch takes effect on the next
        // tool call. A run that is still planning stays in plan mode until its plan is decided.
        setMode: (next) => {
          const to: PermissionMode = next === "auto" && cfg.modes.includes("auto") ? "auto" : "manual";
          if (mode === "plan" || to === mode) return;
          mode = to;
          say(`Mode changed to ${MODE_LABEL[mode]} · applies to what the agent asks for next`, { modeChanged: true });
        },
        done,
      };
    },
  };
}
