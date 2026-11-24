import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EFFORTS, ENTITY_SCHEMAS, newId, type Agent, type Message, type Run, type Thread } from "@homebase/protocol";
import { openStore } from "../src/app";
import { Directory } from "../src/directory";
import { NodeSqlStore } from "../src/hub/SqlStore";
import { readEntity } from "../src/hub/tables";
import { WorkspaceHub } from "../src/hub/WorkspaceHub";
import { seed } from "../src/seed";
import { assertValid, connectConnector, connectDevice, makeHub, mid } from "./helpers";

const dev = (p: { id: string }) => ({ id: p.id, canApprove: true });
const IDS = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
/** What a connector registers for a Claude agent: the models it offers and what it is configured with. */
const CLAUDE = {
  key: "claude", name: "Claude agent", kind: "claude" as const, modes: ["manual", "auto", "plan"] as Array<"manual" | "auto" | "plan">,
  workspaces: [{ label: "sandbox", cwd: "/srv/sandbox" }], models: IDS, efforts: [...EFFORTS], model: "claude-sonnet-5-5", effort: null,
};
const SCRIPTED = { key: "dev", name: "Dev agent", kind: "mock" as const };
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

function setup(agents: any[] = [CLAUDE, SCRIPTED]) {
  const ctx = makeHub();
  const { hub, directory, store, clock } = ctx;
  const device = connectDevice(hub, directory);
  const other = connectDevice(hub, directory);
  const con = connectConnector(hub, directory, agents);
  const idOf = (key: string) => store.get<{ id: string }>("SELECT id FROM agents WHERE key = ? AND connector_id IS NOT NULL", key)!.id;
  const agentId = idOf("claude");
  const run = (name: string, args: unknown) => hub.mutate(dev(device), mid(), name, args);
  const ok = (name: string, args: unknown) => {
    const ack = run(name, args);
    if (!ack.ok) throw new Error(`${name} failed: ${JSON.stringify((ack as any).error)}`);
    return ack;
  };
  const agent = (id = agentId) => readEntity<Agent>(store, "agents", id)!;
  const thread = (id: string) => readEntity<Thread>(store, "threads", id)!;
  const runRow = (id: string) => readEntity<Run>(store, "runs", id)!;
  const newThread = (forAgent = agentId) => {
    const threadId = newId("thr");
    ok("thread.create", { threadId, title: "Session", agentId: forAgent });
    return threadId;
  };
  const say = (threadId: string, text: string) => {
    clock.now += 1000; // a person does not type two messages in the same millisecond
    ok("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    return starts().at(-1)!;
  };
  const starts = () => con.of("cmd").filter((c) => c.name === "run.start").map((c) => c.run);
  let idx = 0;
  /** The connector's side of a turn: the CLI's first message, a reply, the end. */
  const finish = (runId: string, session: string, model = "claude-sonnet-5-5", reply = "Done.") => {
    hub.onFrame(con, { t: "run.status", runId, status: "running", sessionRef: session, at: clock.now });
    hub.onFrame(con, { t: "run.event", runId, idx: idx++, at: clock.now, kind: "system", data: { message: "Claude session started", sessionId: session, model } });
    hub.onFrame(con, { t: "run.event", runId, idx: idx++, at: clock.now, kind: "text", data: { text: reply } });
    hub.onFrame(con, { t: "run.status", runId, status: "succeeded", at: clock.now });
  };
  const messages = (threadId: string) =>
    store.all<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id", threadId).map((r) => readEntity<Message>(store, "messages", r.id)!);
  const markers = (threadId: string) => messages(threadId).filter((m) => m.card?.type === "session_marker");
  const audit = (action: string) => store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = ? ORDER BY at, id", action).map((a) => JSON.parse(a.detail));
  return { ...ctx, device, other, con, agentId, idOf, run, ok, agent, thread, runRow, newThread, say, starts, finish, messages, markers, audit };
}

describe("what an agent offers", () => {
  it("a Claude agent registers its models, efforts and its own setting; a scripted agent registers none", () => {
    const s = setup();
    expect(s.agent()).toMatchObject({ models: IDS, efforts: [...EFFORTS], configModel: "claude-sonnet-5-5", configEffort: null, defaultModel: null, defaultEffort: null });
    expect(s.agent(s.idOf("dev"))).toMatchObject({ models: null, efforts: null, configModel: null, defaultModel: null });
    assertValid("agents", s.agent());
    assertValid("agents", s.agent(s.idOf("dev")));
  });

  it("the owner's default survives a connector restart, unless the connector stopped offering it", () => {
    const s = setup();
    s.ok("model.set", { scope: "agent", id: s.agentId, model: "claude-opus-5-5", effort: "high" });
    const register = (over: Record<string, unknown> = {}) => s.hub.onFrame(s.con, { t: "register", host: { name: "c", os: "t" }, agents: [{ description: "", capabilities: [], ...CLAUDE, ...over }] });
    register();
    expect(s.agent()).toMatchObject({ defaultModel: "claude-opus-5-5", defaultEffort: "high" });
    register({ models: ["claude-sonnet-5-5", "claude-haiku-5-5"], efforts: ["low", "medium"] });
    expect(s.agent()).toMatchObject({ models: ["claude-sonnet-5-5", "claude-haiku-5-5"], defaultModel: null, defaultEffort: null });
    // A connector from before model choice sends no list at all: the agent goes back to having no choice.
    register({ models: undefined, efforts: undefined, model: undefined, effort: undefined });
    expect(s.agent()).toMatchObject({ models: null, efforts: null, configModel: null });
  });
});

describe("model.set", () => {
  it("sets an agent's default, syncs it to every device, and records who changed what", () => {
    const s = setup();
    s.ok("model.set", { scope: "agent", id: s.agentId, model: "opus", effort: "high" }); // an alias is stored as the offered name
    expect(s.agent()).toMatchObject({ defaultModel: "claude-opus-5-5", defaultEffort: "high" });
    const change = s.other.of("changes").flatMap((f) => f.changes).filter((c) => c.entity === "agents" && c.id === s.agentId).at(-1)!;
    expect(change.data).toMatchObject({ defaultModel: "claude-opus-5-5", defaultEffort: "high" });
    assertValid("agents", change.data);
    expect(s.audit("model.set")).toEqual([{ scope: "agent", from: { model: null, effort: null }, to: { model: "claude-opus-5-5", effort: "high" } }]);
    // A field that is not sent is left alone; null goes back to the connector's setting.
    s.ok("model.set", { scope: "agent", id: s.agentId, effort: "low" });
    expect(s.agent()).toMatchObject({ defaultModel: "claude-opus-5-5", defaultEffort: "low" });
    s.ok("model.set", { scope: "agent", id: s.agentId, model: null });
    expect(s.agent()).toMatchObject({ defaultModel: null, defaultEffort: "low" });
    const seq = s.hub.currentSeq();
    s.ok("model.set", { scope: "agent", id: s.agentId, effort: "low" }); // no change: nothing is written
    expect(s.hub.currentSeq()).toBe(seq);
  });

  it("sets a session's own choice, which wins over the agent's default", () => {
    const s = setup();
    s.ok("model.set", { scope: "agent", id: s.agentId, model: "claude-opus-5-5", effort: "high" });
    const t = s.newThread();
    expect(s.thread(t)).toMatchObject({ model: null, effort: null }); // a new session follows the agent
    s.ok("model.set", { scope: "thread", id: t, model: "claude-haiku-5-5" });
    expect(s.thread(t)).toMatchObject({ model: "claude-haiku-5-5", effort: null });
    assertValid("threads", s.thread(t));
    expect(s.say(t, "hello").options).toMatchObject({ model: "claude-haiku-5-5", effort: "high" }); // its model, the agent's effort
    s.ok("model.set", { scope: "thread", id: t, model: null, effort: null });
    expect(s.thread(t)).toMatchObject({ model: null, effort: null });
  });

  it("refuses what the agent does not offer, a scripted agent, a session with no agent, and unknown ids", () => {
    const s = setup([{ ...CLAUDE, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], efforts: ["low", "medium", "high"] }, SCRIPTED]);
    const t = s.newThread();
    expect(s.run("model.set", { scope: "thread", id: t, model: "claude-fable-5-2" })).toMatchObject({ ok: false, error: { code: "invalid_args", message: "Claude agent does not offer the model claude-fable-5-2" } });
    expect(s.run("model.set", { scope: "agent", id: s.agentId, effort: "max" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.run("model.set", { scope: "agent", id: s.agentId, model: "--resume" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.run("model.set", { scope: "agent", id: s.agentId, model: "claude-haiku-5-5", fresh: true })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.run("model.set", { scope: "agent", id: s.idOf("dev"), model: "claude-haiku-5-5" })).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("scripted agent") } });
    const scripted = s.newThread(s.idOf("dev"));
    expect(s.run("model.set", { scope: "thread", id: scripted, effort: "low" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const scratch = newId("thr");
    s.ok("thread.create", { threadId: scratch, title: "Scratch" });
    expect(s.run("model.set", { scope: "thread", id: scratch, model: "claude-haiku-5-5" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.run("model.set", { scope: "thread", id: "thr_nope", model: "claude-haiku-5-5" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(s.run("model.set", { scope: "agent", id: "agt_nope", model: "claude-haiku-5-5" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(s.thread(t)).toMatchObject({ model: null, effort: null });
  });
});

describe("what a run is started with", () => {
  it("nothing chosen: no model and no effort are sent, exactly as before model choice existed", () => {
    const s = setup();
    const t = s.newThread();
    const start = s.say(t, "hello");
    expect(start.options).toEqual({ permissionProfile: "standard", mode: "manual" });
    expect("model" in start.options).toBe(false);
    expect(s.runRow(start.id)).toMatchObject({ model: null, effort: null });
    assertValid("runs", s.runRow(start.id));
    expect(s.markers(t)).toHaveLength(0);
  });

  it("the run records what it was asked to use; what the CLI reports stays on its timeline", () => {
    const s = setup();
    const t = s.newThread();
    s.ok("model.set", { scope: "thread", id: t, model: "claude-opus-5-5", effort: "xhigh" });
    const start = s.say(t, "hello");
    expect(start.options).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
    expect(s.runRow(start.id)).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
    s.finish(start.id, S1, "claude-opus-5-5-20261001");
    expect(s.runRow(start.id)).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh", status: "succeeded" });
    // A CLI that names its model differently from what was asked (a dated name, a newer alias target) never causes a marker.
    const again = s.say(t, "again");
    s.finish(again.id, S1, "claude-opus-9-9");
    s.say(t, "and again");
    expect(s.markers(t)).toHaveLength(0);
    assertValid("runs", s.runRow(start.id));
    expect(s.audit("run.start").map((r) => [r.model, r.effort, r.resumed])).toEqual([["claude-opus-5-5", "xhigh", false], ["claude-opus-5-5", "xhigh", true], ["claude-opus-5-5", "xhigh", true]]);
  });

  it("a one-off run can ask for its own model and effort, and only an offered one goes out", () => {
    const s = setup();
    s.ok("run.start", { runId: newId("run"), agentId: s.agentId, prompt: "one off", options: { model: "haiku", effort: "low" } });
    expect(s.starts().at(-1)!.options).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
    const narrow = setup([{ ...CLAUDE, models: ["claude-sonnet-5-5"], efforts: ["low"] }]);
    narrow.ok("run.start", { runId: newId("run"), agentId: narrow.agentId, prompt: "one off", options: { model: "claude-fable-5-2", effort: "max" } });
    const sent = narrow.starts().at(-1)!.options;
    expect(sent.model).toBeUndefined(); // what was asked for is dropped, not passed through
    expect(sent.effort).toBeUndefined();
  });

  it("a scripted agent's runs carry no model, whatever its session row says", () => {
    const s = setup();
    const t = s.newThread(s.idOf("dev"));
    s.store.run("UPDATE threads SET model = 'claude-opus-5-5', effort = 'max' WHERE id = ?", t);
    const start = s.say(t, "hello");
    expect(start.options.model).toBeUndefined();
    expect(s.runRow(start.id)).toMatchObject({ model: null, effort: null });
    expect(s.markers(t)).toHaveLength(0);
  });
});

describe("switching in the middle of a session", () => {
  function underway() {
    const s = setup();
    const t = s.newThread();
    const first = s.say(t, "start the migration");
    s.finish(first.id, S1, "claude-sonnet-5-5", "Migrated 3 of 5 tables.");
    return { s, t, first };
  }

  it("keep the conversation: the next run resumes the same agent session on the new model, and the session says so", () => {
    const { s, t } = underway();
    s.ok("model.set", { scope: "thread", id: t, model: "claude-opus-5-5", effort: "high" });
    expect(s.markers(t)).toHaveLength(0); // nothing is written until it actually takes effect
    const second = s.say(t, "do the last two");
    expect(second).toMatchObject({ resumeSessionRef: S1, cwd: "/srv/sandbox", options: { model: "claude-opus-5-5", effort: "high" } });
    const [marker] = s.markers(t);
    expect(marker).toMatchObject({
      role: "system", runId: second.id, text: "Now on Opus 5.5 · High. The conversation is kept.",
      card: { type: "session_marker", kind: "switch", model: "claude-opus-5-5", effort: "high" },
    });
    assertValid("messages", marker);
    // It sits between what the owner said and the reply it applies to.
    s.finish(second.id, S1, "claude-opus-5-5", "All 5 migrated.");
    expect(s.messages(t).map((m) => m.card?.type === "session_marker" ? "MARKER" : `${m.role}: ${m.text}`)).toEqual([
      "user: start the migration", "assistant: Migrated 3 of 5 tables.", "user: do the last two", "MARKER", "assistant: All 5 migrated.",
    ]);
    // The marker is not what the session "last said".
    expect(s.thread(t).summary).toBe("All 5 migrated.");
    // The same choice again: no second marker.
    const third = s.say(t, "thanks");
    expect(third).toMatchObject({ resumeSessionRef: S1, options: { model: "claude-opus-5-5", effort: "high" } });
    expect(s.markers(t)).toHaveLength(1);
    expect(s.audit("run.start").at(-1)).toMatchObject({ resumed: true });
  });

  it("only the effort changes: the session is resumed and the marker names the new effort", () => {
    const { s, t } = underway();
    s.ok("model.set", { scope: "thread", id: t, effort: "max" });
    const second = s.say(t, "think harder");
    expect(second).toMatchObject({ resumeSessionRef: S1, options: { effort: "max" } });
    expect(second.options.model).toBeUndefined(); // the model is still the connector's own setting
    expect(s.markers(t).map((m) => m.text)).toEqual(["Now on Sonnet 5.5 · Max. The conversation is kept."]);
  });

  it("picking the model that is already running, by name, changes nothing and marks nothing", () => {
    const { s, t } = underway();
    s.ok("model.set", { scope: "thread", id: t, model: "claude-sonnet-5-5" }); // the connector's setting, spelled out
    const second = s.say(t, "go on");
    expect(second).toMatchObject({ resumeSessionRef: S1, options: { model: "claude-sonnet-5-5" } });
    expect(s.markers(t)).toHaveLength(0);
  });

  it("start fresh: the next run does not resume, the session says the agent no longer sees what came before, and nothing is deleted", () => {
    const { s, t, first } = underway();
    s.clock.now += 60_000;
    s.ok("model.set", { scope: "thread", id: t, model: "claude-haiku-5-5", fresh: true });
    expect(s.thread(t)).toMatchObject({ model: "claude-haiku-5-5", sessionResetAt: s.clock.now });
    const second = s.say(t, "new topic");
    expect(second).toMatchObject({ resumeSessionRef: null, cwd: "/srv/sandbox", options: { model: "claude-haiku-5-5" } }); // same directory, new agent session
    const [marker] = s.markers(t);
    expect(marker).toMatchObject({
      text: "New agent session on Haiku 5.5 · Default effort. The agent does not see the messages above.",
      card: { type: "session_marker", kind: "fresh", model: "claude-haiku-5-5", effort: null },
    });
    expect(s.messages(t).filter((m) => m.role !== "system").map((m) => m.text)).toEqual(["start the migration", "Migrated 3 of 5 tables.", "new topic"]);
    expect(s.runRow(first.id).sessionRef).toBe(S1); // the old run keeps its record
    expect(s.audit("model.set").at(-1)).toMatchObject({ scope: "thread", fresh: true, to: { model: "claude-haiku-5-5", effort: null } });
    expect(s.audit("run.start").at(-1)).toMatchObject({ resumed: false });

    // From here the new agent session is the one that is resumed, with no further marker.
    s.finish(second.id, S2, "claude-haiku-5-5", "Sure.");
    const third = s.say(t, "and then?");
    expect(third).toMatchObject({ resumeSessionRef: S2, options: { model: "claude-haiku-5-5" } });
    expect(s.markers(t)).toHaveLength(1);
  });

  it("start fresh without changing the model is allowed, and is refused while the agent is working", () => {
    const { s, t } = underway();
    const live = s.say(t, "keep going");
    expect(s.run("model.set", { scope: "thread", id: t, fresh: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(s.thread(t).sessionResetAt ?? null).toBeNull();
    // Changing the model while it works is fine: it is read when the next run starts.
    s.ok("model.set", { scope: "thread", id: t, model: "claude-opus-5-5" });
    expect(s.con.of("cmd").filter((c) => c.name !== "run.start")).toHaveLength(0); // nothing is sent to the running process
    s.finish(live.id, S1);
    s.clock.now += 1000;
    s.ok("model.set", { scope: "thread", id: t, fresh: true });
    const next = s.say(t, "again");
    expect(next).toMatchObject({ resumeSessionRef: null, options: { model: "claude-opus-5-5" } });
    expect(s.markers(t).map((m) => (m.card as any).kind)).toEqual(["fresh"]);
  });

  it("a session that follows the agent picks up a new default at its next message, keeps its conversation, and says so", () => {
    const { s, t } = underway();
    s.ok("model.set", { scope: "agent", id: s.agentId, model: "claude-fable-5-2", effort: "xhigh" });
    const second = s.say(t, "go on");
    expect(second).toMatchObject({ resumeSessionRef: S1, options: { model: "claude-fable-5-2", effort: "xhigh" } });
    expect(s.markers(t).map((m) => m.text)).toEqual(["Now on Fable 5.2 · Extra high. The conversation is kept."]);
    // A session with its own choice is not moved by the agent's default.
    const own = s.newThread();
    s.ok("model.set", { scope: "thread", id: own, model: "claude-haiku-5-5", effort: "low" });
    expect(s.say(own, "hi").options).toMatchObject({ model: "claude-haiku-5-5", effort: "low" });
  });

  it("a recap is written by whatever the session is on, and is resumed like any other turn", () => {
    const { s, t } = underway();
    s.ok("model.set", { scope: "thread", id: t, model: "claude-opus-5-5" });
    s.clock.now += 1000;
    s.ok("thread.recap", { threadId: t, messageId: newId("msg") });
    expect(s.starts().at(-1)).toMatchObject({ resumeSessionRef: S1, options: { mode: "manual", model: "claude-opus-5-5" } });
    expect(s.markers(t)).toHaveLength(1);
  });
});

describe("sync and upgrade", () => {
  it("a fresh device gets the agent's offer and every session's choice in its snapshot", () => {
    const s = setup();
    const t = s.newThread();
    s.ok("model.set", { scope: "thread", id: t, model: "claude-opus-5-5", effort: "high" });
    const fresh = connectDevice(s.hub, s.directory);
    const snap = fresh.of("snapshot")[0];
    expect(snap.entities.agents.find((a: Agent) => a.id === s.agentId)).toMatchObject({ models: IDS, configModel: "claude-sonnet-5-5" });
    expect(snap.entities.threads.find((x: Thread) => x.id === t)).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    for (const a of snap.entities.agents) assertValid("agents", a);
  });

  const dirs: string[] = [];
  const stores: Array<{ close(): void }> = [];
  afterEach(() => {
    for (const st of stores.splice(0)) {
      try {
        st.close();
      } catch {}
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a database from before model choice gains the columns, keeps every row, and its sessions run as they did", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-models-"));
    dirs.push(dir);
    const path = join(dir, "homebase.db");
    // Agents, threads and runs exactly as the hub created them up to 2026-11-22.
    const old = new NodeSqlStore(path);
    old.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, connector_id TEXT, key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]', workspaces TEXT NOT NULL DEFAULT '[]', permission_profile TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL, updated_at INTEGER NOT NULL, status_note TEXT, modes TEXT, default_mode TEXT, auth TEXT, gmail TEXT, vault TEXT);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT, last_message_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, mode TEXT,
      project_id TEXT, note TEXT, summary TEXT, recap TEXT, recap_at INTEGER, recap_run_id TEXT, last_run_status TEXT);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, thread_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, session_ref TEXT,
      summary TEXT, error TEXT, cost_usd REAL, num_turns INTEGER, duration_ms INTEGER, last_event_idx INTEGER NOT NULL DEFAULT -1,
      started_by TEXT, cwd TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL, mode TEXT);`);
    old.run("INSERT INTO agents (id, connector_id, key, name, kind, status, updated_at, modes, default_mode) VALUES ('agt_c', NULL, 'claude', 'Claude agent', 'claude', 'offline', 1, '[\"manual\",\"auto\"]', 'auto')");
    old.run("INSERT INTO threads (id, title, agent_id, last_message_at, created_at, updated_at, note, last_run_status) VALUES ('thr_a', 'Sync cursor', 'agt_c', 2000, 1000, 2000, 'left here', 'succeeded')");
    old.run(`INSERT INTO runs (id, agent_id, thread_id, prompt, status, session_ref, cwd, created_at, updated_at, mode) VALUES ('run_1', 'agt_c', 'thr_a', 'p', 'succeeded', '${S1}', '/srv/sandbox', 1500, 2000, 'auto')`);
    old.close();

    const store = openStore(path);
    stores.push(store);
    const cols = (t: string) => store.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols("agents")).toEqual(expect.arrayContaining(["models", "efforts", "config_model", "config_effort", "default_model", "default_effort"]));
    expect(cols("threads")).toEqual(expect.arrayContaining(["model", "effort", "session_reset_at"]));
    expect(cols("runs")).toEqual(expect.arrayContaining(["model", "effort"]));
    const agent = readEntity<Agent>(store, "agents", "agt_c")!;
    const thread = readEntity<Thread>(store, "threads", "thr_a")!;
    const oldRun = readEntity<Run>(store, "runs", "run_1")!;
    expect(agent).toMatchObject({ name: "Claude agent", defaultMode: "auto", models: null, defaultModel: null, defaultEffort: null });
    expect(thread).toMatchObject({ title: "Sync cursor", note: "left here", lastRunStatus: "succeeded", model: null, effort: null, sessionResetAt: null });
    expect(oldRun).toMatchObject({ sessionRef: S1, mode: "auto", model: null, effort: null });
    for (const [e, row] of [["agents", agent], ["threads", thread], ["runs", oldRun]] as const) expect(ENTITY_SCHEMAS[e].safeParse(row).success).toBe(true);

    // The upgraded hub, with the upgraded connector registered: the old session resumes with no model asked for and no marker.
    let now = 10_000;
    const hub = new WorkspaceHub(store, { quiet: true, now: () => now });
    seed(hub, { demo: false });
    const directory = new Directory(store, hub.now);
    const device = connectDevice(hub, directory);
    const con = connectConnector(hub, directory, [CLAUDE] as any);
    expect(readEntity<Agent>(store, "agents", "agt_c")).toMatchObject({ models: IDS, configModel: "claude-sonnet-5-5", defaultModel: null, defaultMode: "auto" });
    now += 1000;
    expect(hub.mutate(dev(device), mid(), "message.send", { threadId: "thr_a", messageId: newId("msg"), text: "where were we?", source: "text" }).ok).toBe(true);
    const start = con.of("cmd").filter((c) => c.name === "run.start").at(-1).run;
    expect(start).toMatchObject({ resumeSessionRef: S1, cwd: "/srv/sandbox" });
    expect(start.options.model).toBeUndefined();
    expect(start.options.effort).toBeUndefined();
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE card IS NOT NULL")!.n).toBe(0);
  });
});
