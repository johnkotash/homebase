import { describe, expect, it } from "vitest";
import { InboundFrame, newId } from "@homebase/protocol";
import { connectConnector, connectDevice, makeHub, mid } from "./helpers";

const dev = (p: { id: string }) => ({ id: p.id, canApprove: true });

function setup() {
  const ctx = makeHub();
  const { hub, directory, store } = ctx;
  const device = connectDevice(hub, directory);
  const con = connectConnector(hub, directory);
  const agent = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!;
  const threadId = newId("thr");
  hub.mutate(dev(device), mid(), "thread.create", { threadId, title: "Fix agent", agentId: agent.id });
  const job = (over: Record<string, unknown> = {}) => ({
    t: "job.done" as const,
    job: { id: "fix1-20261125-095000", name: "fix1", threadId, agentKey: "dev", command: "bash run-fix.sh", cwd: "/work", exitCode: 0, startedAt: hub.now() - 3_600_000, endedAt: hub.now(), log: "/jobs/fix1.log", tail: "All 12 fixes done", ...over },
  });
  const runs = () => store.all<{ id: string; prompt: string; thread_id: string }>("SELECT id, prompt, thread_id FROM runs WHERE thread_id = ?", threadId);
  const notes = () => store.all<{ id: string; role: string; text: string }>("SELECT id, role, text FROM messages WHERE thread_id = ? AND role = 'system'", threadId);
  return { ...ctx, device, con, agent, threadId, job, runs, notes };
}

describe("background jobs that report back (job.done)", () => {
  it("the frame is bounded and validated", () => {
    const s = setup();
    expect(InboundFrame.safeParse(s.job()).success).toBe(true);
    expect(InboundFrame.safeParse(s.job({ id: "bad id with spaces" })).success).toBe(false);
    expect(InboundFrame.safeParse(s.job({ tail: "x".repeat(6001) })).success).toBe(false);
  });

  it("wakes the session that started the job: a system note and a report run with the outcome", () => {
    const s = setup();
    s.hub.onFrame(s.con, s.job());
    const runs = s.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toContain('background job "fix1"');
    expect(runs[0].prompt).toContain("finished successfully");
    expect(runs[0].prompt).toContain("All 12 fixes done");
    expect(runs[0].prompt).toContain("report to the owner");
    expect(s.notes()[0].text).toMatch(/Background job "fix1" finished/);
    // The connector was told to start the run.
    expect(s.con.of("cmd").some((c) => c.name === "run.start" && c.run.id === runs[0].id)).toBe(true);
  });

  it("is reported once, however often the connector sends it", () => {
    const s = setup();
    s.hub.onFrame(s.con, s.job());
    s.hub.onFrame(s.con, s.job());
    expect(s.runs()).toHaveLength(1);
    expect(s.notes()).toHaveLength(1);
  });

  it("a failed job says so", () => {
    const s = setup();
    s.hub.onFrame(s.con, s.job({ exitCode: 3 }));
    expect(s.runs()[0].prompt).toContain("failed (exit code 3)");
    expect(s.notes()[0].text).toContain("failed (exit 3)");
  });

  it("goes into a live run as input instead of starting a second one", () => {
    const s = setup();
    s.hub.mutate(dev(s.device), mid(), "message.send", { messageId: newId("msg"), threadId: s.threadId, text: "keep going", source: "text" });
    const live = s.runs()[0];
    s.hub.onFrame(s.con, { t: "run.status", runId: live.id, status: "running", at: s.hub.now() });
    s.hub.onFrame(s.con, s.job());
    expect(s.runs()).toHaveLength(1);
    expect(s.con.of("cmd").some((c) => c.name === "run.input" && c.runId === live.id && String(c.text).includes("fix1"))).toBe(true);
  });

  it("a job with no session, or a session this connector does not serve, becomes an inbox item", () => {
    const s = setup();
    s.hub.onFrame(s.con, s.job({ threadId: null, id: "nightly-1" }));
    s.hub.onFrame(s.con, s.job({ threadId: "thr_someone_else", id: "other-1" }));
    const items = s.store.all<{ title: string; external_id: string }>("SELECT title, external_id FROM inbox_items WHERE source = 'agent' ORDER BY external_id");
    expect(items.map((i) => i.external_id)).toEqual(["job:nightly-1", "job:other-1"]);
    expect(s.runs()).toHaveLength(0);
  });
});
