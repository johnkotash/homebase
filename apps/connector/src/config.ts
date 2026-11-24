import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFORTS, Effort, MODEL_CATALOG, ModelName, PERMISSION_MODES, canonicalModel, type AgentRegistration, type PermissionMode } from "@homebase/protocol";

const here = dirname(fileURLToPath(import.meta.url));
export const CONNECTOR_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(here, "../../..");
/** `~/x` → the user's home directory, so one config file works for any account on a server. */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
}
/**
 * The business or team the agents work for, from HB_ORG_NAME (for example "Acme Web Studio"). The Comms and Notes
 * agents name it in their instructions; unset, they speak of "the owner" only. Kept to plain name characters.
 */
export function orgName(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.HB_ORG_NAME ?? "").replace(/\s+/g, " ").replace(/[^\p{L}\p{N} .,&'()-]/gu, "").replace(/ {2,}/g, " ").trim().slice(0, 80);
  return v || null;
}
const dataDir = (env: NodeJS.ProcessEnv) => resolve(expandHome(env.HOMEBASE_DATA_DIR ?? env.DATA_DIR ?? resolve(REPO_ROOT, "data")));
/** HomeBase's data folder on this machine (the hub's database when it runs here, secrets, the agents' own workspaces). */
export const dataDirOf = (env: NodeJS.ProcessEnv = process.env) => dataDir(env);
export const CONFIG_PATH = process.env.HB_CONNECTOR_CONFIG ? resolve(expandHome(process.env.HB_CONNECTOR_CONFIG)) : resolve(CONNECTOR_DIR, ".connector.json");
export const DEV_PAIRING_PATH = resolve(dataDir(process.env), "dev-pairing.json");

export interface SavedConfig {
  hub: string;
  token: string;
  connectorId: string;
  name: string;
}

export function loadSaved(): SavedConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as SavedConfig;
  } catch {
    return null;
  }
}

export function save(cfg: SavedConfig) {
  // The token is the connector's only credential. It stays in this gitignored file.
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function forget() {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

export function devPairingCode(): string | null {
  try {
    const j = JSON.parse(readFileSync(DEV_PAIRING_PATH, "utf8"));
    return j.expiresAt > Date.now() ? (j.connectorCode as string) : null;
  } catch {
    return null;
  }
}

export interface CliArgs {
  hub: string;
  pair: string | null;
  name: string;
  speed: number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  return {
    hub: get("--hub") ?? env.HB_HUB ?? "http://127.0.0.1:8787",
    pair: get("--pair") ?? env.HB_PAIR_CODE ?? null,
    name: get("--name") ?? env.HB_CONNECTOR_NAME ?? `${hostname().toLowerCase()}-connector`,
    speed: Number(get("--speed") ?? env.HB_MOCK_SPEED ?? 1),
  };
}

/** The scripted demo agents, both backed by the mock adapter. Registered only in demo mode (see mockAgents). */
export const MOCK_AGENTS: AgentRegistration[] = [
  {
    key: "dev", name: "Dev agent", kind: "mock",
    description: "Works in client repos: fixes, small features, deploys behind approval.",
    capabilities: ["code", "shell", "git", "mcp:clickup"],
    workspaces: [
      { label: "harbor-pine-site", cwd: "/srv/repos/harbor-pine-site" },
      { label: "northwind-storefront", cwd: "/srv/repos/northwind-storefront" },
      { label: "hilltop-inspections", cwd: "/srv/repos/hilltop-inspections" },
    ],
  },
  {
    key: "ops", name: "Site ops agent", kind: "mock",
    description: "Runs form tests and uptime checks, reads logs, files what it finds.",
    capabilities: ["monitoring", "http", "logs", "mcp:resend"],
    workspaces: [{ label: "monitors", cwd: "/srv/ops/monitors" }],
  },
];
// The Comms agent is no longer a mock: see gmail/comms.ts.

/**
 * The mock agents this connector registers: none, unless HOMEBASE_DEMO is on ("1", "true", "yes" or "on"), the same
 * switch that makes the hub seed its demo workspace. They exist for screenshots and trying the app without Claude.
 */
export function mockAgents(env: NodeJS.ProcessEnv = process.env): AgentRegistration[] {
  return /^(1|true|yes|on)$/i.test(env.HOMEBASE_DEMO?.trim() ?? "") ? MOCK_AGENTS : [];
}

// ---------------------------------------------------------------- Claude agent

/**
 * "subscription": the official Claude Code CLI under the login already on this machine (personal use).
 * "api_key": the same CLI billed to ANTHROPIC_API_KEY from the connector's environment (the multi-tenant path).
 */
export type ClaudeAuthMode = "subscription" | "api_key";
export const CLAUDE_AUTH_LABEL: Record<ClaudeAuthMode, string> = {
  subscription: "subscription (Claude Code login)",
  api_key: "API key (ANTHROPIC_API_KEY)",
};

export interface ClaudeAgentConfig {
  enabled: boolean;
  /** Agent key on the hub and its UI name. */
  key: string;
  name: string;
  auth: ClaudeAuthMode;
  /** The Claude Code executable. A bare name is looked up on PATH. */
  command: string;
  /** Model alias or full name passed to --model when the owner has chosen nothing in the app. */
  model: string;
  /**
   * Models the owner may pick for this agent from the app (full names or aliases). Left out: the four
   * current ones. An empty list keeps the agent on `model` only. Nothing outside this list is ever run.
   */
  models?: string[];
  /** Effort passed to --effort when the owner has chosen none. Left out: the flag is not passed and the CLI decides. */
  effort?: Effort | null;
  maxTurns: number;
  /** "strict" asks before file edits inside the working directory too; "standard" auto-allows them. */
  permissionProfile: "standard" | "strict";
  /**
   * Permission modes the owner may pick for this agent from the app. "manual" is always there.
   * Leave "auto" out to keep every write and command behind a phone approval on this machine.
   */
  modes: PermissionMode[];
  /** Default working directory. Created if missing. */
  sandboxDir: string;
  /** Other directories the owner may pick for a run. Nothing outside sandboxDir + projectDirs is ever used as a cwd. */
  projectDirs: Array<{ label: string; cwd: string }>;
  /** Extra read-only context directories passed with --add-dir on every run. The agent's file tools cannot edit in them, in any mode. */
  addDirs: string[];
  /**
   * Where the app's folder browser may look, and so which folders the owner can approve from the app. Left out: the
   * home folder. Credential, settings and system folders and HomeBase's own data are never listed, whatever is here.
   */
  browseRoots?: string[];
  /** false: no browsing and no approving from the app; folders then come from this file only. */
  appFolders?: boolean;
  /** Built-in tools the agent gets (--tools). */
  tools: string[];
  /** Claude Code setting sources to load (--setting-sources). User settings are left out on purpose. */
  settingSources: string;
  /** Replaces the default appended system prompt (the Comms agent has its own). */
  systemPrompt?: string;
  /** Extra --disallowedTools entries, on top of the secret-read rules. */
  extraDisallowed?: string[];
  /** Extra Claude Code settings passed with --settings (the Notes agent excludes an unrelated CLAUDE.md this way). */
  settings?: Record<string, unknown>;
}

export const CLAUDE_CONFIG_PATH = process.env.HB_CLAUDE_CONFIG ? resolve(expandHome(process.env.HB_CLAUDE_CONFIG)) : resolve(CONNECTOR_DIR, "claude-agent.json");
/** The folders the owner approved from the app: a file of its own next to the Claude config, so the hand-edited config is never rewritten. */
export const APPROVED_FOLDERS_PATH = process.env.HB_FOLDERS_FILE ? resolve(expandHome(process.env.HB_FOLDERS_FILE)) : resolve(dirname(CLAUDE_CONFIG_PATH), "approved-folders.json");
/**
 * HomeBase's own files on this machine: its data folders, the connector's token and its settings. The folder
 * browser never goes into them, and a folder that contains one of them cannot be handed to an agent.
 */
export const privatePaths = (env: NodeJS.ProcessEnv = process.env): string[] =>
  [...new Set([dataDir(env), resolve(REPO_ROOT, "data"), CONFIG_PATH, resolve(CONNECTOR_DIR, ".connector.json"), CLAUDE_CONFIG_PATH, APPROVED_FOLDERS_PATH])];

export function defaultClaudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeAgentConfig {
  return {
    enabled: env.HB_CLAUDE !== "0",
    key: "claude",
    name: "Claude agent",
    auth: "subscription",
    command: "claude",
    model: "sonnet",
    maxTurns: 25,
    permissionProfile: "strict",
    modes: ["manual", "auto", "plan"],
    sandboxDir: resolve(dataDir(env), "claude-workspace"),
    projectDirs: [],
    addDirs: [],
    tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "PowerShell", "TodoWrite", "WebSearch", "WebFetch"],
    settingSources: "project",
  };
}

/** Defaults, overlaid with `apps/connector/claude-agent.json` (or HB_CLAUDE_CONFIG) when it exists. */
export function loadClaudeConfig(path = CLAUDE_CONFIG_PATH, env: NodeJS.ProcessEnv = process.env): ClaudeAgentConfig {
  const cfg = defaultClaudeConfig(env);
  let file: Partial<ClaudeAgentConfig> = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as Partial<ClaudeAgentConfig>;
    } catch (err) {
      throw new Error(`Could not parse ${path}: ${(err as Error).message}`);
    }
  }
  const out: ClaudeAgentConfig = { ...cfg, ...file };
  // Environment overrides win over the file, so a one-off cheap model is easy.
  if (env.HB_CLAUDE_MODEL) out.model = env.HB_CLAUDE_MODEL;
  if (env.HB_CLAUDE_MAX_TURNS) out.maxTurns = Number(env.HB_CLAUDE_MAX_TURNS);
  if (env.HB_CLAUDE_COMMAND) out.command = env.HB_CLAUDE_COMMAND;
  out.command = expandHome(String(out.command)); // "~/.local/bin/claude" on a server
  if (env.HB_CLAUDE === "0") out.enabled = false;
  if (out.auth !== "api_key") out.auth = "subscription";
  if (out.permissionProfile !== "standard") out.permissionProfile = "strict";
  const wanted = Array.isArray(out.modes) ? out.modes.map(String) : cfg.modes;
  out.modes = PERMISSION_MODES.filter((m) => m === "manual" || wanted.includes(m));
  if (!Number.isFinite(out.maxTurns) || out.maxTurns < 1) out.maxTurns = 25;
  out.maxTurns = Math.min(Math.round(out.maxTurns), 200);
  const base = dirname(path);
  const abs = (p: string) => {
    const x = expandHome(p);
    return isAbsolute(x) ? resolve(x) : resolve(base, x);
  };
  out.sandboxDir = abs(out.sandboxDir);
  out.projectDirs = (Array.isArray(out.projectDirs) ? out.projectDirs : [])
    .map((d: any) => (typeof d === "string" ? { label: basename(d), cwd: abs(d) } : { label: String(d.label ?? basename(String(d.cwd))), cwd: abs(String(d.cwd)) }))
    .filter((d) => existsSync(d.cwd));
  out.addDirs = (Array.isArray(out.addDirs) ? out.addDirs : []).map((d) => abs(String(d))).filter((d) => existsSync(d));
  const roots = env.HB_BROWSE_ROOTS ? env.HB_BROWSE_ROOTS.split(delimiter) : Array.isArray(out.browseRoots) ? out.browseRoots : ["~"];
  out.browseRoots = [...new Set(roots.map((d) => abs(String(d).trim())).filter((d) => existsSync(d)))];
  out.appFolders = env.HB_APP_FOLDERS === "0" ? false : out.appFolders !== false;
  out.tools = (Array.isArray(out.tools) ? out.tools : cfg.tools).map(String).filter((t) => /^[A-Za-z][\w-]*$/.test(t));
  if (!ModelName.safeParse(out.model).success) out.model = cfg.model;
  if (out.models !== undefined) out.models = (Array.isArray(out.models) ? out.models : []).map(String).filter((m) => ModelName.safeParse(m).success);
  out.effort = Effort.safeParse(out.effort).success ? out.effort : null;
  return out;
}

/**
 * The models the owner may pick for an agent: the configured list (or the four current models), always
 * with the agent's own configured model in it. One spelling per model, so the app and the hub agree.
 */
export function claudeModels(cfg: Pick<ClaudeAgentConfig, "model" | "models">): string[] {
  const list = (cfg.models ?? MODEL_CATALOG.map((m) => m.id)).map((m) => canonicalModel(m)!);
  const own = canonicalModel(cfg.model)!;
  return [...new Set(list.includes(own) ? list : [...list, own])];
}

/** What a Claude agent tells the hub about model and effort: what it offers and what it runs when nothing is chosen. */
export function modelFacts(cfg: Pick<ClaudeAgentConfig, "model" | "models" | "effort">): Pick<AgentRegistration, "models" | "efforts" | "model" | "effort"> {
  return { models: claudeModels(cfg), efforts: [...EFFORTS], model: canonicalModel(cfg.model), effort: cfg.effort ?? null };
}

/** Sandbox first (the hub uses the first workspace as the default cwd), then the allowlisted project dirs. */
export function claudeWorkspaces(cfg: ClaudeAgentConfig): Array<{ label: string; cwd: string }> {
  mkdirSync(cfg.sandboxDir, { recursive: true });
  return [{ label: "sandbox", cwd: cfg.sandboxDir }, ...cfg.projectDirs.filter((d) => resolve(d.cwd) !== resolve(cfg.sandboxDir))];
}
