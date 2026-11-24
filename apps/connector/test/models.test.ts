import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EFFORTS, newId, type Agent, type Message, type Run, type RunEventKind, type Thread } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { buildArgs, createClaudeCodeAdapter, pickModel } from "../src/adapters/claude-code";
import type { RunContext } from "../src/adapters/types";
import { claudeModels, claudeWorkspaces, loadClaudeConfig, modelFacts, MOCK_AGENTS } from "../src/config";
import { commsConfig } from "../src/gmail/comms";
import { HubLink } from "../src/HubLink";
import { fakeClaude, fixture, testConfig, turnsOf } from "./claude-fixtures";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const IDS = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const SESSION = "306b18cd-e629-4f05-80d2-39435a768c6a";
const listFiles = turnsOf(fixture("claude-list-files.jsonl"));
const twoTurns = turnsOf(fixture("claude-denied-then-followup.jsonl"));

const dirs: string[] = [];
const sandbox = () => {
  const d = mkdtempSync(join(tmpdir(), "hb-models-"));
  dirs.push(d);
  return d;
};
const servers: ApprovalServer[] = [];
const approvalServer = () => {
  const s = new ApprovalServer();
  servers.push(s);
  return s;
};
let app: HubApp | null = null;
let link: HubLink | null = null;
const clients: Array<{ client: { stop(): void } }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.client.stop();
  link?.stop();
  link = null;
  await app?.close();
  app = null;
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the command line: --model and --effort", () => {
  const val = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

  it("with nothing chosen it is the command line from before: the configured model and no --effort", () => {
    const args = buildArgs(testConfig({ model: "sonnet" }), { resume: null, mcpConfig: "{}" });
    expect(val(args, "--model")).toBe("sonnet");
    expect(args).not.toContain("--effort");
  });

  it("passes the chosen model and effort, and still resumes the session", () => {
    const args = buildArgs(testConfig({ model: "sonnet" }), { resume: SESSION, mcpConfig: "{}", model: "claude-opus-5-5", effort: "xhigh" });
    expect(val(args, "--model")).toBe("claude-opus-5-5");
    expect(val(args, "--effort")).toBe("xhigh");
    expect(args.slice(-2)).toEqual(["--resume", SESSION]); // another model on the same conversation
    expect(args.filter((a) => a === "--model")).toHaveLength(1);
    expect(args.join(" ")).not.toMatch(/dangerously|bypassPermissions/);
  });

  it("uses the connector's configured effort when the owner chose none, and lets a run turn it off again", () => {
    const cfg = testConfig({ effort: "medium" });
    expect(val(buildArgs(cfg, { resume: null, mcpConfig: "{}" }), "--effort")).toBe("medium");
    expect(val(buildArgs(cfg, { resume: null, mcpConfig: "{}", effort: "max" }), "--effort")).toBe("max");
    expect(buildArgs(cfg, { resume: null, mcpConfig: "{}", effort: null })).not.toContain("--effort");
  });
});

describe("what the connector offers and accepts", () => {
  it("offers the four current models by full name, always including its own configured one", () => {
    expect(claudeModels(testConfig({ model: "sonnet" }))).toEqual(IDS);
    expect(claudeModels(testConfig({ model: "sonnet", models: ["haiku", "opus"] }))).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(claudeModels(testConfig({ model: "claude-sonnet-5-5", models: [] }))).toEqual(["claude-sonnet-5-5"]); // pinned to one model
    expect(claudeModels(testConfig({ model: "my-fine-tune" }))).toEqual([...IDS, "my-fine-tune"]);
    expect(modelFacts(testConfig({ model: "sonnet" }))).toEqual({ models: IDS, efforts: [...EFFORTS], model: "claude-sonnet-5-5", effort: null });
    expect(modelFacts(testConfig({ model: "haiku", effort: "low" }))).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
  });

  it("the Comms agent can run on its own model and offers the same list", () => {
    const comms = commsConfig(testConfig({ model: "opus" }), { HOMEBASE_DATA_DIR: join(tmpdir(), "hb"), HB_COMMS_MODEL: "sonnet" });
    expect(comms.model).toBe("sonnet");
    expect(modelFacts(comms)).toMatchObject({ models: IDS, model: "claude-sonnet-5-5" });
  });

  it("scripted agents offer no models at all", () => {
    for (const a of MOCK_AGENTS) {
      expect(a.models).toBeUndefined();
      expect(a.efforts).toBeUndefined();
    }
  });

  it("runs what the hub asks for only when it is on its list; anything else falls back to its own setting and is named", () => {
    const cfg = testConfig({ model: "sonnet", models: ["sonnet", "haiku"] });
    expect(pickModel(cfg)).toEqual({ model: "sonnet", effort: null, refused: [] });
    expect(pickModel(cfg, { model: "claude-haiku-5-5", effort: "low" })).toEqual({ model: "claude-haiku-5-5", effort: "low", refused: [] });
    expect(pickModel(cfg, { model: "haiku" })).toMatchObject({ model: "claude-haiku-5-5" });
    expect(pickModel(cfg, { model: "claude-sonnet-5-5" })).toMatchObject({ model: "sonnet" }); // its own model keeps its own spelling
    expect(pickModel(cfg, { model: "claude-fable-5-2" })).toEqual({ model: "sonnet", effort: null, refused: ["model claude-fable-5-2"] });
    expect(pickModel(cfg, { model: "--dangerously-skip-permissions", effort: "ludicrous" })).toEqual({
      model: "sonnet", effort: null, refused: ["model --dangerously-skip-permissions", "effort ludicrous"],
    });
    expect(pickModel(cfg, { model: 7, effort: ["max"] }).refused).toHaveLength(2);
    expect(pickModel(testConfig({ effort: "high" }), {})).toMatchObject({ effort: "high" });
  });

  it("reads models and effort from the config file and drops anything that is not a plain model name or a real effort", () => {
    const dir = sandbox();
    const path = join(dir, "claude-agent.json");
    writeFileSync(path, JSON.stringify({ model: "opus", models: ["opus", "haiku", "bad model", "--flag", 12], effort: "high" }));
    expect(loadClaudeConfig(path, {})).toMatchObject({ model: "opus", models: ["opus", "haiku", "12"], effort: "high" });
    writeFileSync(path, JSON.stringify({ model: "two words", effort: "turbo" }));
    const cfg = loadClaudeConfig(path, {});
    expect(cfg).toMatchObject({ model: "sonnet", effort: null });
    expect(cfg.models).toBeUndefined();
    expect(loadClaudeConfig(join(dir, "none.json"), {})).toMatchObject({ model: "sonnet", effort: null }); // the defaults did not move
  });
});

function harness(options?: Record<string, unknown>, resume: string | null = null) {
  const events: Array<{ kind: RunEventKind; data: any }> = [];
  const statuses: string[] = [];
  const ctx: RunContext = {
    run: { id: "run_test", agentKey: "claude", threadId: null, prompt: "List the files", cwd: null, resumeSessionRef: resume, options },
    signal: new AbortController().signal,
    emit: (kind, data) => void events.push({ kind, data }),
    status: (status) => void statuses.push(status),
    requestApproval: async () => ({ decision: "approve", message: null, answers: null, remember: false }),
  };
  return { ctx, events, statuses };
}

describe("the Claude adapter with a chosen model", () => {
  it("starts the CLI with the model and effort the run asks for, and says which on the timeline", async () => {
    const fake = fakeClaude(() => listFiles[0]);
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: sandbox(), model: "sonnet" }), approvals: approvalServer(), spawnFn: fake.spawn, env: { PATH: process.env.PATH } });
    const h = harness({ model: "claude-opus-5-5", effort: "high" }, SESSION);
    await adapter.start(h.ctx).done;
    expect(fake.calls[0].arg("--model")).toBe("claude-opus-5-5");
    expect(fake.calls[0].arg("--effort")).toBe("high");
    expect(fake.calls[0].arg("--resume")).toBe(SESSION);
    const init = h.events.find((e) => e.kind === "system" && e.data.sessionId)!;
    expect(init.data).toMatchObject({ effort: "high" });
    expect(init.data.message).toMatch(/· High effort ·/);
    expect(h.statuses.at(-1)).toBe("succeeded");
  });

  it("without a choice it runs exactly as before, and a model it does not offer is refused in the open", async () => {
    const fake = fakeClaude(() => listFiles[0]);
    const cfg = testConfig({ sandboxDir: sandbox(), model: "sonnet", models: ["sonnet"] });
    const adapter = createClaudeCodeAdapter({ config: cfg, approvals: approvalServer(), spawnFn: fake.spawn, env: { PATH: process.env.PATH } });
    const plain = harness();
    await adapter.start(plain.ctx).done;
    expect(fake.calls[0].arg("--model")).toBe("sonnet");
    expect(fake.calls[0].args).not.toContain("--effort");
    expect(plain.events.find((e) => e.kind === "system" && e.data.sessionId)!.data.message).toMatch(/· default effort ·/);

    const refused = harness({ model: "claude-fable-5-2" });
    await adapter.start(refused.ctx).done;
    expect(fake.calls[1].arg("--model")).toBe("sonnet");
    expect(refused.events.some((e) => e.kind === "system" && /does not offer model claude-fable-5-2; running on Sonnet 5\.5 instead/.test(e.data.message))).toBe(true);
  });
});

describe("model and effort through the hub, with a scripted CLI", () => {
  it("a session starts on the agent's default, switches model mid-session with the conversation kept, then starts fresh", async () => {
    const box = sandbox();
    const cfg = testConfig({ sandboxDir: box, model: "sonnet" });
    const fake = fakeClaude(() => (fake.calls.length === 1 ? listFiles[0] : twoTurns[1]));
    app = await bootHub();
    const { token } = pairToken(app, "connector", "claude-connector");
    link = new HubLink({
      hubUrl: app.url, token, name: "claude-connector", log: () => {},
      agents: [{
        key: cfg.key, name: cfg.name, kind: "claude", description: "Claude on this machine", capabilities: ["code"], workspaces: claudeWorkspaces(cfg),
        permissionProfile: cfg.permissionProfile, statusNote: null, modes: ["manual", "auto"], ...modelFacts(cfg),
        adapter: createClaudeCodeAdapter({ config: cfg, approvals: approvalServer(), spawnFn: fake.spawn, env: {} }),
      }],
    });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    const desktop = await connectDevice(app, "Desktop");
    clients.push(phone, desktop);

    const agent = (await waitFor(() => (desktop.list("agents") as Agent[]).find((a) => a.key === "claude" && a.status === "online"), "claude agent online")) as Agent;
    expect(agent).toMatchObject({ models: IDS, efforts: [...EFFORTS], configModel: "claude-sonnet-5-5", defaultModel: null });

    const threadId = newId("thr");
    const thread = (c = desktop) => (c.list("threads") as Thread[]).find((t) => t.id === threadId)!;
    const runs = (c = desktop) => (c.list("runs") as Run[]).filter((r) => r.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const markers = (c = desktop) => (c.list("messages") as Message[]).filter((m) => m.threadId === threadId && m.card?.type === "session_marker").sort((a, b) => a.createdAt - b.createdAt);
    const send = (text: string) => phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    await phone.client.mutate("thread.create", { threadId, title: "Claude", agentId: agent.id });

    // 1. Nothing chosen: the connector's own model, no --effort.
    await send("List the files");
    await waitFor(() => runs().length === 1 && runs()[0].status === "succeeded", "first run done");
    expect(fake.calls[0].arg("--model")).toBe("sonnet");
    expect(fake.calls[0].args).not.toContain("--effort");
    expect(fake.calls[0].arg("--resume")).toBeUndefined();
    const session = runs()[0].sessionRef!;
    expect(runs()[0]).toMatchObject({ model: null, effort: null }); // nothing was asked for

    // 2. Pick a model and an effort on the phone: seen on the desktop at once, used by the next run, conversation kept.
    const set = phone.client.mutate("model.set", { scope: "thread", id: threadId, model: "claude-opus-5-5", effort: "high" });
    expect(thread(phone)).toMatchObject({ model: "claude-opus-5-5", effort: "high" }); // optimistic
    expect((await set).ok).toBe(true);
    await waitFor(() => thread().model === "claude-opus-5-5", "choice on the desktop");
    await send("And what was in it?");
    await waitFor(() => runs().length === 2 && runs()[1].status === "succeeded", "second run done");
    expect(fake.calls[1].arg("--model")).toBe("claude-opus-5-5");
    expect(fake.calls[1].arg("--effort")).toBe("high");
    expect(fake.calls[1].arg("--resume")).toBe(session);
    expect(fake.calls[1].options.cwd).toBe(box);
    await waitFor(() => markers().length === 1, "switch marker on the desktop");
    expect(markers()[0]).toMatchObject({ role: "system", text: "Now on Opus 5.5 · High. The conversation is kept.", card: { kind: "switch", model: "claude-opus-5-5", effort: "high" } });

    // 3. Start fresh on another model: no --resume, and the session says the agent no longer sees what came before.
    expect((await phone.client.mutate("model.set", { scope: "thread", id: threadId, model: "claude-haiku-5-5", effort: null, fresh: true })).ok).toBe(true);
    await send("New topic");
    await waitFor(() => runs().length === 3 && runs()[2].status === "succeeded", "third run done");
    expect(fake.calls[2].arg("--model")).toBe("claude-haiku-5-5");
    expect(fake.calls[2].args).not.toContain("--effort");
    expect(fake.calls[2].arg("--resume")).toBeUndefined();
    expect(fake.calls[2].options.cwd).toBe(box);
    await waitFor(() => markers().length === 2, "fresh marker on the desktop");
    expect(markers()[1]).toMatchObject({ card: { kind: "fresh", model: "claude-haiku-5-5", effort: null } });
    expect(markers()[1].text).toMatch(/does not see the messages above/);
    // Every message is still there.
    expect((desktop.list("messages") as Message[]).filter((m) => m.threadId === threadId && m.role === "user").map((m) => m.text).sort()).toEqual(["And what was in it?", "List the files", "New topic"]);
  });
});
