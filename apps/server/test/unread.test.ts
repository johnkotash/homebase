import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENTITY_SCHEMAS, isUnread, newId, unreadCount, type Thread } from "@homebase/protocol";
import { openStore } from "../src/app";
import { NodeSqlStore } from "../src/hub/SqlStore";
import { readEntity } from "../src/hub/tables";
import { WorkspaceHub } from "../src/hub/WorkspaceHub";
import { seed } from "../src/seed";
import { assertValid, connectConnector, connectDevice, makeHub, mid } from "./helpers";

const dev = (p: { id: string }) => ({ id: p.id, canApprove: true });

function setup() {
  const ctx = makeHub();
  const { hub, directory, store, clock } = ctx;
  const device = connectDevice(hub, directory);
  const other = connectDevice(hub, directory);
  const con = connectConnector(hub, directory, [{ key: "claude", name: "Claude agent", kind: "claude" as const }] as any);
  const agentId = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'claude' AND connector_id IS NOT NULL")!.id;
  const run = (name: string, args: unknown, who = device) => hub.mutate(dev(who), mid(), name, args);
  const ok = (name: string, args: unknown, who = device) => {
    const ack = run(name, args, who);
    if (!ack.ok) throw new Error(`${name} failed: ${JSON.stringify((ack as any).error)}`);
    return ack;
  };
  const thread = (id: string) => readEntity<Thread>(store, "threads", id)!;
  const newThread = () => {
    const threadId = newId("thr");
    ok("thread.create", { threadId, title: "New session with Claude agent", agentId });
    return threadId;
  };
  const say = (threadId: string, text: string, who = device) => ok("message.send", { threadId, messageId: newId("msg"), text, source: "text" }, who);
  const lastRun = () => con.of("cmd").filter((c) => c.name === "run.start").at(-1)!.run.id as string;
  let idx = 0;
  const event = (runId: string, kind: string, data: Record<string, unknown>) => hub.onFrame(con, { t: "run.event", runId, idx: idx++, at: clock.now, kind: kind as any, data });
  const text = (runId: string, t: string) => event(runId, "text", { text: t });
  const status = (runId: string, s: string, extra: Record<string, unknown> = {}) => hub.onFrame(con, { t: "run.status", runId, status: s as any, at: clock.now, ...extra });
  const threadChanges = (who = other) => who.of("changes").flatMap((f) => f.changes).filter((c: any) => c.entity === "threads");
  const tick = (ms = 1000) => void (clock.now += ms);
  /** A session where the owner asked something and the agent answered: unread. */
  const answered = () => {
    const t = newThread();
    say(t, "what is left on the release?");
    const runId = lastRun();
    status(runId, "running");
    tick();
    text(runId, "Two items: the changelog and the tag.");
    return { t, runId };
  };
  return { ...ctx, device, other, con, agentId, run, ok, thread, newThread, say, lastRun, event, text, status, threadChanges, tick, answered };
}

describe("unread state on the hub", () => {
  it("a new session, and one where only the owner has spoken, is not unread", () => {
    const s = setup();
    const t = s.newThread();
    expect(s.thread(t)).toMatchObject({ lastAgentAt: null, readAt: null });
    s.say(t, "hello");
    expect(s.thread(t)).toMatchObject({ lastAgentAt: null, readAt: null });
    expect(isUnread(s.thread(t))).toBe(false);
  });

  it("an agent reply makes the session unread, on every device", () => {
    const s = setup();
    const { t } = s.answered();
    const th = s.thread(t);
    expect(th.lastAgentAt).toBe(s.clock.now);
    expect(th.readAt).toBeNull();
    expect(isUnread(th)).toBe(true);
    assertValid("threads", th);
    const seen = s.threadChanges().filter((c: any) => c.id === t).at(-1);
    expect(isUnread(seen.data)).toBe(true);
    // A device that connects later gets it in its snapshot.
    const fresh = connectDevice(s.hub, s.directory);
    const row = fresh.of("snapshot")[0].entities.threads.find((x: Thread) => x.id === t);
    expect(isUnread(row)).toBe(true);
    assertValid("threads", row);
    expect(unreadCount(fresh.of("snapshot")[0].entities.threads)).toBe(1);
  });

  it("thread.read from one device marks it read for all of them", () => {
    const s = setup();
    const { t } = s.answered();
    const at = s.thread(t).lastAgentAt!;
    s.tick(5000);
    s.ok("thread.read", { threadId: t, at });
    expect(s.thread(t)).toMatchObject({ lastAgentAt: at, readAt: at });
    expect(isUnread(s.thread(t))).toBe(false);
    const seen = s.threadChanges(s.other).filter((c: any) => c.id === t).at(-1);
    expect(seen.data).toMatchObject({ readAt: at });
    expect(isUnread(seen.data)).toBe(false);
    assertValid("threads", seen.data);
  });

  it("reading twice, or with an older time, writes nothing", () => {
    const s = setup();
    const { t } = s.answered();
    const at = s.thread(t).lastAgentAt!;
    s.ok("thread.read", { threadId: t });
    const seq = s.hub.currentSeq();
    s.ok("thread.read", { threadId: t });
    s.ok("thread.read", { threadId: t, at: at - 500 });
    s.ok("thread.read", { threadId: t, at });
    expect(s.hub.currentSeq()).toBe(seq);
    expect(s.thread(t).readAt).toBe(at);
  });

  it("a reply that lands after the one the device saw stays unread", () => {
    const s = setup();
    const { t, runId } = s.answered();
    const saw = s.thread(t).lastAgentAt!;
    s.tick();
    s.text(runId, "Changelog is done.");
    // The device's thread.read was sent before it had the second reply.
    s.ok("thread.read", { threadId: t, at: saw });
    expect(s.thread(t)).toMatchObject({ readAt: saw, lastAgentAt: s.clock.now });
    expect(isUnread(s.thread(t))).toBe(true);
    // And a device with a wrong clock cannot mark more than the agent has said.
    s.ok("thread.read", { threadId: t, at: s.clock.now + 86_400_000 });
    expect(s.thread(t).readAt).toBe(s.clock.now);
    expect(isUnread(s.thread(t))).toBe(false);
  });

  it("writing in a session reads it: the owner has it in front of them", () => {
    const s = setup();
    const { t, runId } = s.answered();
    s.status(runId, "succeeded");
    expect(isUnread(s.thread(t))).toBe(true);
    s.tick();
    s.say(t, "ship the tag too", s.other);
    expect(isUnread(s.thread(t))).toBe(false);
    expect(s.thread(t).readAt).toBe(s.thread(t).lastAgentAt);
    // The next reply is unread again.
    s.tick();
    s.text(s.lastRun(), "Tagged v1.4.0.");
    expect(isUnread(s.thread(t))).toBe(true);
  });

  it("a failed run counts as something to see", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "deploy it");
    const runId = s.lastRun();
    s.status(runId, "running");
    s.tick();
    s.status(runId, "failed", { error: "The connector lost its login." });
    expect(s.thread(t)).toMatchObject({ lastRunStatus: "failed", lastAgentAt: s.clock.now });
    expect(isUnread(s.thread(t))).toBe(true);
  });

  it("a dictation receipt does not make the Notes session unread; a mail card does", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "note: call the plumber");
    const runId = s.lastRun();
    s.status(runId, "running");
    s.tick();
    s.event(runId, "system", {
      message: "Filed", vaultCard: { type: "vault_capture", date: "20261122", files: [{ path: "Daily Notes/2026-11-22.md", status: "appended", bullets: ["- call the plumber"] }], transcriptPath: null, flags: [] },
    });
    expect(s.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND card IS NOT NULL", t)!.n).toBe(1);
    expect(s.thread(t).lastAgentAt).toBeNull();
    expect(isUnread(s.thread(t))).toBe(false);
    s.tick();
    s.event(runId, "system", {
      message: "Draft saved", gmailCard: { type: "gmail_draft", draftId: "d1", threadId: null, to: ["a@example.com"], cc: [], bcc: [], subject: "Hi", body: "Hello" },
    });
    expect(s.thread(t).lastAgentAt).toBe(s.clock.now);
    expect(isUnread(s.thread(t))).toBe(true);
  });

  it("thread.read for a session that is gone, or that the agent never spoke in, is accepted and does nothing", () => {
    const s = setup();
    const seq = s.hub.currentSeq();
    expect(s.run("thread.read", { threadId: "thr_nope" })).toMatchObject({ ok: true });
    const t = s.newThread();
    const after = s.hub.currentSeq();
    expect(s.run("thread.read", { threadId: t, at: 123 })).toMatchObject({ ok: true });
    expect(s.hub.currentSeq()).toBe(after);
    expect(after).toBeGreaterThan(seq);
    expect(s.run("thread.read", {})).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("archived sessions never count toward the badge", () => {
    const s = setup();
    const a = s.answered().t;
    const b = s.answered().t;
    const all = () => s.hub.snapshot().entities.threads as Thread[];
    expect(unreadCount(all())).toBe(2);
    s.ok("thread.update", { threadId: a, archived: true });
    expect(unreadCount(all())).toBe(1);
    s.ok("thread.read", { threadId: b });
    expect(unreadCount(all())).toBe(0);
  });
});

describe("upgrading a database from before unread state", () => {
  const dirs: string[] = [];
  const stores: Array<{ close(): void }> = [];
  const open = (path: string) => {
    const store = openStore(path);
    stores.push(store);
    return store;
  };
  afterEach(() => {
    for (const st of stores.splice(0)) {
      try {
        st.close();
      } catch {}
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The threads table as the hub created it on 2026-11-22, before last_agent_at and read_at. */
  const OLD_THREADS = `CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT, last_message_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, mode TEXT,
    project_id TEXT, note TEXT, summary TEXT, recap TEXT, recap_at INTEGER, recap_run_id TEXT, last_run_status TEXT
  );`;

  function oldDatabase() {
    const dir = mkdtempSync(join(tmpdir(), "hb-unread-"));
    dirs.push(dir);
    const path = join(dir, "homebase.db");
    const old = new NodeSqlStore(path);
    old.exec(OLD_THREADS);
    const ins = "INSERT INTO threads (id, title, agent_id, last_message_at, created_at, updated_at, note, summary, last_run_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    old.run(ins, "thr_a", "Fix the sync cursor", "agt_c", 2000, 1000, 2000, "left here", "Done. The cursor key now includes the entity list.", "succeeded");
    old.run(ins, "thr_b", "Release notes", "agt_c", 3000, 1000, 3000, null, "Run failed: connector offline", "failed");
    old.run(ins, "thr_c", "Scratch", null, null, 1000, 1000, null, null, null);
    old.close();
    return path;
  }

  it("adds the two columns, keeps every row and field, and can be opened again", () => {
    const path = oldDatabase();
    const store = open(path);
    const cols = store.all<{ name: string }>("PRAGMA table_info(threads)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["last_agent_at", "read_at", "note", "summary", "last_run_status"]));
    const threads = store.all<{ id: string }>("SELECT id FROM threads ORDER BY id").map((r) => readEntity<Thread>(store, "threads", r.id)!);
    expect(threads.map((t) => t.id)).toEqual(["thr_a", "thr_b", "thr_c"]);
    expect(threads[0]).toMatchObject({ title: "Fix the sync cursor", note: "left here", summary: "Done. The cursor key now includes the entity list.", lastRunStatus: "succeeded", lastAgentAt: null, readAt: null });
    for (const t of threads) expect(ENTITY_SCHEMAS.threads.safeParse(t).success).toBe(true);
    store.close();
    const again = open(path);
    expect(again.all("PRAGMA table_info(threads)")).toHaveLength(cols.length);
    expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads")!.n).toBe(3);
  });

  it("every existing session starts out read: the upgrade does not flood the owner with unread badges", () => {
    const path = oldDatabase();
    const store = open(path);
    const hub = new WorkspaceHub(store, { quiet: true, now: () => 10_000 });
    seed(hub, { demo: false });
    store.run("INSERT INTO messages (id, thread_id, role, text, source, run_id, author_device_id, created_at) VALUES ('msg_1', 'thr_a', 'assistant', 'Done.', 'agent', NULL, NULL, 2000)");
    const before = store.all("SELECT * FROM threads ORDER BY id");
    hub.start(3_600_000);
    hub.stop();
    const threads = hub.snapshot().entities.threads as Thread[];
    expect(threads).toHaveLength(3);
    expect(unreadCount(threads)).toBe(0);
    for (const t of threads) expect(isUnread(t)).toBe(false);
    // Nothing was rewritten to get there: no backfill, no change-log noise for old rows.
    expect(store.all("SELECT * FROM threads ORDER BY id")).toEqual(before);
    expect(hub.changesAfter(0).filter((c) => c.entity === "threads")).toHaveLength(0);
  });

  it("an old session becomes unread the next time its agent speaks, and reading it works", () => {
    const path = oldDatabase();
    const store = open(path);
    let now = 10_000;
    const hub = new WorkspaceHub(store, { quiet: true, now: () => now });
    seed(hub, { demo: false });
    hub.commit(null, null, (tx) => {
      tx.upsert("messages", { id: "msg_new", threadId: "thr_a", role: "assistant", text: "One more thing.", source: "agent", runId: null, authorDeviceId: null, createdAt: now });
    });
    const t = () => readEntity<Thread>(store, "threads", "thr_a")!;
    expect(t()).toMatchObject({ lastAgentAt: 10_000, readAt: null, note: "left here", lastRunStatus: "succeeded" });
    expect(isUnread(t())).toBe(true);
    now = 20_000;
    expect(hub.mutate({ id: "dev_x", canApprove: true }, mid(), "thread.read", { threadId: "thr_a", at: 10_000 })).toMatchObject({ ok: true });
    expect(t()).toMatchObject({ lastAgentAt: 10_000, readAt: 10_000 });
    expect(unreadCount(hub.snapshot().entities.threads as Thread[])).toBe(0);
  });
});
