import { describe, expect, it } from "vitest";
import { newId } from "@homebase/protocol";
import { resolveMode } from "../src/hub/runs";
import { assertValid, connectConnector, connectDevice, makeHub, mid, peer } from "./helpers";

const dev = (p: { id: string }) => ({ id: p.id, canApprove: true });
const CLAUDE = { key: "claude", name: "Claude agent", kind: "claude" as const, modes: ["manual", "auto", "plan"] as Array<"manual" | "auto" | "plan">, workspaces: [{ label: "sandbox", cwd: "/srv/sandbox" }] };

function setup(agents: any[] = [CLAUDE, { key: "dev", name: "Dev agent", kind: "mock" as const }]) {
  const ctx = makeHub();
  const { hub, directory, store } = ctx;
  const device = connectDevice(hub, directory);
  const other = connectDevice(hub, directory);
  const con = connectConnector(hub, directory, agents);
  const agentId = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'claude'")!.id;
  const row = <T = any>(table: string, id: string) => store.get<T>(`SELECT * FROM ${table} WHERE id = ?`, id)!;
  const cmds = (name: string) => con.of("cmd").filter((c) => c.name === name);
  const thread = () => {
    const threadId = newId("thr");
    hub.mutate(dev(device), mid(), "thread.create", { threadId, title: "t", agentId });
    return threadId;
  };
  const audit = (action: string) => store.all<{ detail: string; actor_id: string | null }>("SELECT * FROM audit_log WHERE action = ? ORDER BY at, id", action).map((a) => ({ ...JSON.parse(a.detail), actor: a.actor_id }));
  return { ...ctx, device, other, con, agentId, row, cmds, thread, audit };
}

describe("permission mode resolution", () => {
  it("prefers the run's own mode, then the chat, then the agent, then manual", () => {
    const agent = { modes: ["manual", "auto", "plan"] as any, defaultMode: "auto" as const };
    expect(resolveMode(agent, null)).toBe("auto");
    expect(resolveMode(agent, { mode: "plan" })).toBe("plan");
    expect(resolveMode(agent, { mode: "plan" }, "manual")).toBe("manual");
    expect(resolveMode({ ...agent, defaultMode: null }, { mode: null })).toBe("manual");
  });

  it("never returns a mode the connector did not offer, and none for agents without modes", () => {
    expect(resolveMode({ modes: ["manual", "plan"], defaultMode: "manual" }, { mode: "auto" })).toBe("manual");
    expect(resolveMode({ modes: ["manual"], defaultMode: "auto" as any }, null, "bypassPermissions")).toBe("manual");
    expect(resolveMode({ modes: null, defaultMode: null }, { mode: "auto" })).toBeNull();
    expect(resolveMode({ modes: [], defaultMode: null }, null, "auto")).toBeNull();
  });
});

describe("mode.set", () => {
  it("an agent registers with Manual as its default, and the owner's choice survives a connector restart", () => {
    const s = setup();
    expect(s.row("agents", s.agentId)).toMatchObject({ default_mode: "manual", modes: '["manual","auto","plan"]' });
    expect(s.hub.mutate(dev(s.device), mid(), "mode.set", { scope: "agent", id: s.agentId, mode: "auto" }).ok).toBe(true);
    expect(s.row("agents", s.agentId).default_mode).toBe("auto");
    expect(s.audit("mode.set")).toEqual([{ scope: "agent", from: "manual", to: "auto", actor: s.device.id }]);
    // Synced to the other device as an ordinary change, and the row is valid against the shared schema.
    const change = s.other.of("changes").flatMap((f) => f.changes).filter((c) => c.entity === "agents" && c.id === s.agentId).at(-1);
    expect(change.data.defaultMode).toBe("auto");
    assertValid("agents", change.data);

    s.hub.onFrame(s.con, { t: "register", host: { name: "c", os: "t" }, agents: [{ description: "", capabilities: [], ...CLAUDE }] });
    expect(s.row("agents", s.agentId).default_mode).toBe("auto");
    // If the connector stops offering that mode, the default falls back to Manual.
    s.hub.onFrame(s.con, { t: "register", host: { name: "c", os: "t" }, agents: [{ description: "", capabilities: [], ...CLAUDE, modes: ["manual", "plan"] }] });
    expect(s.row("agents", s.agentId).default_mode).toBe("manual");
  });

  it("re-registering an unchanged agent writes no change", () => {
    const s = setup();
    const before = s.hub.currentSeq();
    s.hub.onFrame(s.con, { t: "register", host: { name: "test-connector", os: "test" }, agents: [{ description: "", capabilities: [], ...CLAUDE }, { key: "dev", name: "Dev agent", kind: "mock", description: "", capabilities: [], workspaces: [] }] });
    const changed = s.hub.changesAfter(before).filter((c) => c.entity === "agents");
    expect(changed).toHaveLength(0);
  });

  it("refuses unknown agents, modes the agent does not offer, agents without modes and devices that cannot approve", () => {
    const s = setup([{ ...CLAUDE, modes: ["manual", "plan"] }, { key: "dev", name: "Dev agent", kind: "mock" as const }]);
    const set = (args: object, device = dev(s.device)) => s.hub.mutate(device, mid(), "mode.set", args);
    expect(set({ scope: "agent", id: s.agentId, mode: "auto" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(set({ scope: "agent", id: s.agentId, mode: null })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(set({ scope: "agent", id: "agt_nope", mode: "manual" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const mock = s.store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!.id;
    expect(set({ scope: "agent", id: mock, mode: "manual" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(set({ scope: "agent", id: s.agentId, mode: "plan" }, { id: s.device.id, canApprove: false })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(s.row("agents", s.agentId).default_mode).toBe("manual");
    expect(set({ scope: "thread", id: "thr_nope", mode: "plan" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("a chat's override decides the mode of its next run; clearing it follows the agent again", () => {
    const s = setup();
    const threadId = s.thread();
    const send = (text: string) => s.hub.mutate(dev(s.device), mid(), "message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    const finish = () => {
      const run = s.cmds("run.start").at(-1).run;
      s.hub.onFrame(s.con, { t: "run.status", runId: run.id, status: "succeeded", at: s.hub.now() });
      return run;
    };
    send("one");
    expect(finish().options.mode).toBe("manual");

    expect(s.hub.mutate(dev(s.device), mid(), "mode.set", { scope: "thread", id: threadId, mode: "auto" }).ok).toBe(true);
    expect(s.row("threads", threadId).mode).toBe("auto");
    send("two");
    const two = finish();
    expect(two.options.mode).toBe("auto");
    expect(s.row("runs", two.id).mode).toBe("auto");
    expect(s.audit("run.start").at(-1).mode).toBe("auto");

    s.hub.mutate(dev(s.device), mid(), "mode.set", { scope: "agent", id: s.agentId, mode: "plan" });
    send("three");
    expect(finish().options.mode).toBe("auto"); // the chat still overrides the agent
    s.hub.mutate(dev(s.device), mid(), "mode.set", { scope: "thread", id: threadId, mode: null });
    send("four");
    expect(finish().options.mode).toBe("plan");
    const th = s.other.of("changes").flatMap((f) => f.changes).filter((c) => c.entity === "threads" && c.id === threadId).at(-1);
    assertValid("threads", th.data);
  });

  it("changing a chat's mode while its run is live reaches the connector; plan waits for the next run", () => {
    const s = setup();
    const threadId = s.thread();
    s.hub.mutate(dev(s.device), mid(), "message.send", { threadId, messageId: newId("msg"), text: "go", source: "text" });
    const run = s.cmds("run.start")[0].run;
    s.hub.onFrame(s.con, { t: "run.status", runId: run.id, status: "running", at: s.hub.now() });

    s.hub.mutate(dev(s.device), mid(), "mode.set", { scope: "thread", id: threadId, mode: "auto" });
    expect(s.cmds("run.mode")).toHaveLength(1);
    expect(s.cmds("run.mode")[0]).toMatchObject({ runId: run.id, mode: "auto" });
    expect(s.row("runs", run.id).mode).toBe("auto");

    s.hub.mutate(dev(s.device), mid(), "mode.set", { scope: "thread", id: threadId, mode: "plan" });
    expect(s.cmds("run.mode")).toHaveLength(1); // not sent: the live run stays in Auto
    expect(s.row("runs", run.id).mode).toBe("auto");
    expect(s.row("threads", threadId).mode).toBe("plan");
    expect(s.audit("mode.set").map((a) => a.scope)).toEqual(["thread", "run", "thread"]);
  });
});

describe("plan approvals", () => {
  function planned(startMode: "plan" | "manual" = "plan") {
    const s = setup();
    const threadId = s.thread();
    s.hub.mutate(dev(s.device), mid(), "mode.set", { scope: "thread", id: threadId, mode: startMode });
    s.hub.mutate(dev(s.device), mid(), "message.send", { threadId, messageId: newId("msg"), text: "add a footer", source: "text" });
    const run = s.cmds("run.start")[0].run;
    s.hub.onFrame(s.con, { t: "run.status", runId: run.id, status: "running", at: s.hub.now() });
    const approvalId = newId("apr");
    s.hub.onFrame(s.con, {
      t: "approval.request",
      approval: { id: approvalId, runId: run.id, kind: "plan", tool: "ExitPlanMode", title: "Plan ready for review", summary: "Add a footer", input: { plan: "## Plan\n1. Add a footer" }, risk: "low", requestedAt: s.hub.now(), mode: "plan" },
    });
    const decide = (args: object) => s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId, ...args });
    return { ...s, threadId, run, approvalId, decide };
  }

  it("starts the run in plan mode and raises a plan card that cannot be approved from a notification", () => {
    const s = planned();
    expect(s.run.options.mode).toBe("plan");
    const apr = s.row("approvals", s.approvalId);
    expect(apr).toMatchObject({ kind: "plan", status: "pending", mode: "plan", tool: "ExitPlanMode" });
    expect(JSON.parse(apr.input).plan).toContain("Add a footer");
    const n = s.device.of("notify").map((f) => f.notification).find((x) => x.channel === "approvals");
    expect(n).toMatchObject({ title: "Claude agent has a plan to review", actions: ["open"] });
    const change = s.other.of("changes").flatMap((f) => f.changes).find((c) => c.entity === "approvals" && c.id === s.approvalId);
    assertValid("approvals", change.data);
  });

  it("Approve & run in Auto: the run and its chat switch to Auto, the connector is told, and the audit log has the mode", () => {
    const s = planned();
    expect(s.decide({ decision: "approve", mode: "auto" }).ok).toBe(true);
    expect(s.cmds("approval.decision")[0]).toMatchObject({ approvalId: s.approvalId, decision: "approve", mode: "auto" });
    expect(s.row("approvals", s.approvalId)).toMatchObject({ status: "approved", mode: "auto" });
    expect(s.row("runs", s.run.id).mode).toBe("auto");
    expect(s.row("threads", s.threadId).mode).toBe("auto");
    expect(s.audit("approval.decide")[0]).toMatchObject({ decision: "approve", kind: "plan", mode: "auto", actor: s.device.id });
    // The next message in the chat runs in the approved mode.
    s.hub.onFrame(s.con, { t: "run.status", runId: s.run.id, status: "succeeded", at: s.hub.now() });
    s.hub.mutate(dev(s.device), mid(), "message.send", { threadId: s.threadId, messageId: newId("msg"), text: "and a header", source: "text" });
    expect(s.cmds("run.start")[1].run.options.mode).toBe("auto");
  });

  it("Approve & run in Manual, and approving without a choice, both continue in Manual", () => {
    const a = planned();
    expect(a.decide({ decision: "approve", mode: "manual" }).ok).toBe(true);
    expect(a.cmds("approval.decision")[0].mode).toBe("manual");
    expect(a.row("threads", a.threadId).mode).toBe("manual");
    const b = planned();
    expect(b.decide({ decision: "approve" }).ok).toBe(true); // an older client that only knows Approve
    expect(b.cmds("approval.decision")[0].mode).toBe("manual");
    expect(b.row("runs", b.run.id).mode).toBe("manual");
  });

  it("Keep planning: denied with the owner's message, and the run and chat stay in Plan", () => {
    const s = planned();
    expect(s.decide({ decision: "deny", message: "also cover mobile" }).ok).toBe(true);
    expect(s.cmds("approval.decision")[0]).toMatchObject({ decision: "deny", message: "also cover mobile", mode: null });
    expect(s.row("approvals", s.approvalId)).toMatchObject({ status: "denied", mode: "plan", decision_message: "also cover mobile" });
    expect(s.row("runs", s.run.id).mode).toBe("plan");
    expect(s.row("threads", s.threadId).mode).toBe("plan");
  });

  it("only a device that can approve may approve a plan", () => {
    const s = planned();
    expect(s.hub.mutate({ id: s.device.id, canApprove: false }, mid(), "approval.decide", { approvalId: s.approvalId, decision: "approve", mode: "auto" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(s.row("runs", s.run.id).mode).toBe("plan");
  });
});

describe("auditing what ran without asking", () => {
  it("records auto-approvals and policy blocks from the run timeline, with the mode", () => {
    const s = setup();
    const runId = newId("run");
    s.hub.mutate(dev(s.device), mid(), "run.start", { runId, agentId: s.agentId, prompt: "write a file", options: { mode: "auto" } });
    expect(s.row("runs", runId).mode).toBe("auto");
    s.hub.onFrame(s.con, { t: "run.status", runId, status: "running", at: s.hub.now() });
    const ev = (idx: number, data: Record<string, unknown>) => s.hub.onFrame(s.con, { t: "run.event", runId, idx, at: s.hub.now(), kind: "system", persist: true, data });
    ev(0, { message: "Auto-approved: Write x.ts", decision: "auto_approved", mode: "auto", tool: "Write", title: "Write x.ts", summary: "/srv/sandbox/src/x.ts", reason: "File edit inside the workspace (auto mode)" });
    ev(1, { message: "Blocked by policy: Read .env", decision: "blocked", mode: "auto", tool: "Read", title: "Read .env", summary: "/srv/sandbox/.env", reason: "Hard deny: credential or secret file" });
    ev(2, { message: "Claude session started" });
    ev(0, { message: "Auto-approved: Write x.ts", decision: "auto_approved", mode: "auto", tool: "Write", title: "Write x.ts" }); // replay
    expect(s.audit("approval.auto")).toEqual([{ runId, mode: "auto", tool: "Write", title: "Write x.ts", summary: "/srv/sandbox/src/x.ts", reason: "File edit inside the workspace (auto mode)", actor: s.con.id }]);
    expect(s.audit("approval.blocked")).toHaveLength(1);
    expect(s.audit("approval.blocked")[0]).toMatchObject({ mode: "auto", tool: "Read", reason: "Hard deny: credential or secret file" });
  });

  it("takes the run's real mode from the connector when it refused the one asked for", () => {
    const s = setup();
    const runId = newId("run");
    s.hub.mutate(dev(s.device), mid(), "run.start", { runId, agentId: s.agentId, prompt: "x", options: { mode: "auto" } });
    s.hub.onFrame(s.con, { t: "run.event", runId, idx: 0, at: s.hub.now(), kind: "system", persist: true, data: { message: "This connector does not allow auto mode; running in Manual.", mode: "manual", modeChanged: true } });
    expect(s.row("runs", runId).mode).toBe("manual");
    // A connector that does not own the run cannot change anything.
    const stranger = peer("con_other", "connector", false);
    s.hub.onFrame(stranger, { t: "run.event", runId, idx: 1, at: s.hub.now(), kind: "system", persist: true, data: { message: "x", mode: "auto", modeChanged: true, decision: "auto_approved" } });
    expect(s.row("runs", runId).mode).toBe("manual");
    expect(s.audit("approval.auto")).toHaveLength(0);
  });

  it("stores the auth facts a connector registers, and they satisfy the shared schema", () => {
    const auth = { authMode: "subscription" as const, cliVersion: "2.1.301", apiKeySource: "none", model: "claude-haiku-5-5", envStripped: true, strippedPatterns: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_*"], strippedCount: 0, loggedIn: true, checkedAt: 1, lastRunAt: null };
    const s = setup([{ ...CLAUDE, auth }]);
    expect(JSON.parse(s.row("agents", s.agentId).auth)).toEqual(auth);
    const snap = s.hub.snapshot().entities.agents as any[];
    for (const a of snap) assertValid("agents", a);
    expect(snap.find((a) => a.id === s.agentId).auth.apiKeySource).toBe("none");
  });
});
