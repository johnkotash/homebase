import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { classify, classifyShellAuto, isInside, isProtected, isSensitivePath, mentionsProtected, type PermissionMode, type PermissionProfile, type Verdict } from "../policy";

export { isInside, isSensitivePath };
import { toolTitle } from "./claude-stream";
import type { ApprovalDecision, ApprovalDraft } from "./types";

/**
 * Phone approvals for the Claude agent (ARCHITECTURE.md 6.4, 9.4).
 *
 * The connector hosts a small MCP server on 127.0.0.1. The Claude Code CLI is started with
 * `--mcp-config` pointing at it and `--permission-prompt-tool mcp__homebase__approve`, so every
 * tool call the CLI would otherwise prompt for lands in `handlePermission` below, which applies
 * the connector's risk policy and, when the policy says "ask", waits for the owner's decision.
 */
export const MCP_SERVER_NAME = "homebase";
export const MCP_TOOL_NAME = "approve";
export const PERMISSION_PROMPT_TOOL = `mcp__${MCP_SERVER_NAME}__${MCP_TOOL_NAME}`;

/** The JSON a permission prompt tool must return to Claude Code, as text content. */
export type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface PermissionRequest {
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface PermissionEnv {
  /** The run's working directory. Edits are confined to it. */
  cwd: string;
  /** Extra folders the agent may read but never edit (added read-only). */
  readRoots?: string[];
  /** Extra folders the agent may also edit (added read & write). They count as part of the workspace. */
  writeRoots?: string[];
  profile: PermissionProfile;
  /**
   * manual (the default): ask for every write, edit and command. auto: allow workspace edits and ordinary
   * workspace commands, still ask for anything risky. plan: the agent is still planning, so nothing may change.
   */
  mode?: PermissionMode;
}

export const PLAN_TOOL = "ExitPlanMode";

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const slash = (p: string) => p.replace(/\\/g, "/");

/** Files that change what the agent or the repository's tooling may do later. */
function isAgentConfigPath(relPath: string): boolean {
  return /(^|\/)(\.claude|\.git|\.husky|\.github)(\/|$)|(^|\/)(\.mcp\.json|CLAUDE\.md|\.gitconfig)$/i.test(slash(relPath));
}

function pathOf(input: Record<string, unknown>): string | null {
  for (const k of ["file_path", "notebook_path", "path"]) if (typeof input[k] === "string" && input[k]) return input[k] as string;
  return null;
}

/**
 * The connector's verdict for one Claude tool call. Wraps policy.ts with the path checks that need
 * a real filesystem view (Windows drive letters, case, `..`), which the generic policy does not do.
 */
export function decidePermission(tool: string, input: Record<string, unknown>, env: PermissionEnv): Verdict {
  const mode = env.mode ?? "manual";
  const raw = pathOf(input);
  const abs = raw ? (isAbsolute(raw) ? resolve(raw) : resolve(env.cwd, raw)) : null;
  const readOnly = env.readRoots ?? [];
  const writable = [env.cwd, ...(env.writeRoots ?? [])];
  /** The most specific folder a path is in decides: a read-only folder inside the working directory stays read-only. */
  const rootOf = (p: string): { root: string; readOnly: boolean } | null => {
    let best: { root: string; readOnly: boolean } | null = null;
    const len = (r: string) => resolve(r).length;
    for (const r of writable) if (isInside(p, r) && (!best || len(r) > len(best.root))) best = { root: r, readOnly: false };
    for (const r of readOnly) if (isInside(p, r) && (!best || len(r) >= len(best.root))) best = { root: r, readOnly: true };
    return best;
  };

  // Secrets are off limits in every mode. Nothing below can turn this into an allow or a prompt.
  if (READ_TOOLS.has(tool) || EDIT_TOOLS.has(tool)) {
    if (abs && isSensitivePath(abs)) return { tier: "deny", reason: "Hard deny: credential or secret file" };
    // The Obsidian vault belongs to the Notes agent and its vault service; no other agent reads or writes it.
    if (abs && isProtected(abs)) return { tier: "deny", reason: "Hard deny: the notes vault is reachable only through the Notes agent" };
  }
  if ((tool === "Bash" || tool === "PowerShell") && typeof input.command === "string" && mentionsProtected(input.command)) {
    return { tier: "deny", reason: "Hard deny: the notes vault is reachable only through the Notes agent" };
  }
  if (READ_TOOLS.has(tool)) {
    if (abs && !rootOf(abs)) return { tier: "ask", risk: "medium", reason: "Read outside the working directory" };
    return classify(tool, input, { cwd: env.cwd, profile: env.profile });
  }
  if (EDIT_TOOLS.has(tool)) {
    // Edits are confined to the working directory and the folders added read & write. A folder added read-only is
    // never edited through a file tool, in any mode, and that cannot be approved from a card.
    const at = abs ? rootOf(abs) : null;
    if (at?.readOnly) return { tier: "deny", reason: "Hard deny: this folder was added read-only" };
    if (!abs || !at) return { tier: "deny", reason: "Hard deny: edit outside the run's working directory" };
    const root = at.root;
    const rel = slash(relative(resolve(root), abs));
    if (mode === "plan") return { tier: "deny", reason: "Plan mode is read-only until the owner approves the plan" };
    if (isAgentConfigPath(rel)) return { tier: "ask", risk: "high", reason: "Changes agent or repository configuration" };
    if (mode === "auto") return { tier: "auto", reason: "File edit inside the workspace (auto mode)" };
    // The generic policy sees a path relative to the run's root, so both checks agree on "inside".
    return classify(tool, { ...input, file_path: rel }, { cwd: root, profile: env.profile });
  }
  if (tool === "WebFetch") {
    const v = classify(tool, input, { cwd: env.cwd, profile: env.profile });
    return v.tier === "auto" ? { tier: "ask", risk: "low", reason: "Fetches a URL" } : v;
  }
  if (mode === "auto" && (tool === "Bash" || tool === "PowerShell")) {
    return classifyShellAuto(typeof input.command === "string" ? input.command : "", { cwd: env.cwd, roots: env.writeRoots ?? [], readRoots: readOnly });
  }
  return classify(tool, input, { cwd: env.cwd, profile: env.profile });
}

function summaryOf(tool: string, input: Record<string, unknown>, env: PermissionEnv): string {
  if (typeof input.command === "string") return input.command.slice(0, 2000);
  if (/^mcp__gmail__/.test(tool)) {
    const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "");
    return [list(input.to) ? `To: ${list(input.to)}` : "", typeof input.subject === "string" ? `Subject: ${input.subject}` : "", typeof input.draft_id === "string" ? `Draft ${input.draft_id}` : ""]
      .filter(Boolean).join(" · ").slice(0, 300) || "Gmail draft";
  }
  if (tool === "mcp__vault__vault_append_daily") {
    // The lines that would be added, never JSON.
    const items = Array.isArray(input.items) ? (input.items as Array<Record<string, unknown>>) : [];
    const lines = items.flatMap((i) => [`- ${i.client ? `[${String(i.client)}] ` : ""}${String(i.text ?? "")}`, ...(Array.isArray(i.sub) ? i.sub.map((s) => `  - ${String(s)}`) : [])]);
    return [`Daily note ${String(input.date ?? "")}`, ...lines].join("\n").slice(0, 2000);
  }
  const p = pathOf(input);
  if (p) return isAbsolute(p) ? p : resolve(env.cwd, p);
  if (typeof input.url === "string") return input.url;
  const json = JSON.stringify(input);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
}

export type PermissionOutcome = "auto" | "remembered" | "approved" | "denied" | "blocked" | "plan_approved" | "plan_rejected";

export interface PermissionDeps {
  /** A function when the mode can change while the run is live. */
  env: PermissionEnv | (() => PermissionEnv);
  requestApproval(draft: ApprovalDraft): Promise<ApprovalDecision>;
  /** "Approve and remember" scopes to the current run; the adapter owns this set. */
  remembered: Set<string>;
  /** The owner approved the plan: the run leaves plan mode for the mode they picked. */
  onPlanApproved?(mode: "manual" | "auto"): void;
  /** Replaces decidePermission for agents with their own, narrower policy. */
  decide?: (tool: string, input: Record<string, unknown>, env: PermissionEnv) => Verdict;
  onDecision?(info: { tool: string; title: string; summary: string; verdict: Verdict; outcome: PermissionOutcome; mode: PermissionMode }): void;
}

const rememberKey = (tool: string, input: Record<string, unknown>) =>
  EDIT_TOOLS.has(tool) ? `edit:${tool}` : `${tool}:${JSON.stringify(input.command ?? input.url ?? input)}`;

const MAX_PLAN = 60_000;

/** Policy first, then the owner. Returns exactly what Claude Code expects from a permission prompt tool. */
export async function handlePermission(req: PermissionRequest, deps: PermissionDeps): Promise<PermissionResult> {
  const tool = req.tool_name;
  const input = req.input && typeof req.input === "object" ? req.input : {};
  const env = typeof deps.env === "function" ? deps.env() : deps.env;
  const mode = env.mode ?? "manual";
  const allow: PermissionResult = { behavior: "allow", updatedInput: input };

  // Plan mode: Claude Code asks to leave it by calling ExitPlanMode with the plan. That is the owner's call.
  if (tool === PLAN_TOOL) {
    if (mode !== "plan") return allow; // nothing is gated by a plan outside plan mode
    const plan = (typeof input.plan === "string" ? input.plan : "").slice(0, MAX_PLAN);
    const first = plan.split(/\r?\n/).map((l) => l.replace(/^[#>*\s-]+/, "").trim()).find(Boolean) ?? "";
    const info = { tool, title: "Plan ready for review", summary: first.slice(0, 200), mode };
    const verdict: Verdict = { tier: "ask", risk: "low", reason: "Plan mode: nothing has been changed yet" };
    let decision: ApprovalDecision;
    try {
      decision = await deps.requestApproval({ kind: "plan", tool, title: info.title, summary: info.summary || null, input: { plan }, risk: "low", reason: verdict.reason, mode });
    } catch {
      return { behavior: "deny", message: "The run was cancelled before the owner decided." };
    }
    if (decision.decision === "approve") {
      deps.onPlanApproved?.(decision.mode === "auto" ? "auto" : "manual");
      deps.onDecision?.({ ...info, verdict, outcome: "plan_approved" });
      return allow;
    }
    deps.onDecision?.({ ...info, verdict, outcome: "plan_rejected" });
    return {
      behavior: "deny",
      message: `The owner wants changes before anything runs${decision.message ? `: ${decision.message}` : "."} Stay in plan mode, revise the plan, and call ExitPlanMode again.`,
    };
  }

  const verdict = (deps.decide ?? decidePermission)(tool, input, env);
  const info = { tool, title: toolTitle(tool, input), summary: summaryOf(tool, input, env), verdict, mode };

  if (verdict.tier === "auto") {
    deps.onDecision?.({ ...info, outcome: "auto" });
    return allow;
  }
  // Auto mode means the owner has taken on the risk for this agent and session: nothing stops for a question.
  // Only the hard denies above still apply (secrets, the notes vault, a few catastrophic commands). Steps that
  // other layers gate (a Gmail send, a browser purchase) reach here as silent "auto" and are asked there.
  if (mode === "auto" && verdict.tier === "ask") {
    deps.onDecision?.({ ...info, verdict: { tier: "auto", reason: `Auto mode (would have asked in Manual: ${verdict.reason.replace(/^Auto mode still asks: /, "")})` }, outcome: "auto" });
    return allow;
  }
  if (verdict.tier === "deny") {
    deps.onDecision?.({ ...info, outcome: "blocked" });
    return { behavior: "deny", message: `Blocked by HomeBase policy (${verdict.reason}). Do not try to do this another way; tell the owner instead.` };
  }
  const key = rememberKey(tool, input);
  // High-risk actions are never covered by "remember".
  if (verdict.risk !== "high" && deps.remembered.has(key)) {
    deps.onDecision?.({ ...info, outcome: "remembered" });
    return allow;
  }
  let decision: ApprovalDecision;
  try {
    decision = await deps.requestApproval({ kind: "tool", tool, title: info.title, summary: info.summary, input, risk: verdict.risk, reason: verdict.reason, mode });
  } catch {
    return { behavior: "deny", message: "The run was cancelled before the owner decided." };
  }
  if (decision.decision === "approve") {
    if (decision.remember && verdict.risk !== "high") deps.remembered.add(key);
    deps.onDecision?.({ ...info, outcome: "approved" });
    return allow;
  }
  deps.onDecision?.({ ...info, outcome: "denied" });
  return {
    behavior: "deny",
    message: decision.message ? `The owner denied this in HomeBase: ${decision.message}` : "The owner denied this in HomeBase. Do not retry it; continue without it or stop.",
  };
}

type Handler = (req: PermissionRequest) => Promise<PermissionResult>;

/** Builds the MCP server for one request. Stateless: a fresh instance per HTTP call. */
export function buildMcpServer(handler: Handler): McpServer {
  const mcp = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  mcp.registerTool(
    MCP_TOOL_NAME,
    {
      description: "Permission prompt for HomeBase. Applies the connector's risk policy and asks the owner on their phone when needed.",
      inputSchema: { tool_name: z.string(), input: z.record(z.string(), z.unknown()).optional(), tool_use_id: z.string().optional() },
    },
    async (args) => {
      const result = await handler({ tool_name: args.tool_name, input: (args.input ?? {}) as Record<string, unknown>, tool_use_id: args.tool_use_id });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );
  return mcp;
}

/**
 * Localhost-only HTTP endpoint for the approval tool. Each run binds its own random bearer token,
 * so a request can only ever reach the run whose CLI process was given that token.
 */
export class ApprovalServer {
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private bindings = new Map<string, Handler>();
  port = 0;

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((ok, fail) => {
      const server = createServer((req, res) => void this.onRequest(req, res));
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        server.unref();
        ok();
      });
    });
    return this.starting;
  }

  get url() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** Registers a run. Returns the `--mcp-config` JSON for its CLI process and a release function. */
  bind(handler: Handler): { mcpConfig: string; release(): void } {
    const token = randomBytes(24).toString("hex");
    this.bindings.set(token, handler);
    const mcpConfig = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: this.url, headers: { Authorization: `Bearer ${token}` } } } });
    return { mcpConfig, release: () => void this.bindings.delete(token) };
  }

  async stop() {
    this.bindings.clear();
    const s = this.server;
    this.server = null;
    this.starting = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  private lookup(req: IncomingMessage): Handler | null {
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    for (const [token, handler] of this.bindings) {
      const a = Buffer.from(token);
      const b = Buffer.from(m[1]);
      if (a.length === b.length && timingSafeEqual(a, b)) return handler;
    }
    return null;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const json = (code: number, message: string) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };
    try {
      if (!req.url?.startsWith("/mcp")) return json(404, "Not found");
      const handler = this.lookup(req);
      if (!handler) return json(401, "Unauthorized");
      if (req.method !== "POST") return json(405, "Method not allowed");
      const mcp = buildMcpServer(handler);
      // An approval can stay open for hours; keep-alive comments stop idle timeouts on the response stream.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, keepAliveMs: 15_000 });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) json(500, (err as Error).message ?? "Internal error");
    }
  }
}
