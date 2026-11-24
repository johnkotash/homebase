import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ApprovalServer, MCP_TOOL_NAME, PERMISSION_PROMPT_TOOL, decidePermission, handlePermission, isSensitivePath, type PermissionDeps,
} from "../src/adapters/claude-approvals";
import type { ApprovalDecision, ApprovalDraft } from "../src/adapters/types";
import { askApprovalTool } from "./claude-fixtures";

const cwd = join(tmpdir(), "hb-sandbox");
const strict = { cwd, profile: "strict" as const };
const standard = { cwd, profile: "standard" as const };
const inCwd = (...p: string[]) => join(cwd, ...p);

describe("risk verdicts for Claude tool calls", () => {
  it("auto-allows read-only tools inside the working directory", () => {
    for (const [tool, input] of [["Read", { file_path: inCwd("a.txt") }], ["Glob", { pattern: "*", path: cwd }], ["Grep", { pattern: "x" }], ["LS", { path: cwd }]] as const) {
      expect(decidePermission(tool, input, strict), tool).toEqual({ tier: "auto", reason: "Read-only tool" });
    }
  });

  it("asks before reading outside the working directory, unless it is an added read root", () => {
    const outside = join(tmpdir(), "elsewhere", "notes.md");
    expect(decidePermission("Read", { file_path: outside }, strict)).toEqual({ tier: "ask", risk: "medium", reason: "Read outside the working directory" });
    expect(decidePermission("Read", { file_path: outside }, { ...strict, readRoots: [join(tmpdir(), "elsewhere")] }).tier).toBe("auto");
  });

  it("never lets the agent read or write credential files", () => {
    for (const p of [join(homedir(), ".claude", ".credentials.json"), join(homedir(), ".claude.json"), join(homedir(), ".ssh", "id_ed25519"), inCwd(".env"), inCwd(".env.production"), inCwd("deploy.pem")]) {
      expect(isSensitivePath(p), p).toBe(true);
      expect(decidePermission("Read", { file_path: p }, strict).tier, p).toBe("deny");
      expect(decidePermission("Write", { file_path: p, content: "x" }, strict).tier, p).toBe("deny");
    }
    expect(isSensitivePath(inCwd("src", "environment.ts"))).toBe(false);
  });

  it("asks before a file edit in the working directory under strict, allows it under standard", () => {
    const input = { file_path: inCwd("hello.txt"), content: "hi" };
    expect(decidePermission("Write", input, strict)).toEqual({ tier: "ask", risk: "low", reason: "File edit (strict profile)" });
    expect(decidePermission("Edit", { file_path: "notes/a.md" }, strict).tier).toBe("ask");
    expect(decidePermission("Write", input, standard)).toEqual({ tier: "auto", reason: "File edit inside the working directory" });
  });

  it("hard-denies edits outside the working directory, including .. escapes", () => {
    for (const p of [join(tmpdir(), "other", "x.txt"), inCwd("..", "x.txt"), "../x.txt", join(cwd + "-evil", "x.txt")]) {
      expect(decidePermission("Write", { file_path: p }, standard), p).toEqual({ tier: "deny", reason: "Hard deny: edit outside the run's working directory" });
    }
    expect(decidePermission("Write", {}, standard).tier).toBe("deny");
  });

  it("treats agent and repository configuration as high risk", () => {
    for (const p of [inCwd(".claude", "settings.json"), inCwd(".git", "hooks", "pre-commit"), inCwd(".mcp.json"), inCwd("CLAUDE.md")]) {
      expect(decidePermission("Write", { file_path: p }, standard), p).toMatchObject({ tier: "ask", risk: "high" });
    }
  });

  it("always asks for shell commands, with the tier from the policy", () => {
    expect(decidePermission("Bash", { command: "npm test" }, standard)).toEqual({ tier: "ask", risk: "medium", reason: "Shell command" });
    expect(decidePermission("PowerShell", { command: "Get-ChildItem" }, standard)).toEqual({ tier: "ask", risk: "medium", reason: "Shell command" });
    expect(decidePermission("Bash", { command: "git push origin feature" }, standard)).toMatchObject({ tier: "ask", risk: "medium", reason: "Matches rule: git push" });
    expect(decidePermission("Bash", { command: "wrangler deploy --env production" }, standard)).toMatchObject({ tier: "ask", risk: "high" });
    expect(decidePermission("Bash", { command: "git push --force origin main" }, standard)).toMatchObject({ tier: "ask", risk: "high" });
    expect(decidePermission("Bash", { command: "cat ~/.claude/.credentials.json" }, standard).tier).toBe("deny");
    expect(decidePermission("PowerShell", { command: "Get-Content $HOME\\.claude\\.credentials.json" }, standard).tier).toBe("deny");
  });

  it("asks before fetching a URL and for unknown tools", () => {
    expect(decidePermission("WebFetch", { url: "https://example.com" }, standard)).toEqual({ tier: "ask", risk: "low", reason: "Fetches a URL" });
    expect(decidePermission("WebSearch", { query: "x" }, standard).tier).toBe("auto");
    expect(decidePermission("mcp__clickup__update_task", {}, standard)).toMatchObject({ tier: "ask", risk: "medium" });
  });

  it.runIf(process.platform === "win32")("compares Windows paths without regard to case or slash direction", () => {
    const up = inCwd("hello.txt").toUpperCase().replace(/\\/g, "/");
    expect(decidePermission("Write", { file_path: up }, standard).tier).toBe("auto");
  });
});

function deps(decide: (d: ApprovalDraft) => ApprovalDecision | Promise<ApprovalDecision>, profile: "strict" | "standard" = "strict") {
  const drafts: ApprovalDraft[] = [];
  const d: PermissionDeps = {
    env: { cwd, profile }, remembered: new Set(),
    requestApproval: async (draft) => {
      drafts.push(draft);
      return decide(draft);
    },
  };
  return { d, drafts };
}
const approve: ApprovalDecision = { decision: "approve", message: null, answers: null, remember: false };

describe("the approval tool's decision", () => {
  it("allows low-risk reads without asking anyone", async () => {
    const { d, drafts } = deps(() => approve);
    const input = { file_path: inCwd("a.txt") };
    expect(await handlePermission({ tool_name: "Read", input }, d)).toEqual({ behavior: "allow", updatedInput: input });
    expect(drafts).toHaveLength(0);
  });

  it("sends the tool name, the exact input and the policy's risk tier, and allows on approve", async () => {
    const { d, drafts } = deps(() => approve);
    const input = { command: "wrangler deploy --env staging", description: "Deploy to staging" };
    const res = await handlePermission({ tool_name: "Bash", input, tool_use_id: "toolu_1" }, d);
    expect(res).toEqual({ behavior: "allow", updatedInput: input });
    expect(drafts).toEqual([{
      kind: "tool", tool: "Bash", title: "Deploy to staging", summary: "wrangler deploy --env staging", input, risk: "high", reason: "Matches rule: deploy", mode: "manual",
    }]);
  });

  it("returns a deny with the owner's message", async () => {
    const { d } = deps(() => ({ decision: "deny", message: "not today", answers: null, remember: false }));
    expect(await handlePermission({ tool_name: "Write", input: { file_path: inCwd("x.txt"), content: "x" } }, d))
      .toEqual({ behavior: "deny", message: "The owner denied this in HomeBase: not today" });
    const plain = deps(() => ({ decision: "deny", message: null, answers: null, remember: false }));
    const res = await handlePermission({ tool_name: "Bash", input: { command: "npm test" } }, plain.d);
    expect(res).toMatchObject({ behavior: "deny" });
    expect((res as any).message).toMatch(/denied this in HomeBase/);
  });

  it("blocks hard-denied calls without asking", async () => {
    const { d, drafts } = deps(() => approve);
    const res = await handlePermission({ tool_name: "Write", input: { file_path: join(tmpdir(), "outside.txt"), content: "x" } }, d);
    expect(res.behavior).toBe("deny");
    expect((res as any).message).toMatch(/Blocked by HomeBase policy \(Hard deny: edit outside the run's working directory\)/);
    expect(drafts).toHaveLength(0);
  });

  it("remembers an approval for the rest of the run, but never a high-risk one", async () => {
    const { d, drafts } = deps(() => ({ ...approve, remember: true }));
    await handlePermission({ tool_name: "Bash", input: { command: "npm test" } }, d);
    await handlePermission({ tool_name: "Bash", input: { command: "npm test" } }, d);
    expect(drafts).toHaveLength(1);
    await handlePermission({ tool_name: "Bash", input: { command: "npm run build" } }, d);
    expect(drafts).toHaveLength(2);
    await handlePermission({ tool_name: "Bash", input: { command: "wrangler deploy" } }, d);
    await handlePermission({ tool_name: "Bash", input: { command: "wrangler deploy" } }, d);
    expect(drafts).toHaveLength(4);
  });

  it("denies when the run is cancelled while waiting", async () => {
    const { d } = deps(() => Promise.reject(new Error("cancelled")));
    expect(await handlePermission({ tool_name: "Bash", input: { command: "npm test" } }, d)).toEqual({ behavior: "deny", message: "The run was cancelled before the owner decided." });
  });
});

describe("the local MCP approval server", () => {
  let server: ApprovalServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("listens on loopback only and exposes one tool under the name Claude Code is given", async () => {
    server = new ApprovalServer();
    await server.start();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(PERMISSION_PROMPT_TOOL).toBe("mcp__homebase__approve");
    const { mcpConfig } = server.bind(async () => ({ behavior: "deny", message: "no" }));
    const cfg = JSON.parse(mcpConfig).mcpServers.homebase;
    expect(cfg.type).toBe("http");
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual([MCP_TOOL_NAME]);
    expect(Object.keys((tools.tools[0].inputSchema as any).properties).sort()).toEqual(["input", "tool_name", "tool_use_id"]);
    await client.close();
  });

  it("returns the decision as JSON text, after waiting for the owner", async () => {
    server = new ApprovalServer();
    await server.start();
    const { d, drafts } = deps(async () => {
      await new Promise((r) => setTimeout(r, 150)); // the owner takes a moment
      return approve;
    });
    const { mcpConfig } = server.bind((req) => handlePermission(req, d));
    const input = { file_path: inCwd("hello.txt"), content: "hi" };
    expect(await askApprovalTool(mcpConfig, { tool_name: "Write", input, tool_use_id: "toolu_9" })).toEqual({ behavior: "allow", updatedInput: input });
    expect(drafts[0]).toMatchObject({ tool: "Write", title: "Write hello.txt", risk: "low", input });
  });

  it("routes each token to its own run and rejects unknown or released tokens", async () => {
    server = new ApprovalServer();
    await server.start();
    const a = server.bind(async () => ({ behavior: "deny", message: "run A" }));
    const b = server.bind(async () => ({ behavior: "deny", message: "run B" }));
    const req = { tool_name: "Bash", input: { command: "x" } };
    expect(await askApprovalTool(a.mcpConfig, req)).toEqual({ behavior: "deny", message: "run A" });
    expect(await askApprovalTool(b.mcpConfig, req)).toEqual({ behavior: "deny", message: "run B" });
    const post = (auth?: string) => fetch(server!.url, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: "{}" });
    expect((await post()).status).toBe(401);
    expect((await post("Bearer deadbeef")).status).toBe(401);
    a.release();
    await expect(askApprovalTool(a.mcpConfig, req)).rejects.toThrow();
    expect((await fetch(server.url, { headers: JSON.parse(b.mcpConfig).mcpServers.homebase.headers })).status).toBe(405);
  });
});
