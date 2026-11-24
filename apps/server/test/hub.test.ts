import { describe, expect, it } from "vitest";
import { ENTITY_NAMES, newId, type EntityName } from "@homebase/protocol";
import { assertValid, connectConnector, connectDevice, makeHub, mid, pairDevice, peer } from "./helpers";
import { simulate } from "../src/ingest/simulator";

const dev = (p: { id: string }) => ({ id: p.id, canApprove: true });

describe("pairing and tokens", () => {
  it("pairs once per code, stores only a hash, and authenticates", () => {
    const { directory, store } = makeHub();
    const { code } = directory.createPairingCode("device", null);
    const r = directory.pair({ code: code.toLowerCase().replace("-", " "), kind: "device", name: "Pixel", platform: "android" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token.startsWith("hb_dev_")).toBe(true);
    expect(directory.authenticate(r.token)?.id).toBe(r.deviceId);
    expect(directory.authenticate(r.token + "x")).toBeNull();
    const row = store.get<{ token_hash: string }>("SELECT token_hash FROM devices WHERE id = ?", r.deviceId)!;
    expect(row.token_hash).not.toContain(r.token.slice(7));
    const again = directory.pair({ code, kind: "device", name: "Pixel", platform: "android" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("code_used");
  });

  it("rejects expired, unknown and wrong-kind codes", () => {
    const { directory, clock } = makeHub();
    expect(directory.pair({ code: "ZZZZ-ZZZZ", kind: "device", name: "x", platform: "t" })).toMatchObject({ ok: false, code: "invalid_code" });
    const c = directory.createPairingCode("connector", null);
    expect(directory.pair({ code: c.code, kind: "device", name: "x", platform: "t" })).toMatchObject({ ok: false, code: "wrong_kind" });
    const d = directory.createPairingCode("device", null);
    clock.now += 11 * 60_000;
    expect(directory.pair({ code: d.code, kind: "device", name: "x", platform: "t" })).toMatchObject({ ok: false, code: "code_expired" });
  });

  it("revocation closes the socket and rejects the token", () => {
    const { hub, directory } = makeHub();
    const a = pairDevice(directory);
    const b = pairDevice(directory);
    const pa = peer(a.deviceId);
    const pb = peer(b.deviceId);
    hub.attachDevice(pa, {});
    hub.attachDevice(pb, {});
    const ack = hub.mutate(dev(pa), mid(), "device.update", { deviceId: b.deviceId, revoked: true });
    expect(ack.ok).toBe(true);
    expect(pb.closed?.code).toBe(4003);
    expect(directory.authenticate(b.token)).toBeNull();
    expect(directory.authenticate(a.token)).not.toBeNull();
  });
});

describe("mutations", () => {
  it("applies a mutation, logs a change with a monotonic seq, and fans out to every device", () => {
    const { hub, directory } = makeHub();
    const a = connectDevice(hub, directory);
    const b = connectDevice(hub, directory);
    a.frames.length = b.frames.length = 0;
    const threadId = newId("thr");
    const before = hub.currentSeq();
    const ack = hub.mutate(dev(a), mid(), "thread.create", { threadId, title: "Hello" });
    expect(ack).toMatchObject({ t: "ack", ok: true, seq: before + 1 });
    for (const p of [a, b]) {
      const changes = p.of("changes").flatMap((f) => f.changes);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ seq: before + 1, entity: "threads", id: threadId, op: "upsert" });
      assertValid("threads", changes[0].data);
    }
  });

  it("is idempotent: a retried mutation ID is applied exactly once", () => {
    const { hub, directory, store } = makeHub();
    const a = connectDevice(hub, directory);
    const threadId = newId("thr");
    hub.mutate(dev(a), mid(), "thread.create", { threadId, title: "T" });
    const id = mid();
    const args = { threadId, messageId: newId("msg"), text: "only once", source: "text" as const };
    const first = hub.mutate(dev(a), id, "message.send", args);
    const seqAfterFirst = hub.currentSeq();
    const second = hub.mutate(dev(a), id, "message.send", args);
    const third = hub.mutate(dev(a), id, "message.send", { ...args, text: "different payload, same id" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(hub.currentSeq()).toBe(seqAfterFirst);
    expect(store.all("SELECT id FROM messages WHERE thread_id = ?", threadId)).toHaveLength(1);
  });

  it("rejects unknown names and invalid args without writing anything", () => {
    const { hub, directory } = makeHub();
    const a = connectDevice(hub, directory);
    const seq = hub.currentSeq();
    expect(hub.mutate(dev(a), mid(), "drop.everything", {})).toMatchObject({ ok: false, error: { code: "unknown_mutation" } });
    expect(hub.mutate(dev(a), mid(), "note.upsert", { noteId: 5 })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(hub.mutate(dev(a), mid(), "thread.update", { threadId: "thr_missing", title: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(hub.currentSeq()).toBe(seq);
  });

  it("rolls back every write when a handler fails part-way", () => {
    const { hub, directory, store } = makeHub();
    const a = connectDevice(hub, directory);
    const c = connectConnector(hub, directory);
    void c;
    const agent = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!;
    const runId = newId("run");
    expect(hub.mutate(dev(a), mid(), "run.start", { runId, agentId: agent.id, prompt: "one" }).ok).toBe(true);
    const seq = hub.currentSeq();
    const audits = store.all("SELECT id FROM audit_log").length;
    // Same runId again: startRun throws after nothing else was written; state must be untouched.
    expect(hub.mutate(dev(a), mid(), "run.start", { runId, agentId: agent.id, prompt: "two" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(hub.currentSeq()).toBe(seq);
    expect(store.all("SELECT id FROM audit_log")).toHaveLength(audits);
  });

  it("keeps the overwritten body when a note is written with a stale baseRev", () => {
    const { hub, directory, store } = makeHub();
    const a = connectDevice(hub, directory);
    const noteId = newId("note");
    hub.mutate(dev(a), mid(), "note.upsert", { noteId, title: "N", body: "v1" });
    hub.mutate(dev(a), mid(), "note.upsert", { noteId, title: "N", body: "v2 from phone", baseRev: 1 });
    const stale = hub.mutate(dev(a), mid(), "note.upsert", { noteId, title: "N", body: "v2 from desktop", baseRev: 1 });
    expect(stale.ok).toBe(true); // last writer wins
    const note = store.get<{ body: string; rev: number }>("SELECT body, rev FROM notes WHERE id = ?", noteId)!;
    expect(note).toMatchObject({ body: "v2 from desktop", rev: 3 });
    const revs = store.all<{ rev: number; body: string }>("SELECT rev, body FROM note_revisions WHERE note_id = ?", noteId);
    expect(revs).toEqual([{ rev: 2, body: "v2 from phone" }]); // nothing lost
  });
});

describe("change-log catch-up and snapshot fallback", () => {
  it("sends a full snapshot to a new client, and every row satisfies the shared schemas", () => {
    const { hub, directory } = makeHub({ demo: true });
    const a = connectDevice(hub, directory);
    expect(a.of("welcome")[0]).toMatchObject({ v: 1, mode: "snapshot", deviceId: a.id });
    const snap = a.of("snapshot")[0];
    expect(snap.seq).toBe(hub.currentSeq());
    expect(Object.keys(snap.entities).sort()).toEqual([...ENTITY_NAMES].sort());
    for (const e of ENTITY_NAMES) for (const row of snap.entities[e]) assertValid(e as EntityName, row);
    expect(snap.entities.inbox_items.length).toBeGreaterThan(5);
    expect(snap.entities.devices.every((d: any) => d.tokenHash === undefined && d.token_hash === undefined)).toBe(true);
  });

  it("sends only the missed changes to a client that reconnects with lastSeq", () => {
    const { hub, directory } = makeHub();
    const a = connectDevice(hub, directory);
    const lastSeq = a.of("snapshot")[0].seq;
    hub.detach(a);
    const other = connectDevice(hub, directory);
    const noteId = newId("note");
    hub.mutate(dev(other), mid(), "note.upsert", { noteId, title: "While you were away", body: "1" });
    hub.mutate(dev(other), mid(), "note.upsert", { noteId, title: "While you were away", body: "2" });
    hub.mutate(dev(other), mid(), "note.delete", { noteId });

    const back = peer(a.id);
    hub.attachDevice(back, { lastSeq, schema: 1 });
    expect(back.of("welcome")[0].mode).toBe("delta");
    expect(back.of("snapshot")).toHaveLength(0);
    const changes = back.of("changes").flatMap((f) => f.changes);
    const seqs = changes.map((c: any) => c.seq);
    expect(seqs[0]).toBe(lastSeq + 1);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs[seqs.length - 1]).toBe(hub.currentSeq());
    const noteOps = changes.filter((c: any) => c.entity === "notes").map((c: any) => c.op);
    expect(noteOps).toEqual(["upsert", "upsert", "delete"]);
    expect(changes.find((c: any) => c.op === "delete").data).toBeUndefined();
  });

  it("falls back to a snapshot when the client is older than log retention", () => {
    const { hub, directory } = makeHub({ retainChanges: 5 });
    const a = connectDevice(hub, directory);
    const lastSeq = a.of("snapshot")[0].seq;
    hub.detach(a);
    const other = connectDevice(hub, directory);
    for (let i = 0; i < 12; i++) hub.mutate(dev(other), mid(), "note.upsert", { noteId: newId("note"), title: `n${i}`, body: "" });
    hub.pruneChanges();
    const back = peer(a.id);
    hub.attachDevice(back, { lastSeq, schema: 1 });
    expect(back.of("welcome")[0].mode).toBe("snapshot");
    expect(back.of("snapshot")[0].entities.notes).toHaveLength(12);
  });

  it("falls back to a snapshot for lastSeq 0, a future seq, or a different schema version", () => {
    const { hub, directory } = makeHub();
    const a = connectDevice(hub, directory);
    const seq = hub.currentSeq();
    for (const hello of [{ lastSeq: 0, schema: 1 }, { lastSeq: seq + 500, schema: 1 }, { lastSeq: seq, schema: 2 }, {}]) {
      const p = peer(a.id);
      hub.attachDevice(p, hello);
      expect(p.of("welcome")[0].mode, JSON.stringify(hello)).toBe("snapshot");
      expect(p.of("snapshot")).toHaveLength(1);
    }
    const p = peer(a.id);
    hub.attachDevice(p, { lastSeq: hub.currentSeq(), schema: 1 });
    expect(p.of("welcome")[0].mode).toBe("delta");
  });
});

describe("approval state machine", () => {
  function setup(risk: "low" | "medium" | "high", kind: "tool" | "question" = "tool") {
    const ctx = makeHub();
    const { hub, directory, store } = ctx;
    const device = connectDevice(hub, directory);
    const con = connectConnector(hub, directory);
    const agent = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!;
    const runId = newId("run");
    hub.mutate(dev(device), mid(), "run.start", { runId, agentId: agent.id, prompt: "deploy the staging fix" });
    hub.onFrame(con, { t: "run.status", runId, status: "running", at: hub.now() });
    const approvalId = newId("apr");
    hub.onFrame(con, {
      t: "approval.request",
      approval: {
        id: approvalId, runId, kind, tool: kind === "tool" ? "Bash" : null, title: "Deploy to production", risk, requestedAt: hub.now(),
        summary: "wrangler deploy", input: { command: "wrangler deploy --env production" },
        questions: kind === "question" ? [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] : null,
      },
    });
    const status = () => store.get<{ status: string }>("SELECT status FROM approvals WHERE id = ?", approvalId)!.status;
    const runStatus = () => store.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", runId)!.status;
    const decisions = () => con.of("cmd").filter((c) => c.name === "approval.decision");
    return { ...ctx, device, con, runId, approvalId, status, runStatus, decisions };
  }

  it("request → pending, run waits, devices are notified", () => {
    const s = setup("medium");
    expect(s.status()).toBe("pending");
    expect(s.runStatus()).toBe("waiting_approval");
    const n = s.device.of("notify").map((f) => f.notification).find((x) => x.channel === "approvals");
    expect(n).toMatchObject({ priority: "P1", link: `/approvals/${s.approvalId}`, actions: ["approve", "deny"], collapseKey: s.approvalId });
  });

  it("approve → approved, forwarded to the connector, audited", () => {
    const s = setup("medium");
    const ack = s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "approve" });
    expect(ack.ok).toBe(true);
    expect(s.status()).toBe("approved");
    expect(s.decisions()).toHaveLength(1);
    expect(s.decisions()[0]).toMatchObject({ approvalId: s.approvalId, runId: s.runId, decision: "approve", decidedBy: s.device.id });
    const audit = s.store.all<{ action: string; actor_id: string; detail: string }>("SELECT * FROM audit_log WHERE subject_id = ? ORDER BY at, id", s.approvalId);
    expect(audit.map((a) => a.action)).toEqual(["approval.request", "approval.decide"]);
    expect(audit[1].actor_id).toBe(s.device.id);
    expect(JSON.parse(audit[1].detail)).toMatchObject({ decision: "approve", risk: "medium", runId: s.runId });
  });

  it("deny carries the message; a decided approval cannot be decided again", () => {
    const s = setup("medium");
    expect(s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "deny", message: "not today" }).ok).toBe(true);
    expect(s.status()).toBe("denied");
    expect(s.decisions()[0]).toMatchObject({ decision: "deny", message: "not today" });
    const again = s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "approve" });
    expect(again).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(s.status()).toBe("denied");
    expect(s.decisions()).toHaveLength(1);
  });

  it("high risk needs a fresh in-app confirmation (biometricAt within 60 s)", () => {
    const s = setup("high");
    const n = s.device.of("notify").map((f) => f.notification).find((x) => x.channel === "approvals");
    expect(n).toMatchObject({ priority: "P0", actions: ["open"] }); // never approvable from a notification action
    const decide = (extra: object) => s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "approve", ...extra });
    expect(decide({})).toMatchObject({ ok: false, error: { code: "biometric_required" } });
    expect(decide({ biometricAt: s.clock.now - 61_000 })).toMatchObject({ ok: false, error: { code: "biometric_required" } });
    expect(s.status()).toBe("pending");
    expect(s.decisions()).toHaveLength(0);
    expect(decide({ biometricAt: s.clock.now - 5_000, remember: true })).toMatchObject({ ok: true });
    expect(s.status()).toBe("approved");
    expect(s.decisions()[0].remember).toBe(false); // "remember" is never honoured for high risk
  });

  it("a high-risk approval can be denied without the confirmation step", () => {
    const s = setup("high");
    expect(s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "deny" }).ok).toBe(true);
    expect(s.status()).toBe("denied");
  });

  it("devices without can_approve are refused", () => {
    const s = setup("low");
    const ack = s.hub.mutate({ id: s.device.id, canApprove: false }, mid(), "approval.decide", { approvalId: s.approvalId, decision: "approve" });
    expect(ack).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(s.status()).toBe("pending");
  });

  it("questions need an answer to approve", () => {
    const s = setup("low", "question");
    expect(s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "approve" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "approve", answers: { "Which?": "B" } }).ok).toBe(true);
    expect(s.decisions()[0].answers).toEqual({ "Which?": "B" });
  });

  it("pending → cancelled when the run ends; pending → expired when the connector loses the run", () => {
    const a = setup("medium");
    a.hub.onFrame(a.con, { t: "run.status", runId: a.runId, status: "cancelled", at: a.hub.now() });
    expect(a.status()).toBe("cancelled");
    expect(a.hub.mutate(dev(a.device), mid(), "approval.decide", { approvalId: a.approvalId, decision: "approve" })).toMatchObject({ ok: false, error: { code: "conflict" } });

    const b = setup("medium");
    b.hub.detach(b.con);
    expect(b.runStatus()).toBe("offline");
    expect(b.status()).toBe("pending"); // still open while the connector might come back with the run
    const con2 = peer(b.con.id, "connector", false);
    b.hub.attachConnector(con2);
    expect(con2.of("welcome")[0].resume).toEqual([{ runId: b.runId, lastIdx: -1 }]);
    b.hub.onFrame(con2, { t: "register", host: { name: "c", os: "t" }, agents: [{ key: "dev", name: "Dev agent", kind: "mock", description: "", capabilities: [], workspaces: [] }], activeRunIds: [] });
    expect(b.status()).toBe("expired");
    expect(b.runStatus()).toBe("offline");
  });

  it("a replayed approval.request does not reopen or duplicate", () => {
    const s = setup("medium");
    s.hub.mutate(dev(s.device), mid(), "approval.decide", { approvalId: s.approvalId, decision: "deny" });
    s.hub.onFrame(s.con, { t: "approval.request", approval: { id: s.approvalId, runId: s.runId, kind: "tool", title: "Deploy to production", risk: "medium", requestedAt: s.hub.now() } });
    expect(s.status()).toBe("denied");
    expect(s.store.all("SELECT id FROM approvals")).toHaveLength(1);
  });
});

describe("runs and connector routing", () => {
  it("message.send on an agent thread starts a run, then forwards run.input while it is live", () => {
    const { hub, directory, store } = makeHub();
    const d = connectDevice(hub, directory);
    const con = connectConnector(hub, directory);
    const agent = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!;
    const threadId = newId("thr");
    hub.mutate(dev(d), mid(), "thread.create", { threadId, title: "T", agentId: agent.id });
    hub.mutate(dev(d), mid(), "message.send", { threadId, messageId: newId("msg"), text: "first", source: "text" });
    const start = con.of("cmd").find((c) => c.name === "run.start");
    expect(start.run).toMatchObject({ agentKey: "dev", threadId, prompt: "first" });
    hub.onFrame(con, { t: "run.status", runId: start.run.id, status: "running", at: hub.now() });
    hub.mutate(dev(d), mid(), "message.send", { threadId, messageId: newId("msg"), text: "second", source: "voice" });
    expect(con.of("cmd").filter((c) => c.name === "run.start")).toHaveLength(1);
    expect(con.of("cmd").find((c) => c.name === "run.input")).toMatchObject({ runId: start.run.id, text: "second" });
  });

  it("re-sends unacknowledged commands when the connector reconnects", () => {
    const { hub, directory, store } = makeHub();
    const d = connectDevice(hub, directory);
    const con = connectConnector(hub, directory);
    const agent = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!;
    hub.detach(con);
    const runId = newId("run");
    expect(hub.mutate(dev(d), mid(), "run.start", { runId, agentId: agent.id, prompt: "queued while offline" }).ok).toBe(true);
    const con2 = peer(con.id, "connector", false);
    hub.attachConnector(con2);
    hub.onFrame(con2, { t: "register", host: { name: "c", os: "t" }, agents: [{ key: "dev", name: "Dev agent", kind: "mock", description: "", capabilities: [], workspaces: [] }] });
    const cmds = con2.of("cmd");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ name: "run.start", run: { id: runId } });
    hub.onFrame(con2, { t: "cmd.ack", id: cmds[0].id, ok: true });
    hub.flushCommands(con2.id);
    expect(con2.of("cmd")).toHaveLength(1); // acknowledged: not sent again
  });

  it("persists run events once, mirrors assistant text into the thread, and streams deltas only to subscribers", () => {
    const { hub, directory, store } = makeHub();
    const d = connectDevice(hub, directory);
    const watcher = connectDevice(hub, directory);
    const con = connectConnector(hub, directory);
    const agent = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!;
    const threadId = newId("thr");
    hub.mutate(dev(d), mid(), "thread.create", { threadId, title: "T", agentId: agent.id });
    hub.mutate(dev(d), mid(), "message.send", { threadId, messageId: newId("msg"), text: "go", source: "text" });
    const runId = con.of("cmd")[0].run.id;
    hub.onFrame(watcher, { t: "sub", topic: `run:${runId}` });
    const seq = hub.currentSeq();
    hub.onFrame(con, { t: "run.event", runId, idx: 0, at: hub.now(), kind: "text_delta", persist: false, data: { text: "Work" } });
    expect(hub.currentSeq()).toBe(seq); // deltas never touch the change log
    expect(store.all("SELECT idx FROM run_events WHERE run_id = ?", runId)).toHaveLength(0);
    expect(watcher.of("ephemeral")).toHaveLength(1);
    expect(d.of("ephemeral")).toHaveLength(0);
    const text = { t: "run.event" as const, runId, idx: 1, at: hub.now(), kind: "text" as const, persist: true, data: { text: "Working on: go" } };
    hub.onFrame(con, text);
    hub.onFrame(con, text); // replay after reconnect
    expect(store.all("SELECT idx FROM run_events WHERE run_id = ?", runId)).toHaveLength(1);
    const msgs = store.all<{ role: string; text: string }>("SELECT role, text FROM messages WHERE thread_id = ? ORDER BY created_at, id", threadId);
    expect(msgs).toEqual([{ role: "user", text: "go" }, { role: "assistant", text: "Working on: go" }]);
    expect(watcher.of("ephemeral")).toHaveLength(2);
  });

  it("ignores run frames from a connector that does not own the run", () => {
    const { hub, directory, store } = makeHub();
    const d = connectDevice(hub, directory);
    const con = connectConnector(hub, directory);
    const intruder = connectConnector(hub, directory, [{ key: "other", name: "Other", kind: "mock" }]);
    const agent = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!;
    const runId = newId("run");
    hub.mutate(dev(d), mid(), "run.start", { runId, agentId: agent.id, prompt: "x" });
    hub.onFrame(intruder, { t: "run.status", runId, status: "succeeded", summary: "forged", at: hub.now() });
    hub.onFrame(intruder, { t: "approval.request", approval: { id: newId("apr"), runId, kind: "tool", title: "forged", risk: "low", requestedAt: hub.now() } });
    expect(store.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", runId)!.status).toBe("queued");
    expect(store.all("SELECT id FROM approvals")).toHaveLength(0);
    void con;
  });
});

describe("inbox pipeline", () => {
  it("triages a monitor failure to P0, notifies, and starts the SLA clock", () => {
    const { hub, directory } = makeHub({ demo: true });
    const d = connectDevice(hub, directory);
    d.frames.length = 0;
    const item = hub.ingest(simulate("monitor", hub.now()));
    expect(item).toMatchObject({ source: "monitor", priority: "P0", status: "new", slaState: "running" });
    expect(item.slaDueAt! - item.receivedAt).toBe(60 * 60_000); // P0 policy: one hour, around the clock
    const n = d.of("notify")[0].notification;
    expect(n).toMatchObject({ priority: "P0", channel: "p0_urgent", link: `/inbox/${item.id}` });
    assertValid("inbox_items", d.of("changes")[0].changes[0].data);
  });

  it("dedupes on (source, externalId)", () => {
    const { hub, store } = makeHub();
    const draft = { source: "gmail" as const, externalId: "msg-1", title: "Hello", sender: "a@b.example" };
    const a = hub.ingest(draft);
    const b = hub.ingest({ ...draft, title: "Hello (edited)" });
    expect(b.id).toBe(a.id);
    expect(store.all("SELECT id FROM inbox_items")).toHaveLength(1);
    expect(b.title).toBe("Hello (edited)");
  });

  it("marking responded stops the clock; the tick warns then breaches open items", () => {
    const { hub, directory, clock, store } = makeHub({ demo: true });
    const d = connectDevice(hub, directory);
    const responded = hub.ingest(simulate("monitor", hub.now(), "a"));
    const ignored = hub.ingest(simulate("monitor", hub.now(), "b"));
    expect(hub.mutate(dev(d), mid(), "inbox.update", { itemId: responded.id, status: "responded" }).ok).toBe(true);
    const state = (id: string) => store.get<{ sla_state: string; responded_at: number | null }>("SELECT sla_state, responded_at FROM inbox_items WHERE id = ?", id)!;
    expect(state(responded.id)).toMatchObject({ sla_state: "met", responded_at: clock.now });
    d.frames.length = 0;
    clock.now += 31 * 60_000;
    hub.tick();
    expect(state(ignored.id).sla_state).toBe("warning");
    clock.now += 30 * 60_000;
    hub.tick();
    expect(state(ignored.id).sla_state).toBe("breached");
    expect(state(responded.id).sla_state).toBe("met"); // the stopped clock never moves again
    const titles = d.of("notify").map((f) => f.notification).filter((n: any) => n.collapseKey === ignored.id).map((n: any) => n.title);
    expect(titles).toEqual([`SLA at risk: ${ignored.title}`, `SLA breached: ${ignored.title}`]);
  });

  it("snoozing does not pause the SLA clock and the item wakes up on time", () => {
    const { hub, directory, clock, store } = makeHub({ demo: true });
    const d = connectDevice(hub, directory);
    const item = hub.ingest(simulate("monitor", hub.now()));
    hub.mutate(dev(d), mid(), "inbox.update", { itemId: item.id, status: "snoozed", snoozeUntil: clock.now + 45 * 60_000 });
    clock.now += 46 * 60_000;
    hub.tick();
    const row = store.get<{ status: string; sla_state: string; sla_due_at: number }>("SELECT status, sla_state, sla_due_at FROM inbox_items WHERE id = ?", item.id)!;
    expect(row).toMatchObject({ status: "triaged", sla_state: "warning", sla_due_at: item.slaDueAt });
  });

  it("focus window holds back everything except P0 and high-risk approvals", () => {
    const { hub, directory } = makeHub({ demo: true });
    const d = connectDevice(hub, directory);
    hub.mutate(dev(d), mid(), "settings.update", { key: "notifications.focusWindow", value: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" } });
    d.frames.length = 0;
    hub.ingest(simulate("gmail", hub.now())); // quote request → P1
    expect(d.of("notify")).toHaveLength(0);
    hub.ingest(simulate("monitor", hub.now())); // P0
    expect(d.of("notify")).toHaveLength(1);
  });
});
