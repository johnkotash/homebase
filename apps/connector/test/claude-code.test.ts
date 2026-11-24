import { mkdtempSync, rmSync } from "node:fs";
import { AGENT_MARKUP_NOTE } from "@homebase/protocol";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type Agent, type Approval, type Message, type Run, type RunEventKind } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer, PERMISSION_PROMPT_TOOL } from "../src/adapters/claude-approvals";
import {
  NOTE_LOGGED_OUT, NOTE_MISSING, buildArgs, buildChildEnv, createClaudeCodeAdapter, readinessFromAuthStatus, resolveCwd, systemPromptFor, type ClaudeReadiness,
} from "../src/adapters/claude-code";
import type { ApprovalDecision, ApprovalDraft, RunContext } from "../src/adapters/types";
import { claudeWorkspaces, loadClaudeConfig } from "../src/config";
import { HubLink } from "../src/HubLink";
import { askApprovalTool, fakeClaude, fixture, testConfig, turnsOf } from "./claude-fixtures";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const SESSION = "306b18cd-e629-4f05-80d2-39435a768c6a";
const listFiles = turnsOf(fixture("claude-list-files.jsonl"));
const twoTurns = turnsOf(fixture("claude-denied-then-followup.jsonl"));
const approve: ApprovalDecision = { decision: "approve", message: null, answers: null, remember: false };

const dirs: string[] = [];
const sandbox = () => {
  const d = mkdtempSync(join(tmpdir(), "hb-claude-"));
  dirs.push(d);
  return d;
};
const servers: ApprovalServer[] = [];
const approvalServer = () => {
  const s = new ApprovalServer();
  servers.push(s);
  return s;
};
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("child environment and command line", () => {
  it("strips ANTHROPIC_API_KEY and other billing or host-session variables in subscription mode", () => {
    const base = {
      PATH: "/bin", HOME: "/home/o", ANTHROPIC_API_KEY: "sk-ant-test", Anthropic_Auth_Token: "t", ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "x", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk", CLAUDE_CODE_SIMPLE: "1",
      CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe", CLAUDE_CONFIG_DIR: "/home/o/.claude",
    };
    const { env, apiKeyStripped } = buildChildEnv(base, "subscription");
    expect(apiKeyStripped).toBe(true);
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CONFIG_DIR", "HOME", "MCP_TOOL_TIMEOUT", "PATH"]);
    expect(JSON.stringify(env)).not.toContain("sk-ant-test");
    expect(buildChildEnv({ PATH: "/bin" }, "subscription").apiKeyStripped).toBe(false);
  });

  it("keeps only the API key in api_key mode", () => {
    const { env, apiKeyStripped } = buildChildEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: "https://proxy.example", CLAUDE_CODE_OAUTH_TOKEN: "x" }, "api_key");
    expect(apiKeyStripped).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("builds a headless stream-json command that routes prompts to the approval tool", () => {
    const cfg = testConfig({ model: "haiku", maxTurns: 7 });
    const args = buildArgs(cfg, { resume: null, mcpConfig: "{}" });
    expect(args.slice(0, 7)).toEqual(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages"]);
    const val = (f: string) => args[args.indexOf(f) + 1];
    expect(val("--model")).toBe("haiku");
    expect(val("--max-turns")).toBe("7");
    expect(val("--permission-mode")).toBe("default");
    expect(val("--permission-prompt-tool")).toBe(PERMISSION_PROMPT_TOOL);
    expect(val("--mcp-config")).toBe("{}");
    expect(val("--setting-sources")).toBe("project");
    expect(val("--tools")).toBe("Read,Glob,Grep,Write,Edit,Bash,PowerShell,TodoWrite,WebSearch,WebFetch");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--resume");
    expect(args.join(" ")).not.toMatch(/dangerously|bypassPermissions|setup-token/);
  });

  it("tells every agent how HomeBase renders replies, including the toned text it may use", () => {
    const general = buildArgs(testConfig(), { resume: null, mcpConfig: "{}" });
    const prompt = general[general.indexOf("--append-system-prompt") + 1];
    expect(prompt.startsWith("You are running as the owner's HomeBase agent.")).toBe(true);
    expect(prompt.endsWith(AGENT_MARKUP_NOTE)).toBe(true);
    for (const tone of ["critical", "warning", "success", "info"]) expect(prompt).toContain(`:${tone}[text]`);
    // An agent with its own prompt (Comms, Notes) keeps it and gets the same note after it. The flag is passed on a
    // resume as well; the CLI itself reuses the prompt it recorded for that conversation (see systemPromptFor).
    const own = buildArgs(testConfig({ systemPrompt: "You keep the vault." }), { resume: SESSION, mcpConfig: "{}", mode: "plan" });
    expect(own[own.indexOf("--append-system-prompt") + 1]).toBe(`You keep the vault.\n\n${AGENT_MARKUP_NOTE}`);
    expect(systemPromptFor({})).toBe(prompt);
  });

  it("resumes only a real session id and passes extra read directories", () => {
    const cfg = testConfig({ addDirs: ["/srv/docs"] });
    expect(buildArgs(cfg, { resume: SESSION, mcpConfig: "{}" }).slice(-2)).toEqual(["--resume", SESSION]);
    expect(buildArgs(cfg, { resume: "mock-1234", mcpConfig: "{}" })).not.toContain("--resume");
    const args = buildArgs(cfg, { resume: null, mcpConfig: "{}", maxTurns: 3 });
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/srv/docs");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
  });

  it("only runs in the sandbox or an allowlisted project directory", () => {
    const box = sandbox();
    const proj = sandbox();
    const cfg = testConfig({ sandboxDir: join(box, "ws"), projectDirs: [{ label: "site", cwd: proj }] });
    expect(claudeWorkspaces(cfg).map((w) => w.label)).toEqual(["sandbox", "site"]);
    expect(resolveCwd(cfg, null)).toBe(join(box, "ws"));
    expect(resolveCwd(cfg, proj)).toBe(proj);
    expect(resolveCwd(cfg, join(proj, "sub"))).toBeNull();
    expect(resolveCwd(cfg, tmpdir())).toBeNull();
  });

  it("defaults to subscription auth, the strict profile and a data/claude-workspace sandbox", () => {
    const cfg = loadClaudeConfig(join(tmpdir(), "no-such-claude-agent.json"), { DATA_DIR: join(tmpdir(), "hb-data") });
    expect(cfg).toMatchObject({ enabled: true, name: "Claude agent", auth: "subscription", permissionProfile: "strict", model: "sonnet", maxTurns: 25, projectDirs: [] });
    expect(cfg.sandboxDir).toBe(join(tmpdir(), "hb-data", "claude-workspace"));
    expect(loadClaudeConfig(join(tmpdir(), "no-such.json"), { HB_CLAUDE_MODEL: "haiku", HB_CLAUDE_MAX_TURNS: "4", HB_CLAUDE: "0" })).toMatchObject({ model: "haiku", maxTurns: 4, enabled: false });
  });

  it("turns the CLI's own auth status into a clear note", () => {
    expect(readinessFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), "subscription")).toBeNull();
    expect(readinessFromAuthStatus(JSON.stringify({ loggedIn: false }), "subscription")).toBe(NOTE_LOGGED_OUT);
    expect(NOTE_LOGGED_OUT).toBe("Claude Code not logged in — run `claude` on the connector machine");
    expect(readinessFromAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "api_key" }), "subscription")).toMatch(/not a claude.ai subscription/);
    expect(readinessFromAuthStatus("garbage", "subscription")).toBeNull();
  });
});

function harness(over: { prompt?: string; resume?: string | null; cwd?: string | null; decide?: (d: ApprovalDraft) => ApprovalDecision; options?: Record<string, unknown> } = {}) {
  const events: Array<{ kind: RunEventKind; data: any; persist: boolean }> = [];
  const statuses: Array<{ status: string; extra: any }> = [];
  const drafts: ApprovalDraft[] = [];
  const abort = new AbortController();
  const ctx: RunContext = {
    run: { id: "run_test", agentKey: "claude", threadId: null, prompt: over.prompt ?? "List the files", cwd: over.cwd ?? null, resumeSessionRef: over.resume ?? null, options: over.options },
    signal: abort.signal,
    emit: (kind, data, o) => void events.push({ kind, data, persist: o?.persist !== false }),
    status: (status, extra) => void statuses.push({ status, extra: extra ?? {} }),
    requestApproval: async (d) => {
      drafts.push(d);
      return (over.decide ?? (() => approve))(d);
    },
  };
  return { ctx, events, statuses, drafts, abort };
}

describe("Claude adapter against a scripted CLI", () => {
  it("runs one turn: session id, auth mode, tool events, text, cost and a clean exit", async () => {
    const box = sandbox();
    const fake = fakeClaude(() => listFiles[0]);
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: box }), approvals: approvalServer(), spawnFn: fake.spawn, env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-test" } });
    expect(adapter.kind).toBe("claude");
    const h = harness();
    await adapter.start(h.ctx).done;

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].inputs).toEqual(["List the files"]);
    expect(fake.calls[0].options.cwd).toBe(box);
    expect(fake.calls[0].options.shell).toBe(false);
    expect(fake.calls[0].options.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(JSON.parse(fake.calls[0].arg("--mcp-config")!).mcpServers.homebase.url).toMatch(/^http:\/\/127\.0\.0\.1:/);

    expect(h.statuses[0]).toEqual({ status: "running", extra: { sessionRef: "a2ef81c0-c0f0-47c5-85d5-3a02fae4dd94" } });
    const system = h.events.find((e) => e.kind === "system")!;
    expect(system.data).toMatchObject({ auth: "subscription (Claude Code login)", authMode: "subscription", apiKeySource: "none", apiKeyStrippedFromEnv: true, resumed: false, permissionProfile: "strict" });
    expect(system.data.message).toContain("auth: subscription (Claude Code login)");
    expect(h.events.filter((e) => e.persist).map((e) => e.kind)).toEqual(["system", "tool_call", "tool_result", "text", "result"]);
    expect(h.events.some((e) => e.kind === "text_delta" && !e.persist)).toBe(true);
    const last = h.statuses.at(-1)!;
    expect(last.status).toBe("succeeded");
    expect(last.extra).toMatchObject({ summary: "a.txt\n\nDone and dusted.", sessionRef: "a2ef81c0-c0f0-47c5-85d5-3a02fae4dd94", costUsd: 0.00188197, numTurns: 2 });
  });

  it("asks the owner through the approval tool, and feeds a follow-up as a second turn of the same process", async () => {
    const box = sandbox();
    const seen: unknown[] = [];
    const fake = fakeClaude(async (call, turn) => {
      if (turn === 0) seen.push(await askApprovalTool(call.arg("--mcp-config")!, { tool_name: "Write", input: { file_path: join(box, "deny.txt"), content: "x" } }));
      return twoTurns[turn];
    });
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: box }), approvals: approvalServer(), spawnFn: fake.spawn, env: {} });
    const h = harness({ prompt: "Create deny.txt", resume: SESSION, decide: () => ({ decision: "deny", message: null, answers: null, remember: false }) });
    const handle = adapter.start(h.ctx);
    handle.input("What is in hello.txt?");
    await handle.done;

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].arg("--resume")).toBe(SESSION);
    expect(fake.calls[0].inputs).toEqual(["Create deny.txt", "What is in hello.txt?"]);
    expect(h.drafts).toEqual([{ kind: "tool", tool: "Write", title: "Write deny.txt", summary: join(box, "deny.txt"), input: { file_path: join(box, "deny.txt"), content: "x" }, risk: "low", reason: "File edit (strict profile)", mode: "manual" }]);
    expect(seen[0]).toMatchObject({ behavior: "deny" });
    expect(h.events.find((e) => e.kind === "system")!.data.resumed).toBe(true);
    expect(h.events.filter((e) => e.kind === "text").map((e) => e.data.text)).toEqual(["refused", "hi"]);
    const last = h.statuses.at(-1)!;
    expect(last.status).toBe("succeeded");
    // cost is the CLI's running total for the process, not the sum of both result lines
    expect(last.extra).toMatchObject({ summary: "hi", numTurns: 3, costUsd: 0.003528330000000001 });
  });

  it("starts a second process with --resume when input arrives after the first one closed its input", async () => {
    let handle: { input(t: string): void } | null = null;
    const fake = fakeClaude(() => (fake.calls.length === 1 ? twoTurns[0] : twoTurns[1]), {
      onStdinEnd: (call) => {
        if (call === fake.calls[0]) handle!.input("And again");
      },
    });
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: sandbox() }), approvals: approvalServer(), spawnFn: fake.spawn, env: {} });
    const h = harness();
    const started = adapter.start(h.ctx);
    handle = started;
    await started.done;
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].arg("--resume")).toBeUndefined();
    expect(fake.calls[1].arg("--resume")).toBe(SESSION);
    expect(fake.calls[1].inputs).toEqual(["And again"]);
    expect(h.events.filter((e) => e.kind === "text").map((e) => e.data.text)).toEqual(["refused", "hi"]);
    expect(h.statuses.at(-1)).toMatchObject({ status: "succeeded", extra: { numTurns: 3 } });
  });

  it("starts a fresh session when the one to resume no longer exists", async () => {
    const gone = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: SESSION, total_cost_usd: 0 });
    const fake = fakeClaude((call) => (call.arg("--resume") ? [gone] : listFiles[0]));
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: sandbox() }), approvals: approvalServer(), spawnFn: fake.spawn, env: {} });
    const h = harness({ resume: SESSION });
    await adapter.start(h.ctx).done;
    expect(fake.calls.map((c) => c.arg("--resume"))).toEqual([SESSION, undefined]);
    expect(fake.calls[1].inputs).toEqual(["List the files"]);
    expect(h.events.find((e) => e.kind === "system")!.data.message).toMatch(/no longer on this machine/);
    expect(h.statuses.at(-1)).toMatchObject({ status: "succeeded", extra: { sessionRef: "a2ef81c0-c0f0-47c5-85d5-3a02fae4dd94" } });
  });

  it("stops the run if the CLI reports API-key auth while set to subscription", async () => {
    const init = JSON.parse(listFiles[0][0]);
    const fake = fakeClaude(() => [JSON.stringify({ ...init, apiKeySource: "ANTHROPIC_API_KEY" }), ...listFiles[0].slice(1)]);
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: sandbox() }), approvals: approvalServer(), spawnFn: fake.spawn, env: {} });
    const h = harness();
    await adapter.start(h.ctx).done;
    expect(fake.calls[0].killed).toBe(true);
    expect(h.statuses.at(-1)!.status).toBe("failed");
    expect(h.statuses.at(-1)!.extra.error).toMatch(/nothing is billed to an API key/);
    expect(h.events.some((e) => e.kind === "text")).toBe(false);
  });

  it("fails clearly on a turn error, when logged out, when not ready and outside the allowlist", async () => {
    const cfg = testConfig({ sandboxDir: sandbox() });
    const err = (o: object) => JSON.stringify({ type: "result", is_error: true, session_id: SESSION, total_cost_usd: 0, ...o });
    const run = async (lines: string[], over: Parameters<typeof harness>[0] = {}, readiness?: ClaudeReadiness) => {
      const fake = fakeClaude(() => lines);
      const h = harness(over);
      await createClaudeCodeAdapter({ config: cfg, approvals: approvalServer(), spawnFn: fake.spawn, env: {}, readiness: readiness ? async () => readiness : undefined }).start(h.ctx).done;
      return { fake, last: h.statuses.at(-1)!, h };
    };
    const max = await run([listFiles[0][0], err({ subtype: "error_max_turns", num_turns: 25 })]);
    expect(max.last).toMatchObject({ status: "failed", extra: { numTurns: 25 } });
    expect(max.last.extra.error).toMatch(/max-turns limit/);

    const out = await run([listFiles[0][0], err({ subtype: "success", result: "Not logged in · Please run /login" })]);
    expect(out.last.extra.error).toContain(NOTE_LOGGED_OUT);

    const notReady = await run(listFiles[0], {}, { ok: false, version: null, note: NOTE_MISSING, checkedAt: 0 });
    expect(notReady.fake.calls).toHaveLength(0);
    expect(notReady.last).toMatchObject({ status: "failed", extra: { error: NOTE_MISSING } });
    expect(notReady.h.events.at(-1)).toMatchObject({ kind: "error", data: { message: NOTE_MISSING } });

    const outside = await run(listFiles[0], { cwd: tmpdir() });
    expect(outside.fake.calls).toHaveLength(0);
    expect(outside.last.extra.error).toMatch(/not one of this connector's allowed working directories/);

    const crashed = fakeClaude(() => [], { exitCode: 1, stderr: "boom: something broke", exitAfterTurn: true });
    const h = harness();
    await createClaudeCodeAdapter({ config: cfg, approvals: approvalServer(), spawnFn: crashed.spawn, env: {} }).start(h.ctx).done;
    expect(h.statuses.at(-1)).toMatchObject({ status: "failed", extra: { error: "Claude Code exited with code 1: boom: something broke" } });
  });

  it("cancels by killing the process tree, and reports cancelled", async () => {
    const fake = fakeClaude(() => new Promise<string[]>(() => {})); // a turn that never finishes
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: sandbox() }), approvals: approvalServer(), spawnFn: fake.spawn, env: {} });
    const h = harness();
    const handle = adapter.start(h.ctx);
    await waitFor(() => fake.calls[0]?.inputs.length === 1, "prompt delivered");
    h.abort.abort();
    handle.cancel();
    await handle.done;
    expect(fake.calls[0].killed).toBe(true);
    expect(h.statuses.map((s) => s.status)).toEqual(["cancelled"]);
  });
});

describe("Claude agent through the hub", () => {
  let app: HubApp | null = null;
  let link: HubLink | null = null;
  const clients: Array<{ client: { stop(): void } }> = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.client.stop();
    link?.stop();
    link = null;
    await app?.close();
    app = null;
  });

  it("shows up for every device, takes a phone approval, and resumes the session on a follow-up", async () => {
    const box = sandbox();
    const cfg = testConfig({ sandboxDir: box });
    const fake = fakeClaude(async (call) => {
      if (fake.calls.length === 1) {
        const verdict = await askApprovalTool(call.arg("--mcp-config")!, { tool_name: "Write", input: { file_path: join(box, "hello.txt"), content: "hi" } });
        if (verdict.behavior !== "allow") throw new Error("expected allow");
        return twoTurns[0];
      }
      return twoTurns[1];
    });
    app = await bootHub();
    const { token } = pairToken(app, "connector", "claude-connector");
    link = new HubLink({
      hubUrl: app.url, token, name: "claude-connector", log: () => {},
      agents: [{
        key: cfg.key, name: cfg.name, kind: "claude", description: "Claude on this machine", capabilities: ["code"], workspaces: claudeWorkspaces(cfg),
        permissionProfile: cfg.permissionProfile, statusNote: null,
        adapter: createClaudeCodeAdapter({ config: cfg, approvals: approvalServer(), spawnFn: fake.spawn, env: {} }),
      }],
    });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    const desktop = await connectDevice(app, "Desktop");
    clients.push(phone, desktop);

    const agent = (await waitFor(() => (desktop.list("agents") as Agent[]).find((a) => a.key === "claude" && a.status === "online"), "claude agent online")) as Agent;
    expect(agent).toMatchObject({ name: "Claude agent", kind: "claude", permissionProfile: "strict", statusNote: null });
    expect(agent.workspaces[0]).toEqual({ label: "sandbox", cwd: box });

    const threadId = newId("thr");
    await desktop.client.mutate("thread.create", { threadId, title: "Claude", agentId: agent.id });
    await desktop.client.mutate("message.send", { threadId, messageId: newId("msg"), text: "Create hello.txt", source: "text" });

    // the approval reaches the phone with the exact input and the policy's tier
    const pending = (await waitFor(() => (phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "approval on the phone")) as Approval;
    expect(pending).toMatchObject({ kind: "tool", tool: "Write", title: "Write hello.txt", risk: "low", input: { file_path: join(box, "hello.txt"), content: "hi" } });
    const runs = () => (desktop.list("runs") as Run[]).filter((r) => r.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    expect(runs()[0].status).toBe("waiting_approval");
    await phone.client.mutate("approval.decide", { approvalId: pending.id, decision: "approve" });

    const first = (await waitFor(() => runs().find((r) => r.status === "succeeded"), "first run done")) as Run;
    expect(first).toMatchObject({ sessionRef: SESSION, cwd: box, summary: "refused" });
    expect(first.costUsd).toBeGreaterThan(0);

    // a follow-up in the same thread is a new run that resumes the same Claude session in the same directory
    await phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text: "And what was in it?", source: "text" });
    await waitFor(() => runs().length === 2 && runs()[1].status === "succeeded", "second run done");
    expect(fake.calls.map((c) => c.arg("--resume"))).toEqual([undefined, SESSION]);
    expect(fake.calls[1].options.cwd).toBe(box);
    expect(runs()[1].sessionRef).toBe(SESSION);
    const texts = (phone.list("messages") as Message[]).filter((m) => m.threadId === threadId && m.role === "assistant").sort((a, b) => a.createdAt - b.createdAt).map((m) => m.text);
    expect(texts).toEqual(["refused", "hi"]);

    // a readiness change is pushed to every device
    link.updateAgent("claude", { statusNote: NOTE_LOGGED_OUT });
    await waitFor(() => (phone.list("agents") as Agent[]).find((a) => a.key === "claude")?.statusNote === NOTE_LOGGED_OUT, "status note on the phone");
  });
});
