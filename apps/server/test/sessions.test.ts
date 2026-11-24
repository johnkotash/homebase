import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENTITY_SCHEMAS, RECAP_PROMPT, RECAP_REQUEST, newId, type Project, type Thread } from "@homebase/protocol";
import { openStore } from "../src/app";
import { Directory } from "../src/directory";
import { NodeSqlStore } from "../src/hub/SqlStore";
import { backfillSessions } from "../src/hub/sessions";
import { readEntity } from "../src/hub/tables";
import { WorkspaceHub } from "../src/hub/WorkspaceHub";
import { seed } from "../src/seed";
import { assertValid, connectConnector, connectDevice, makeHub, mid } from "./helpers";

const dev = (p: { id: string }) => ({ id: p.id, canApprove: true });
const CLAUDE = {
  key: "claude", name: "Claude agent", kind: "claude" as const, modes: ["manual", "auto", "plan"] as Array<"manual" | "auto" | "plan">,
  workspaces: [{ label: "sandbox", cwd: "/srv/sandbox" }, { label: "notetaker", cwd: "/srv/repos/notetaker" }],
};

function setup(opts: { demo?: boolean } = {}) {
  const ctx = makeHub(opts);
  const { hub, directory, store, clock } = ctx;
  const device = connectDevice(hub, directory);
  const other = connectDevice(hub, directory);
  const con = connectConnector(hub, directory, [CLAUDE, { key: "dev", name: "Dev agent", kind: "mock" as const }] as any);
  const agentId = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'claude'")!.id;
  const devAgentId = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev' AND connector_id IS NOT NULL")!.id;
  const run = (name: string, args: unknown, who = device) => hub.mutate(dev(who), mid(), name, args);
  const ok = (name: string, args: unknown) => {
    const ack = run(name, args);
    if (!ack.ok) throw new Error(`${name} failed: ${JSON.stringify((ack as any).error)}`);
    return ack;
  };
  const thread = (id: string) => readEntity<Thread>(store, "threads", id)!;
  const proj = (id: string) => readEntity<Project>(store, "projects", id);
  const newThread = (extra: Record<string, unknown> = {}) => {
    const threadId = newId("thr");
    ok("thread.create", { threadId, title: "New session with Claude agent", agentId, ...extra });
    return threadId;
  };
  const newProject = (name: string, extra: Record<string, unknown> = {}) => {
    const projectId = newId("prj");
    ok("project.create", { projectId, name, ...extra });
    return projectId;
  };
  const say = (threadId: string, text: string) => ok("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
  const starts = () => con.of("cmd").filter((c) => c.name === "run.start").map((c) => c.run);
  /** The connector's side of a run: statuses and the agent's finished texts. */
  let idx = 0;
  const status = (runId: string, s: string, extra: Record<string, unknown> = {}) => hub.onFrame(con, { t: "run.status", runId, status: s as any, at: clock.now, ...extra });
  const text = (runId: string, t: string) => hub.onFrame(con, { t: "run.event", runId, idx: idx++, at: clock.now, kind: "text", data: { text: t } });
  const changesOn = (who = other) => who.of("changes").flatMap((f) => f.changes);
  return { ...ctx, device, other, con, agentId, devAgentId, run, ok, thread, proj, newThread, newProject, say, starts, status, text, changesOn };
}

describe("projects", () => {
  it("creates a project, syncs it to every device, and its row satisfies the shared schema", () => {
    const s = setup();
    const id = s.newProject("  Notetaker  ", { description: "The app I maintain", defaultAgentId: s.agentId, defaultCwd: "/srv/repos/notetaker" });
    expect(s.proj(id)).toMatchObject({ name: "Notetaker", description: "The app I maintain", defaultAgentId: s.agentId, defaultCwd: "/srv/repos/notetaker", pinned: false, archived: false });
    const change = s.changesOn().filter((c) => c.entity === "projects").at(-1)!;
    expect(change).toMatchObject({ id, op: "upsert" });
    assertValid("projects", change.data);
    expect(s.run("project.create", { projectId: id, name: "Again" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(s.run("project.create", { projectId: newId("prj"), name: "   " })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("checks the default agent and that the working directory is one that agent offers", () => {
    const s = setup();
    expect(s.run("project.create", { projectId: newId("prj"), name: "X", defaultAgentId: "agt_nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(s.run("project.create", { projectId: newId("prj"), name: "X", defaultAgentId: s.agentId, defaultCwd: "/etc" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.run("project.create", { projectId: newId("prj"), name: "X", defaultCwd: "/srv/sandbox" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  });

  it("updates name, description, pin and archive; a new default agent drops the old agent's directory", () => {
    const s = setup();
    const id = s.newProject("Notetaker", { defaultAgentId: s.agentId, defaultCwd: "/srv/repos/notetaker" });
    s.ok("project.update", { projectId: id, name: "Notetaker app", description: "  ", pinned: true });
    expect(s.proj(id)).toMatchObject({ name: "Notetaker app", description: null, pinned: true, defaultCwd: "/srv/repos/notetaker" });
    s.ok("project.update", { projectId: id, defaultAgentId: s.devAgentId });
    expect(s.proj(id)).toMatchObject({ defaultAgentId: s.devAgentId, defaultCwd: null });
    s.ok("project.update", { projectId: id, defaultAgentId: null, archived: true });
    expect(s.proj(id)).toMatchObject({ defaultAgentId: null, defaultCwd: null, archived: true, pinned: true });
    expect(s.run("project.update", { projectId: "prj_nope", name: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("deleting a project never deletes a session: they all go back to Unsorted, with their messages", () => {
    const s = setup();
    const id = s.newProject("Notetaker");
    const a = s.newThread({ projectId: id });
    const b = s.newThread({ projectId: id });
    const elsewhere = s.newThread({ projectId: s.newProject("Other") });
    s.say(a, "Fix the sync cursor");
    s.ok("project.delete", { projectId: id });
    expect(s.proj(id)).toBeUndefined();
    expect(s.thread(a)).toMatchObject({ projectId: null, title: "Fix the sync cursor" });
    expect(s.thread(b).projectId).toBeNull();
    expect(s.thread(elsewhere).projectId).not.toBeNull();
    expect(s.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?", a)!.n).toBe(1);
    const seen = s.changesOn().filter((c) => c.entity === "projects" && c.id === id).at(-1)!;
    expect(seen.op).toBe("delete");
    expect(s.ok("project.delete", { projectId: id }).ok).toBe(true); // deleting twice is fine
    expect(JSON.parse(s.store.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'project.delete'")!.detail)).toEqual({ name: "Notetaker", sessionsMovedToUnsorted: 2 });
  });
});

describe("filing sessions", () => {
  it("a new session lands in Unsorted unless it is created in a project", () => {
    const s = setup();
    const id = s.newProject("Notetaker");
    expect(s.thread(s.newThread()).projectId).toBeNull();
    expect(s.thread(s.newThread({ projectId: id })).projectId).toBe(id);
    expect(s.run("thread.create", { threadId: newId("thr"), title: "t", projectId: "prj_nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("moves a session into a project and back to Unsorted, leaving everything else about it alone", () => {
    const s = setup();
    const id = s.newProject("Notetaker");
    const t = s.newThread();
    s.ok("thread.update", { threadId: t, title: "Sync cursor", pinned: true });
    s.ok("thread.update", { threadId: t, projectId: id });
    expect(s.thread(t)).toMatchObject({ projectId: id, title: "Sync cursor", pinned: true });
    const change = s.changesOn().filter((c) => c.entity === "threads" && c.id === t).at(-1)!;
    assertValid("threads", change.data);
    expect(change.data.projectId).toBe(id);
    s.ok("thread.update", { threadId: t, archived: true }); // a field that is not sent is not touched
    expect(s.thread(t)).toMatchObject({ projectId: id, archived: true });
    s.ok("thread.update", { threadId: t, projectId: null });
    expect(s.thread(t).projectId).toBeNull();
    expect(s.run("thread.update", { threadId: t, projectId: "prj_nope" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("keeps the owner's 'where I left off' note, and clears it with an empty one", () => {
    const s = setup();
    const t = s.newThread();
    s.ok("thread.update", { threadId: t, note: "  Waiting on the API key. Next: rerun the import.  " });
    expect(s.thread(t).note).toBe("Waiting on the API key. Next: rerun the import.");
    s.ok("thread.update", { threadId: t, pinned: true });
    expect(s.thread(t).note).toBe("Waiting on the API key. Next: rerun the import.");
    s.ok("thread.update", { threadId: t, note: "   " });
    expect(s.thread(t).note).toBeNull();
  });
});

describe("what a session remembers", () => {
  it("is named after the first thing said in it, once; a session the owner named keeps its name", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "Rotate the Resend webhook secret for Notetaker.\nIt leaked in a log.");
    expect(s.thread(t).title).toBe("Rotate the Resend webhook secret for Notetaker");
    s.say(t, "Also check the staging key");
    expect(s.thread(t).title).toBe("Rotate the Resend webhook secret for Notetaker");
    const named = newId("thr");
    s.ok("thread.create", { threadId: named, title: "Notes · Sun Nov 22", agentId: s.agentId });
    s.say(named, "something else entirely");
    expect(s.thread(named).title).toBe("Notes · Sun Nov 22");
  });

  it("tracks the status of its newest run through queued, running, waiting, and done", () => {
    const s = setup();
    const t = s.newThread();
    expect(s.thread(t).lastRunStatus ?? null).toBeNull();
    s.say(t, "deploy the fix");
    const runId = s.starts().at(-1)!.id;
    expect(s.thread(t)).toMatchObject({ lastRunStatus: "queued", lastMessageAt: s.clock.now });
    s.status(runId, "running", { sessionRef: "11111111-1111-4111-8111-111111111111" });
    expect(s.thread(t).lastRunStatus).toBe("running");
    s.hub.onFrame(s.con, { t: "approval.request", approval: { id: newId("apr"), runId, kind: "tool", tool: "Bash", title: "Push to origin", risk: "medium", requestedAt: s.clock.now } });
    expect(s.thread(t).lastRunStatus).toBe("waiting_approval");
    s.status(runId, "succeeded", { summary: "done" });
    expect(s.thread(t).lastRunStatus).toBe("succeeded");
    assertValid("threads", s.thread(t));
    // Every device hears about it as an ordinary thread change.
    expect(s.changesOn().filter((c) => c.entity === "threads" && c.id === t).map((c) => c.data.lastRunStatus)).toEqual(expect.arrayContaining(["queued", "running", "waiting_approval", "succeeded"]));
  });

  it("a late frame about an older run does not overwrite the status of the newest one", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "first");
    const first = s.starts().at(-1)!.id;
    s.status(first, "running");
    s.status(first, "succeeded");
    s.clock.now += 1000;
    s.say(t, "second");
    const second = s.starts().at(-1)!.id;
    s.status(second, "running");
    // The connector goes away: the newest run is offline. The first run is long finished.
    s.hub.store.run("UPDATE runs SET status = 'running' WHERE id = ?", first);
    s.status(first, "failed", { error: "late" });
    expect(s.thread(t).lastRunStatus).toBe("running");
  });

  it("keeps a plain one-line digest of the agent's last reply, without Markdown or tone markup", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "audit the login");
    const runId = s.starts().at(-1)!.id;
    s.status(runId, "running");
    s.clock.now += 5000;
    s.text(runId, "## Audit\nFound :critical[an SQL injection in `/login`] and **two** old deps.");
    expect(s.thread(t)).toMatchObject({ summary: "Audit Found an SQL injection in /login and two old deps.", lastMessageAt: s.clock.now });
    // The message itself is stored as the agent wrote it: the markup is for the clients to render.
    expect(s.store.get<{ text: string }>("SELECT text FROM messages WHERE thread_id = ? AND role = 'assistant'", t)!.text).toContain(":critical[an SQL injection in `/login`]");
    s.text(runId, "All fixed.");
    expect(s.thread(t).summary).toBe("All fixed.");
  });

  it("a failed run is where the session stands", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "query staging");
    const runId = s.starts().at(-1)!.id;
    s.status(runId, "running");
    s.status(runId, "failed", { error: "Could not reach the staging database." });
    expect(s.thread(t)).toMatchObject({ lastRunStatus: "failed", summary: "Run failed: Could not reach the staging database." });
  });

  it("notifications carry the words, not the markup", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "audit");
    const runId = s.starts().at(-1)!.id;
    s.status(runId, "running");
    s.device.frames.length = 0;
    s.status(runId, "succeeded", { summary: "Audit done: :critical[1 critical]." });
    expect(s.device.of("notify").at(-1).notification.body).toBe("Audit done: 1 critical.");
  });
});

describe("continuing a session", () => {
  it("a message in a session from last week resumes the same agent session, in the same directory", () => {
    const s = setup();
    const t = s.newThread();
    s.say(t, "start the migration");
    const first = s.starts().at(-1)!;
    expect(first.resumeSessionRef).toBeNull();
    s.status(first.id, "running", { sessionRef: "22222222-2222-4222-8222-222222222222" });
    s.status(first.id, "succeeded");
    s.clock.now += 7 * 86_400_000;
    // Filing it in a project in between changes nothing about how it resumes.
    s.ok("thread.update", { threadId: t, projectId: s.newProject("Notetaker", { defaultAgentId: s.agentId, defaultCwd: "/srv/repos/notetaker" }) });
    s.say(t, "where were we?");
    expect(s.starts().at(-1)).toMatchObject({ threadId: t, resumeSessionRef: "22222222-2222-4222-8222-222222222222", cwd: "/srv/sandbox" });
  });

  it("the first run of a session in a project starts in the project's directory", () => {
    const s = setup();
    const notetaker = s.newProject("Notetaker", { defaultAgentId: s.agentId, defaultCwd: "/srv/repos/notetaker" });
    const t = s.newThread({ projectId: notetaker });
    s.say(t, "run the tests");
    expect(s.starts().at(-1)).toMatchObject({ cwd: "/srv/repos/notetaker", resumeSessionRef: null });
    expect(s.store.get<{ cwd: string }>("SELECT cwd FROM runs WHERE thread_id = ?", t)!.cwd).toBe("/srv/repos/notetaker");
    // A session with another agent ignores a directory that agent does not have.
    const other = newId("thr");
    s.ok("thread.create", { threadId: other, title: "t", agentId: s.devAgentId, projectId: notetaker });
    s.say(other, "hello");
    expect(s.starts().at(-1)!.cwd).toBeNull();
    // No project directory: the agent's own default, as before.
    const plain = s.newThread({ projectId: s.newProject("Plain") });
    s.say(plain, "hello");
    expect(s.starts().at(-1)!.cwd).toBe("/srv/sandbox");
  });
});

describe("recap", () => {
  function withHistory() {
    const s = setup();
    const t = s.newThread();
    s.say(t, "start the migration");
    const first = s.starts().at(-1)!.id;
    s.status(first, "running", { sessionRef: "33333333-3333-4333-8333-333333333333" });
    s.text(first, "Migrated 3 of 5 tables.");
    s.status(first, "succeeded");
    s.clock.now += 3 * 86_400_000;
    return { s, t };
  }

  it("asks the same agent session for a recap and keeps the answer on the session", () => {
    const { s, t } = withHistory();
    const messageId = newId("msg");
    s.ok("thread.recap", { threadId: t, messageId });
    const start = s.starts().at(-1)!;
    expect(start).toMatchObject({ threadId: t, prompt: RECAP_PROMPT, resumeSessionRef: "33333333-3333-4333-8333-333333333333", options: { mode: "manual" } });
    expect(readEntity(s.store, "messages", messageId)).toMatchObject({ role: "user", text: RECAP_REQUEST, runId: start.id });
    expect(s.thread(t)).toMatchObject({ recapRunId: start.id, recap: null, lastRunStatus: "queued", title: "start the migration" });

    s.status(start.id, "running");
    s.clock.now += 4000;
    s.text(start.id, "**Doing:** the migration.\n**Done:** 3 of 5 tables.\n**Next:** the last two; nothing waits on you.");
    expect(s.thread(t)).toMatchObject({ recap: "**Doing:** the migration.\n**Done:** 3 of 5 tables.\n**Next:** the last two; nothing waits on you.", recapAt: s.clock.now, recapRunId: start.id });
    s.status(start.id, "succeeded");
    expect(s.thread(t)).toMatchObject({ recapRunId: null, lastRunStatus: "succeeded" });
    assertValid("threads", s.thread(t));

    // Later replies do not touch the recap; it just becomes older than the conversation.
    s.clock.now += 3_600_000;
    s.say(t, "do the last two");
    const next = s.starts().at(-1)!.id;
    s.status(next, "running");
    s.text(next, "All 5 tables migrated.");
    expect(s.thread(t)).toMatchObject({ summary: "All 5 tables migrated.", recap: expect.stringContaining("3 of 5 tables") });
    expect(s.thread(t).lastMessageAt!).toBeGreaterThan(s.thread(t).recapAt!);
  });

  it("stops waiting when the recap run fails or the connector loses it", () => {
    const { s, t } = withHistory();
    s.ok("thread.recap", { threadId: t, messageId: newId("msg") });
    const id = s.starts().at(-1)!.id;
    s.status(id, "running");
    s.status(id, "failed", { error: "boom" });
    expect(s.thread(t)).toMatchObject({ recapRunId: null, recap: null, lastRunStatus: "failed" });
  });

  it("is refused while the agent is working, and for a session with no agent", () => {
    const { s, t } = withHistory();
    s.say(t, "keep going");
    expect(s.run("thread.recap", { threadId: t, messageId: newId("msg") })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const scratch = newId("thr");
    s.ok("thread.create", { threadId: scratch, title: "Scratch" });
    expect(s.run("thread.recap", { threadId: scratch, messageId: newId("msg") })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.run("thread.recap", { threadId: "thr_nope", messageId: newId("msg") })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("sync", () => {
  it("a fresh device gets projects and the session fields in its snapshot", () => {
    const s = setup();
    const id = s.newProject("Notetaker");
    const t = s.newThread({ projectId: id });
    s.ok("thread.update", { threadId: t, note: "left here" });
    const fresh = connectDevice(s.hub, s.directory);
    const snap = fresh.of("snapshot")[0];
    expect(snap.entities.projects.map((p: Project) => p.name)).toEqual(["Notetaker"]);
    expect(snap.entities.threads.find((x: Thread) => x.id === t)).toMatchObject({ projectId: id, note: "left here" });
    for (const p of snap.entities.projects) assertValid("projects", p);
    for (const x of snap.entities.threads) assertValid("threads", x);
  });

  it("the demo workspace has projects, filed sessions and Unsorted ones, all valid", () => {
    const { hub, store } = makeHub({ demo: true });
    backfillSessions(hub);
    const snap = hub.snapshot();
    const projects = snap.entities.projects as Project[];
    const threads = snap.entities.threads as Thread[];
    expect(projects.map((p) => p.name).sort()).toEqual(["Harbor & Pine Realty", "Northwind Supply"]);
    expect(threads.filter((t) => t.projectId).length).toBe(2);
    expect(threads.filter((t) => !t.projectId).length).toBe(3);
    for (const t of threads) expect(ENTITY_SCHEMAS.threads.safeParse(t).success).toBe(true);
    const failed = threads.find((t) => t.title.startsWith("Northwind"))!;
    expect(failed).toMatchObject({ lastRunStatus: "failed", note: expect.stringContaining("staging tunnel") });
    expect(threads.find((t) => t.title.startsWith("Harbor"))!.summary).toMatch(/^Fixed on staging\./);
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads WHERE last_run_status IS NULL AND agent_id IS NOT NULL")!.n).toBe(0);
  });
});

describe("upgrading a database from before session organisation", () => {
  const dirs: string[] = [];
  const stores: Array<{ close(): void }> = [];
  const open = (path: string) => {
    const store = openStore(path);
    stores.push(store);
    return store;
  };
  afterEach(() => {
    // Close whatever a failed test left open, or Windows will not let the folder go.
    for (const st of stores.splice(0)) {
      try {
        st.close();
      } catch {}
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** The threads table exactly as the hub created it up to 2026-11-19, with rows in it. */
  const OLD_THREADS = `CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT, last_message_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, mode TEXT
  );`;

  function oldDatabase() {
    const dir = mkdtempSync(join(tmpdir(), "hb-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "homebase.db");
    const old = new NodeSqlStore(path);
    old.exec(OLD_THREADS);
    const ins = "INSERT INTO threads (id, title, agent_id, last_message_at, pinned, archived, created_by, created_at, updated_at, mode) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)";
    old.run(ins, "thr_a", "New chat with Claude agent", "agt_c", 2000, 1, 0, 1000, 2000, "auto");
    old.run(ins, "thr_b", "Notetaker release notes", "agt_c", 3000, 0, 0, 1000, 3000, null);
    old.run(ins, "thr_c", "New scratch thread", null, null, 0, 1, 1000, 1000, null);
    old.run(ins, "thr_d", "Notes · Thu Nov 19", "agt_c", 4000, 0, 0, 1000, 4000, null);
    old.close();
    return path;
  }

  it("keeps every thread and every field, adds the new columns, and puts all of them in Unsorted", () => {
    const path = oldDatabase();
    const store = open(path);
    const cols = store.all<{ name: string }>("PRAGMA table_info(threads)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["mode", "project_id", "note", "summary", "recap", "recap_at", "recap_run_id", "last_run_status"]));
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM projects")!.n).toBe(0);
    const threads = store.all<{ id: string }>("SELECT id FROM threads ORDER BY id").map((r) => readEntity<Thread>(store, "threads", r.id)!);
    expect(threads.map((t) => t.id)).toEqual(["thr_a", "thr_b", "thr_c", "thr_d"]);
    expect(threads[0]).toMatchObject({ title: "New chat with Claude agent", agentId: "agt_c", lastMessageAt: 2000, pinned: true, archived: false, mode: "auto", projectId: null, note: null });
    expect(threads[2]).toMatchObject({ archived: true, agentId: null });
    for (const t of threads) {
      expect(t.projectId).toBeNull(); // Unsorted
      expect(ENTITY_SCHEMAS.threads.safeParse(t).success).toBe(true);
    }
    store.close();
    // Opening it a second time changes nothing and does not fail on columns that are already there.
    const again = open(path);
    expect(again.all("PRAGMA table_info(threads)")).toHaveLength(cols.length);
    expect(again.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads")!.n).toBe(4);
  });

  it("backfills status, digest and a real title from what is already stored, once, without touching messages", () => {
    const path = oldDatabase();
    const store = open(path);
    const hub = new WorkspaceHub(store, { quiet: true, now: () => 10_000 });
    seed(hub, { demo: false });
    const msg = "INSERT INTO messages (id, thread_id, role, text, source, run_id, author_device_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)";
    store.run(msg, "msg_1", "thr_a", "user", "Fix the sync cursor on upgrade", "text", 1500);
    store.run(msg, "msg_2", "thr_a", "assistant", "Working on: the cursor", "agent", 1600);
    store.run(msg, "msg_3", "thr_a", "assistant", "**Done.** The cursor key now includes the entity list.", "agent", 2000);
    store.run(msg, "msg_4", "thr_b", "user", "Draft the release notes", "text", 2500);
    store.run(msg, "msg_5", "thr_b", "system", "Run failed: connector offline", "agent", 3000);
    store.run(msg, "msg_6", "thr_d", "user", "note this down", "voice", 4000);
    const runSql = `INSERT INTO runs (id, agent_id, thread_id, prompt, status, last_event_idx, created_at, updated_at) VALUES (?, 'agt_c', ?, 'p', ?, -1, ?, ?)`;
    store.run(runSql, "run_1", "thr_a", "failed", 1500, 1500);
    store.run(runSql, "run_2", "thr_a", "succeeded", 1900, 2000);
    store.run(runSql, "run_3", "thr_b", "failed", 2500, 3000);
    const messagesBefore = store.all("SELECT * FROM messages ORDER BY id");

    const first = backfillSessions(hub);
    expect(first).toEqual({ threads: 2, titled: 1 });
    const t = (id: string) => readEntity<Thread>(store, "threads", id)!;
    expect(t("thr_a")).toMatchObject({ title: "Fix the sync cursor on upgrade", lastRunStatus: "succeeded", summary: "Done. The cursor key now includes the entity list.", pinned: true, mode: "auto", projectId: null });
    expect(t("thr_b")).toMatchObject({ title: "Notetaker release notes", lastRunStatus: "failed", summary: "Run failed: connector offline" });
    expect(t("thr_c")).toMatchObject({ title: "New scratch thread", lastRunStatus: null, summary: null, archived: true }); // nothing was ever said in it
    expect(t("thr_d")).toMatchObject({ title: "Notes · Thu Nov 19", summary: null }); // a real title is never replaced
    expect(store.all("SELECT * FROM messages ORDER BY id")).toEqual(messagesBefore);
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM threads")!.n).toBe(4);

    // The backfilled rows go out as ordinary changes, and a second pass finds nothing to do.
    const changed = hub.changesAfter(0).filter((c) => c.entity === "threads").map((c) => c.id).sort();
    expect(changed).toEqual(["thr_a", "thr_b"]);
    const seq = hub.currentSeq();
    expect(backfillSessions(hub)).toEqual({ threads: 0, titled: 0 });
    hub.start(3_600_000);
    hub.stop();
    expect(hub.changesAfter(seq).filter((c) => c.entity === "threads")).toHaveLength(0);
  });

  it("an upgraded hub still serves a device its old threads in a snapshot", () => {
    const path = oldDatabase();
    const store = open(path);
    const hub = new WorkspaceHub(store, { quiet: true });
    seed(hub, { demo: false });
    hub.start(3_600_000);
    const directory = new Directory(store, hub.now);
    const p = connectDevice(hub, directory);
    const snap = p.of("snapshot")[0];
    expect(snap.entities.threads).toHaveLength(4);
    expect(snap.entities.projects).toEqual([]);
    hub.stop();
  });
});
