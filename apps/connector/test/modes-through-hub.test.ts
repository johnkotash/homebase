import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type Agent, type Approval, type Run, type RunEvent, type Thread } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { buildAuthProof, createClaudeCodeAdapter } from "../src/adapters/claude-code";
import { claudeWorkspaces } from "../src/config";
import { HubLink } from "../src/HubLink";
import { askApprovalTool, fakeClaude, fixture, testConfig, turnsOf } from "./claude-fixtures";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const listFiles = turnsOf(fixture("claude-list-files.jsonl"));

/** Real sockets end to end: two devices, the hub, the connector and the Claude adapter over a scripted CLI. */
describe("permission modes through the hub", () => {
  let app: HubApp | null = null;
  let link: HubLink | null = null;
  const clients: Array<{ client: { stop(): void } }> = [];
  const servers: ApprovalServer[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.client.stop();
    link?.stop();
    link = null;
    for (const s of servers.splice(0)) await s.stop();
    await app?.close();
    app = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function boot(script: Parameters<typeof fakeClaude>[0]) {
    const box = mkdtempSync(join(tmpdir(), "hb-modes-hub-"));
    dirs.push(box);
    const cfg = testConfig({ sandboxDir: box });
    const fake = fakeClaude(script);
    const approvals = new ApprovalServer();
    servers.push(approvals);
    app = await bootHub();
    const { token } = pairToken(app, "connector", "claude-connector");
    const readiness = { ok: true, version: "2.1.301", note: null, checkedAt: Date.now() };
    link = new HubLink({
      hubUrl: app.url, token, name: "claude-connector", log: () => {},
      agents: [{
        key: cfg.key, name: cfg.name, kind: "claude", description: "Claude on this machine", capabilities: ["code"], workspaces: claudeWorkspaces(cfg),
        permissionProfile: cfg.permissionProfile, statusNote: null, modes: cfg.modes, auth: buildAuthProof(cfg, readiness, null, {}),
        adapter: createClaudeCodeAdapter({
          config: cfg, approvals, spawnFn: fake.spawn, env: {},
          onRunFacts: (facts) => link!.updateAgent(cfg.key, { auth: buildAuthProof(cfg, readiness, facts, {}) }),
        }),
      }],
    });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    const desktop = await connectDevice(app, "Desktop");
    clients.push(phone, desktop);
    const agent = (await waitFor(() => (desktop.list("agents") as Agent[]).find((a) => a.key === "claude" && a.status === "online"), "claude agent online")) as Agent;
    const threadId = newId("thr");
    await desktop.client.mutate("thread.create", { threadId, title: "Claude", agentId: agent.id });
    const runs = () => (phone.list("runs") as Run[]).filter((r) => r.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const thread = (who = phone) => (who.list("threads") as Thread[]).find((t) => t.id === threadId)!;
    const events = (runId: string) => app!.store.all<{ kind: string; data: string }>("SELECT kind, data FROM run_events WHERE run_id = ? ORDER BY idx", runId).map((e) => ({ kind: e.kind, data: JSON.parse(e.data) })) as Array<Pick<RunEvent, "kind" | "data">>;
    const audit = (action: string) => app!.store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = ? ORDER BY at, id", action).map((a) => JSON.parse(a.detail));
    return { box, fake, phone, desktop, agent, threadId, runs, thread, events, audit };
  }

  it("the agent offers three modes, defaults to Manual, and shows its auth facts on every device", async () => {
    const s = await boot(() => listFiles[0]);
    expect(s.agent).toMatchObject({ modes: ["manual", "auto", "plan"], defaultMode: "manual" });
    expect(s.agent.auth).toMatchObject({ authMode: "subscription", cliVersion: "2.1.301", apiKeySource: null, envStripped: true, loggedIn: true });
    // After a run, the CLI's own apiKeySource is part of the facts.
    await s.phone.client.mutate("message.send", { threadId: s.threadId, messageId: newId("msg"), text: "List the files", source: "text" });
    await waitFor(() => s.runs()[0]?.status === "succeeded", "run done");
    const after = (await waitFor(() => (s.phone.list("agents") as Agent[]).find((a) => a.key === "claude" && a.auth?.apiKeySource === "none"), "apiKeySource on the phone")) as Agent;
    expect(after.auth!.lastRunAt).toBeGreaterThan(0);
    expect(after.defaultMode).toBe("manual");
  });

  it("a mode set on the phone reaches the desktop within a second, and Auto writes without an approval", async () => {
    const s = await boot(async (call) => {
      const res = await askApprovalTool(call.arg("--mcp-config")!, { tool_name: "Write", input: { file_path: join(s.box, "auto.txt"), content: "ok" } });
      if (res.behavior !== "allow") throw new Error("expected allow");
      return listFiles[0];
    });
    const t0 = Date.now();
    await s.phone.client.mutate("mode.set", { scope: "thread", id: s.threadId, mode: "auto" });
    await waitFor(() => s.thread(s.desktop).mode === "auto", "mode on the desktop");
    expect(Date.now() - t0).toBeLessThan(1000);

    await s.phone.client.mutate("message.send", { threadId: s.threadId, messageId: newId("msg"), text: "Create auto.txt", source: "text" });
    const run = (await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "auto run done")) as Run;
    expect(run.mode).toBe("auto");
    expect(s.phone.list("approvals")).toHaveLength(0); // nothing was asked
    expect(s.events(run.id).filter((e) => e.data.decision).map((e) => e.data.message)).toEqual(["Auto-approved: Write auto.txt"]);
    expect(s.audit("approval.auto")).toEqual([{ runId: run.id, mode: "auto", tool: "Write", title: "Write auto.txt", summary: join(s.box, "auto.txt"), reason: "File edit inside the workspace (auto mode)" }]);
  });

  it("Manual asks on every device; the default mode of the agent is used when the chat has no override", async () => {
    const s = await boot(async (call) => {
      await askApprovalTool(call.arg("--mcp-config")!, { tool_name: "Write", input: { file_path: join(s.box, "manual.txt"), content: "ok" } });
      return listFiles[0];
    });
    await s.desktop.client.mutate("message.send", { threadId: s.threadId, messageId: newId("msg"), text: "Create manual.txt", source: "text" });
    const pending = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "approval on the phone")) as Approval;
    expect(pending).toMatchObject({ kind: "tool", tool: "Write", risk: "low", mode: "manual" });
    expect(s.runs()[0]).toMatchObject({ status: "waiting_approval", mode: "manual" });
    await s.phone.client.mutate("approval.decide", { approvalId: pending.id, decision: "approve" });
    await waitFor(() => s.runs()[0].status === "succeeded", "manual run done");
    expect(s.audit("approval.auto")).toHaveLength(0);
  });

  it("Plan: the plan card reaches the phone, 'Approve & run in Auto' continues the run and switches the chat", async () => {
    const seen: string[] = [];
    const s = await boot(async (call) => {
      const cfg = call.arg("--mcp-config")!;
      seen.push((await askApprovalTool(cfg, { tool_name: "ExitPlanMode", input: { plan: "## Plan\n1. Create `plan.txt`", planFilePath: "/home/o/.claude/plans/p.md" } })).behavior);
      seen.push((await askApprovalTool(cfg, { tool_name: "Write", input: { file_path: join(s.box, "plan.txt"), content: "ok" } })).behavior);
      return listFiles[0];
    });
    await s.desktop.client.mutate("mode.set", { scope: "thread", id: s.threadId, mode: "plan" });
    await s.desktop.client.mutate("message.send", { threadId: s.threadId, messageId: newId("msg"), text: "Create plan.txt", source: "text" });

    const card = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "plan card on the phone")) as Approval;
    expect(card).toMatchObject({ kind: "plan", tool: "ExitPlanMode", title: "Plan ready for review", mode: "plan", input: { plan: "## Plan\n1. Create `plan.txt`" } });
    expect(s.fake.calls[0].arg("--permission-mode")).toBe("plan");
    expect(s.runs()[0]).toMatchObject({ status: "waiting_approval", mode: "plan" });

    await s.phone.client.mutate("approval.decide", { approvalId: card.id, decision: "approve", mode: "auto" });
    const run = (await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "plan run done")) as Run;
    expect(seen).toEqual(["allow", "allow"]);
    expect(run.mode).toBe("auto");
    await waitFor(() => s.thread(s.desktop).mode === "auto", "chat switched to Auto on the desktop");
    expect((s.desktop.list("approvals") as Approval[]).find((a) => a.id === card.id)).toMatchObject({ status: "approved", mode: "auto" });
    expect((s.phone.list("approvals") as Approval[]).filter((a) => a.kind === "tool")).toHaveLength(0); // the write did not ask
    expect(s.events(run.id).filter((e) => e.data.decision).map((e) => e.data.message)).toEqual(["Plan approved · continuing in Auto mode", "Auto-approved: Write plan.txt"]);
    expect(s.audit("approval.decide")[0]).toMatchObject({ kind: "plan", decision: "approve", mode: "auto" });
  });

  it("switching a live Manual run to Auto from another device applies to what it asks for next", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = await boot(async (call) => {
      const cfg = call.arg("--mcp-config")!;
      await askApprovalTool(cfg, { tool_name: "Write", input: { file_path: join(s.box, "one.txt"), content: "1" } }); // asks
      await gate;
      await askApprovalTool(cfg, { tool_name: "Write", input: { file_path: join(s.box, "two.txt"), content: "2" } }); // auto by then
      return listFiles[0];
    });
    await s.phone.client.mutate("message.send", { threadId: s.threadId, messageId: newId("msg"), text: "Create two files", source: "text" });
    const first = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "first approval")) as Approval;
    await s.desktop.client.mutate("mode.set", { scope: "thread", id: s.threadId, mode: "auto" });
    await waitFor(() => s.runs()[0].mode === "auto", "live run in Auto");
    await waitFor(() => s.events(s.runs()[0].id).some((e) => e.data.modeChanged), "connector applied the change");
    await s.phone.client.mutate("approval.decide", { approvalId: first.id, decision: "approve" });
    release();
    await waitFor(() => s.runs()[0].status === "succeeded", "run done");
    expect((s.phone.list("approvals") as Approval[]).map((a) => a.title)).toEqual(["Write one.txt"]);
    expect(s.audit("approval.auto").map((a) => a.title)).toEqual(["Write two.txt"]);
  });
});
