import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EFFORTS, ENTITY_SCHEMAS, newId, type Agent, type AgentFolderFacts, type Message, type Project, type Run, type Thread } from "@homebase/protocol";
import { openStore } from "../src/app";
import { Directory } from "../src/directory";
import { NodeSqlStore, type SqlStore } from "../src/hub/SqlStore";
import { readEntity } from "../src/hub/tables";
import { WorkspaceHub } from "../src/hub/WorkspaceHub";
import { seed } from "../src/seed";
import { assertValid, connectConnector, connectDevice, makeHub, mid, pairDevice, peer } from "./helpers";

const SANDBOX = "/home/o/homebase-data/claude-workspace";
const BRAIN = "/home/o/git/notetaker";
const SITE = "/home/o/git/site";
const DOCS = "/home/o/docs";
const FACTS: AgentFolderFacts = {
  browse: true, host: "homebase-server", sep: "/", roots: [{ label: "Home", path: "/home/o" }],
  approved: [
    { path: SANDBOX, label: "sandbox", access: "write", source: "sandbox" },
    { path: BRAIN, label: "notetaker", access: "write", source: "app" },
    { path: SITE, label: "site", access: "write", source: "config" },
    { path: DOCS, label: "docs", access: "read", source: "app" },
  ],
};
const WORKSPACES = [{ label: "sandbox", cwd: SANDBOX }, { label: "notetaker", cwd: BRAIN }, { label: "site", cwd: SITE }];
/** What an upgraded connector registers for the Claude agent. */
const CLAUDE = {
  key: "claude", name: "Claude agent", kind: "claude" as const, modes: ["manual", "auto", "plan"] as Array<"manual" | "auto" | "plan">,
  workspaces: WORKSPACES, folders: FACTS, models: ["claude-sonnet-5-5", "claude-haiku-5-5"], efforts: [...EFFORTS], model: "claude-sonnet-5-5", effort: null,
};
/** The same agent as a connector from before folders registers it. */
const OLD_CLAUDE = { ...CLAUDE, folders: undefined, workspaces: [{ label: "sandbox", cwd: SANDBOX }] };
const SCRIPTED = { key: "dev", name: "Dev agent", kind: "mock" as const, workspaces: [{ label: "repo", cwd: "/srv/repos/site" }] };
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const dev = (p: { id: string; canApprove?: boolean }) => ({ id: p.id, canApprove: p.canApprove ?? true });

function setup(agents: any[] = [CLAUDE, SCRIPTED]) {
  const ctx = makeHub();
  const { hub, directory, store, clock } = ctx;
  const device = connectDevice(hub, directory);
  const con = connectConnector(hub, directory, agents);
  const idOf = (key: string) => store.get<{ id: string }>("SELECT id FROM agents WHERE key = ? AND connector_id IS NOT NULL", key)!.id;
  const agentId = idOf("claude");
  const run = (name: string, args: unknown, as = dev(device)) => hub.mutate(as, mid(), name, args);
  const ok = (name: string, args: unknown) => {
    const ack = run(name, args);
    if (!ack.ok) throw new Error(`${name} failed: ${JSON.stringify((ack as any).error)}`);
    return ack;
  };
  const err = (name: string, args: unknown, as = dev(device)) => (run(name, args, as) as any).error as { code: string; message: string } | undefined;
  const agent = (id = agentId) => readEntity<Agent>(store, "agents", id)!;
  const thread = (id: string) => readEntity<Thread>(store, "threads", id)!;
  const project = (id: string) => readEntity<Project>(store, "projects", id)!;
  const runRow = (id: string) => readEntity<Run>(store, "runs", id)!;
  const newThread = (over: Record<string, unknown> = {}) => {
    const threadId = newId("thr");
    ok("thread.create", { threadId, title: "Session", agentId, ...over });
    return threadId;
  };
  const newProject = (over: Record<string, unknown> = {}) => {
    const projectId = newId("prj");
    ok("project.create", { projectId, name: "Notetaker", defaultAgentId: agentId, ...over });
    return projectId;
  };
  const starts = () => con.of("cmd").filter((c) => c.name === "run.start").map((c) => c.run);
  const say = (threadId: string, text: string) => {
    clock.now += 1000;
    ok("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    return starts().at(-1)!;
  };
  let idx = 0;
  const finish = (runId: string, session: string, reply = "Done.") => {
    hub.onFrame(con, { t: "run.status", runId, status: "running", sessionRef: session, at: clock.now });
    hub.onFrame(con, { t: "run.event", runId, idx: idx++, at: clock.now, kind: "text", data: { text: reply } });
    hub.onFrame(con, { t: "run.status", runId, status: "succeeded", at: clock.now });
  };
  const messages = (threadId: string) =>
    store.all<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id", threadId).map((r) => readEntity<Message>(store, "messages", r.id)!);
  const markers = (threadId: string) => messages(threadId).filter((m) => m.card?.type === "session_marker");
  const audit = (action: string) => store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = ? ORDER BY at, id", action).map((a) => JSON.parse(a.detail));
  return { ...ctx, device, con, agentId, idOf, run, ok, err, agent, thread, project, runRow, newThread, newProject, starts, say, finish, messages, markers, audit };
}

describe("what a connector reports about folders", () => {
  it("keeps the approved list on the agent; a scripted agent and an older connector have none", () => {
    const s = setup();
    expect(s.agent()).toMatchObject({ folders: FACTS, defaultCwd: null, defaultFolders: null, workspaces: WORKSPACES });
    expect(s.agent(s.idOf("dev"))).toMatchObject({ folders: null, defaultCwd: null, defaultFolders: null });
    assertValid("agents", s.agent());
    assertValid("agents", s.agent(s.idOf("dev")));
    expect(setup([OLD_CLAUDE]).agent().folders).toBeNull();
  });

  it("the owner's default folders survive a connector restart; the approved list is always the connector's latest word", () => {
    const s = setup();
    s.ok("folders.set", { scope: "agent", id: s.agentId, cwd: BRAIN, folders: [{ path: DOCS, access: "read" }] });
    const fewer = { ...CLAUDE, folders: { ...FACTS, approved: FACTS.approved.slice(0, 2) }, workspaces: WORKSPACES.slice(0, 2) };
    s.hub.onFrame(s.con, { t: "register", host: { name: "test-connector", os: "test" }, agents: [fewer, SCRIPTED].map((a) => ({ description: "", capabilities: [], ...a })) as any });
    expect(s.agent().folders!.approved).toHaveLength(2);
    expect(s.agent()).toMatchObject({ defaultCwd: BRAIN, defaultFolders: [{ path: DOCS, access: "read" }] });
    // docs is no longer approved there, so a run simply is not given it; the owner's choice is kept for when it is back.
    const start = s.say(s.newThread(), "hello");
    expect(start.cwd).toBe(BRAIN);
    expect(start.options.folders).toBeUndefined();
  });
});

describe("folders.set: who may choose, and what is accepted", () => {
  it("needs a device that may approve, at every level", () => {
    const s = setup();
    const weak = { id: s.device.id, canApprove: false };
    const t = s.newThread();
    const p = s.newProject();
    for (const args of [{ scope: "agent", id: s.agentId, cwd: BRAIN }, { scope: "project", id: p, cwd: BRAIN }, { scope: "thread", id: t, folders: [{ path: DOCS, access: "read" }] }]) {
      expect(s.err("folders.set", args, weak)).toMatchObject({ code: "forbidden" });
    }
    expect(s.err("thread.create", { threadId: newId("thr"), title: "x", agentId: s.agentId, cwd: BRAIN }, weak)).toMatchObject({ code: "forbidden" });
    // Without a folder, creating a session needs nothing special.
    expect(s.run("thread.create", { threadId: newId("thr"), title: "x", agentId: s.agentId }, weak).ok).toBe(true);
    expect(s.agent().defaultCwd).toBeNull();
  });

  it("refuses a folder the agent's connector has not approved, as primary or as extra", () => {
    const s = setup();
    const t = s.newThread();
    expect(s.err("folders.set", { scope: "thread", id: t, cwd: "/etc" })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("has not approved /etc") });
    expect(s.err("folders.set", { scope: "thread", id: t, folders: [{ path: "/home/o/.ssh", access: "read" }] })).toMatchObject({ code: "invalid_args" });
    expect(s.err("folders.set", { scope: "agent", id: s.agentId, cwd: "/home/o" })).toMatchObject({ code: "invalid_args" });
    expect(s.err("thread.create", { threadId: newId("thr"), title: "x", agentId: s.agentId, cwd: "/etc" })).toMatchObject({ code: "invalid_args" });
    expect(s.thread(t)).toMatchObject({ cwd: null, folders: null });
  });

  it("a folder approved read-only cannot be a primary folder or a read & write extra", () => {
    const s = setup();
    const t = s.newThread();
    expect(s.err("folders.set", { scope: "thread", id: t, cwd: DOCS })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("approved read-only") });
    expect(s.err("folders.set", { scope: "thread", id: t, folders: [{ path: DOCS, access: "write" }] })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("approved read-only") });
    s.ok("folders.set", { scope: "thread", id: t, folders: [{ path: DOCS, access: "read" }] });
    expect(s.thread(t).folders).toEqual([{ path: DOCS, access: "read" }]);
  });

  it("a scripted agent takes no folders", () => {
    const s = setup();
    expect(s.err("folders.set", { scope: "agent", id: s.idOf("dev"), folders: [{ path: DOCS, access: "read" }] })).toMatchObject({ code: "invalid_args", message: "Dev agent does not take folders" });
  });

  it("a project folder needs a default agent, and its extras must be approved for that agent", () => {
    const s = setup();
    const bare = newId("prj");
    s.ok("project.create", { projectId: bare, name: "No agent" });
    expect(s.err("folders.set", { scope: "project", id: bare, cwd: BRAIN })).toMatchObject({ code: "invalid_args", message: expect.stringContaining("needs a default agent") });
    // With no default agent, an extra folder is accepted when some connector has it approved.
    s.ok("folders.set", { scope: "project", id: bare, folders: [{ path: DOCS, access: "read" }] });
    expect(s.project(bare).folders).toEqual([{ path: DOCS, access: "read" }]);

    const p = s.newProject();
    s.ok("folders.set", { scope: "project", id: p, cwd: BRAIN, folders: [{ path: DOCS, access: "read" }, { path: BRAIN, access: "read" }, { path: SITE, access: "write" }] });
    // The primary folder is not listed again among the extras.
    expect(s.project(p)).toMatchObject({ defaultCwd: BRAIN, folders: [{ path: DOCS, access: "read" }, { path: SITE, access: "write" }] });
    assertValid("projects", s.project(p));
    expect(s.audit("folders.set").at(-1)).toMatchObject({ scope: "project", cwd: BRAIN, agentId: s.agentId });
    s.ok("folders.set", { scope: "project", id: p, folders: [] });
    expect(s.project(p)).toMatchObject({ defaultCwd: BRAIN, folders: null });
  });
});

describe("what a run is given", () => {
  it("nothing set: the sandbox and no extra folders, exactly as before folders existed", () => {
    const s = setup();
    const t = s.newThread();
    const start = s.say(t, "hello");
    expect(start.cwd).toBe(SANDBOX);
    expect("folders" in start.options).toBe(false);
    expect(s.runRow(start.id)).toMatchObject({ cwd: SANDBOX, folders: null });
    assertValid("runs", s.runRow(start.id));
    expect(s.markers(t)).toHaveLength(0);
  });

  it("a session in a project inherits the project's primary folder and its extra folders", () => {
    const s = setup();
    const p = s.newProject();
    s.ok("folders.set", { scope: "project", id: p, cwd: BRAIN, folders: [{ path: DOCS, access: "read" }] });
    const t = s.newThread({ projectId: p });
    expect(s.thread(t).cwd).toBeNull(); // not started yet: it follows the project
    const start = s.say(t, "what is in here?");
    expect(start).toMatchObject({ cwd: BRAIN, resumeSessionRef: null });
    expect(start.options.folders).toEqual([{ path: DOCS, access: "read" }]);
    expect(s.runRow(start.id).folders).toEqual([{ path: DOCS, access: "read" }]);
    // From its first run on the session remembers where it works.
    expect(s.thread(t).cwd).toBe(BRAIN);
    assertValid("threads", s.thread(t));
    expect(s.audit("run.start").at(-1)).toMatchObject({ cwd: BRAIN, folders: [{ path: DOCS, access: "read" }] });
  });

  it("adds the agent's default folders, the project's and the session's own; the session's access wins", () => {
    const s = setup();
    s.ok("folders.set", { scope: "agent", id: s.agentId, folders: [{ path: DOCS, access: "read" }] });
    const p = s.newProject();
    s.ok("folders.set", { scope: "project", id: p, cwd: BRAIN, folders: [{ path: SITE, access: "write" }] });
    const t = s.newThread({ projectId: p, folders: [{ path: SITE, access: "read" }] });
    const start = s.say(t, "go");
    expect(start.options.folders).toEqual([{ path: DOCS, access: "read" }, { path: SITE, access: "read" }]);
  });

  it("a folder picked in the New session sheet beats the project's, and a session outside a project can have one too", () => {
    const s = setup();
    const p = s.newProject({ defaultCwd: BRAIN });
    const inProject = s.newThread({ projectId: p, cwd: SITE });
    expect(s.say(inProject, "go").cwd).toBe(SITE);
    const unsorted = s.newThread({ cwd: BRAIN, folders: [{ path: DOCS, access: "read" }] });
    const start = s.say(unsorted, "go");
    expect(start.cwd).toBe(BRAIN);
    expect(start.options.folders).toEqual([{ path: DOCS, access: "read" }]);
  });

  it("the agent's default folder is where its sessions start when neither session nor project says", () => {
    const s = setup();
    s.ok("folders.set", { scope: "agent", id: s.agentId, cwd: SITE });
    expect(s.say(s.newThread(), "go").cwd).toBe(SITE);
    expect(s.say(s.newThread({ projectId: s.newProject({ defaultCwd: BRAIN }) }), "go").cwd).toBe(BRAIN);
    expect(s.audit("folders.set").at(-1)).toMatchObject({ scope: "agent", cwd: SITE });
  });

  it("a device cannot slip folders into a run through run.start options", () => {
    const s = setup();
    const runId = newId("run");
    s.ok("run.start", { runId, agentId: s.agentId, prompt: "x", options: { folders: [{ path: "/etc", access: "write" }] } });
    expect("folders" in s.starts().at(-1)!.options).toBe(false);
  });

  it("an older connector that reports no folders is sent none", () => {
    const s = setup([OLD_CLAUDE]);
    const p = s.newProject();
    const start = s.say(s.newThread({ projectId: p }), "go");
    expect(start.cwd).toBe(SANDBOX);
    expect("folders" in start.options).toBe(false);
  });
});

describe("cwd and resume rules", () => {
  it("a session resumes in the folder it started in, whatever its project changes to and wherever it is moved", () => {
    const s = setup();
    const p = s.newProject({ defaultCwd: BRAIN });
    const t = s.newThread({ projectId: p });
    const first = s.say(t, "start");
    s.finish(first.id, S1);
    s.ok("folders.set", { scope: "project", id: p, cwd: SITE });
    s.ok("thread.update", { threadId: t, projectId: null });
    const second = s.say(t, "continue");
    expect(second).toMatchObject({ cwd: BRAIN, resumeSessionRef: S1 });
    // A new session in the project does start in the new folder.
    expect(s.say(s.newThread({ projectId: p }), "new").cwd).toBe(SITE);
  });

  it("before its first message a session's folder can simply be changed", () => {
    const s = setup();
    const t = s.newThread();
    s.ok("folders.set", { scope: "thread", id: t, cwd: BRAIN });
    s.ok("folders.set", { scope: "thread", id: t, cwd: SITE });
    expect(s.thread(t)).toMatchObject({ cwd: SITE, sessionResetAt: null });
    expect(s.say(t, "go")).toMatchObject({ cwd: SITE, resumeSessionRef: null });
    expect(s.markers(t)).toHaveLength(0);
  });

  it("once it has a conversation, a new primary folder is refused unless it is a fresh agent session", () => {
    const s = setup();
    const t = s.newThread();
    s.finish(s.say(t, "start").id, S1);
    expect(s.err("folders.set", { scope: "thread", id: t, cwd: BRAIN })).toMatchObject({ code: "conflict", message: expect.stringContaining("resumes only in the folder it started in") });
    expect(s.thread(t)).toMatchObject({ cwd: SANDBOX, sessionResetAt: null });
    // Unchanged: the next message still resumes where it was.
    expect(s.say(t, "still here")).toMatchObject({ cwd: SANDBOX, resumeSessionRef: S1 });
  });

  it("start fresh in the new folder: a new agent session there, and the conversation says so", () => {
    const s = setup();
    const t = s.newThread();
    s.finish(s.say(t, "start").id, S1);
    s.clock.now += 5000;
    s.ok("folders.set", { scope: "thread", id: t, cwd: BRAIN, fresh: true });
    expect(s.thread(t)).toMatchObject({ cwd: BRAIN, sessionResetAt: s.clock.now });
    const next = s.say(t, "now in notetaker");
    expect(next).toMatchObject({ cwd: BRAIN, resumeSessionRef: null });
    const marker = s.markers(t).at(-1)!;
    expect(marker.text).toBe("New agent session in notetaker, on Sonnet 5.5 · Default effort. The agent does not see the messages above.");
    expect(marker.card).toMatchObject({ type: "session_marker", kind: "fresh", cwd: BRAIN });
    assertValid("messages", marker);
    // The messages are all still there, and the new agent session is the one that resumes from now on.
    expect(s.messages(t).filter((m) => m.role === "user").map((m) => m.text)).toEqual(["start", "now in notetaker"]);
    s.finish(next.id, S2);
    expect(s.say(t, "again")).toMatchObject({ cwd: BRAIN, resumeSessionRef: S2 });
    expect(s.audit("folders.set").at(-1)).toMatchObject({ scope: "thread", cwd: BRAIN, fresh: true });
  });

  it("is refused while the agent is working, and a fresh session from the model picker stays in its folder", () => {
    const s = setup();
    const t = s.newThread({ cwd: BRAIN });
    const first = s.say(t, "start");
    s.finish(first.id, S1);
    const live = s.say(t, "long task");
    s.hub.onFrame(s.con, { t: "run.status", runId: live.id, status: "running", sessionRef: S1, at: s.clock.now });
    expect(s.err("folders.set", { scope: "thread", id: t, cwd: SITE, fresh: true })).toMatchObject({ code: "conflict", message: expect.stringContaining("still working") });
    s.hub.onFrame(s.con, { t: "run.status", runId: live.id, status: "succeeded", at: s.clock.now });
    s.clock.now += 1000;
    s.ok("model.set", { scope: "thread", id: t, model: "claude-haiku-5-5", fresh: true });
    expect(s.say(t, "fresh, same place")).toMatchObject({ cwd: BRAIN, resumeSessionRef: null });
  });

  it("a session whose runs never got an agent session can still change folder", () => {
    const s = setup();
    const t = s.newThread({ cwd: BRAIN });
    const first = s.say(t, "start");
    s.hub.onFrame(s.con, { t: "run.status", runId: first.id, status: "failed", error: `"${BRAIN}" is not one of this connector's allowed working directories.`, at: s.clock.now });
    s.ok("folders.set", { scope: "thread", id: t, cwd: SITE });
    expect(s.say(t, "try again")).toMatchObject({ cwd: SITE, resumeSessionRef: null });
  });
});

describe("adding a folder in the middle of a session", () => {
  it("takes effect on the next run, keeps the conversation, and leaves a line where it happened", () => {
    const s = setup();
    const t = s.newThread({ cwd: BRAIN });
    s.finish(s.say(t, "start").id, S1);
    s.ok("folders.set", { scope: "thread", id: t, folders: [{ path: DOCS, access: "read" }] });
    expect(s.thread(t)).toMatchObject({ cwd: BRAIN, folders: [{ path: DOCS, access: "read" }], sessionResetAt: null });
    const next = s.say(t, "use the docs");
    expect(next).toMatchObject({ cwd: BRAIN, resumeSessionRef: S1 });
    expect(next.options.folders).toEqual([{ path: DOCS, access: "read" }]);
    expect(s.markers(t).map((m) => [m.card?.type === "session_marker" && m.card.kind, m.text])).toEqual([["folders", "Folders for the agent from here on: added docs (read-only)."]]);
    s.finish(next.id, S1);
    // Nothing changed since: no second line.
    s.say(t, "more");
    expect(s.markers(t)).toHaveLength(1);
  });

  it("a folder added to the project reaches its running sessions at their next message too", () => {
    const s = setup();
    const p = s.newProject({ defaultCwd: BRAIN });
    const t = s.newThread({ projectId: p });
    s.finish(s.say(t, "start").id, S1);
    s.ok("folders.set", { scope: "project", id: p, folders: [{ path: SITE, access: "write" }] });
    const next = s.say(t, "go on");
    expect(next.options.folders).toEqual([{ path: SITE, access: "write" }]);
    expect(s.markers(t).at(-1)!.text).toBe("Folders for the agent from here on: added site (read & write).");
    s.finish(next.id, S1);
    s.ok("folders.set", { scope: "project", id: p, folders: [] });
    s.say(t, "without it");
    expect(s.markers(t).at(-1)!.text).toBe("Folders for the agent from here on: removed site.");
  });
});

describe("the folder browser relay", () => {
  const ask = (s: ReturnType<typeof setup>, p: ReturnType<typeof peer>, op: string, args: Record<string, unknown> = {}, id = "f1") =>
    s.hub.onFrame(p, { t: "folders.req", id, agentId: s.agentId, op: op as any, args });

  it("relays a request to the agent's connector and the answer back to the device that asked", () => {
    const s = setup();
    ask(s, s.device, "list", { path: "/home/o/git" });
    const req = s.con.of("folders.request").at(-1);
    expect(req).toMatchObject({ agentKey: "claude", op: "list", args: { path: "/home/o/git" }, deviceId: s.device.id, canApprove: true });
    s.hub.onFrame(s.con, { t: "folders.response", id: req.id, ok: true, result: { entries: [{ name: "notetaker" }] } });
    expect(s.device.of("folders.res").at(-1)).toEqual({ t: "folders.res", id: "f1", ok: true, result: { entries: [{ name: "notetaker" }] } });
    // Browsing is not an allowlist change: nothing is audited, and nothing is stored.
    expect(s.audit("folder.approve")).toHaveLength(0);
  });

  it("only a device that may approve can approve or forget a folder, and each one is audited", () => {
    const s = setup();
    const d = pairDevice(s.directory);
    const weak = peer(d.deviceId, "device", false);
    s.hub.attachDevice(weak, {});
    ask(s, weak, "approve", { path: "/home/o/git/new", access: "write" }, "w1");
    expect(weak.of("folders.res").at(-1)).toMatchObject({ id: "w1", ok: false, error: { code: "forbidden" } });
    expect(s.con.of("folders.request")).toHaveLength(0);
    // It may still look around.
    ask(s, weak, "roots", {}, "w2");
    expect(s.con.of("folders.request").at(-1)).toMatchObject({ op: "roots", canApprove: false });

    ask(s, s.device, "approve", { path: "/home/o/git/new", access: "write" }, "a1");
    const req = s.con.of("folders.request").at(-1);
    s.hub.onFrame(s.con, { t: "folders.response", id: req.id, ok: true, result: { path: "/home/o/git/new", label: "new", access: "write", source: "app" } });
    expect(s.device.of("folders.res").at(-1)).toMatchObject({ id: "a1", ok: true });
    expect(s.audit("folder.approve")).toEqual([{ agentId: s.agentId, connectorId: s.con.id, path: "/home/o/git/new", access: "write", label: "new" }]);
  });

  it("passes the connector's refusal on, and fails cleanly when the connector is offline, old, or the agent takes no folders", () => {
    const s = setup();
    ask(s, s.device, "approve", { path: "/home/o", access: "write" });
    const req = s.con.of("folders.request").at(-1);
    s.hub.onFrame(s.con, { t: "folders.response", id: req.id, ok: false, error: "Your whole home folder cannot be added.", code: "blocked" });
    expect(s.device.of("folders.res").at(-1)).toMatchObject({ ok: false, error: { code: "blocked", message: "Your whole home folder cannot be added." } });
    expect(s.audit("folder.approve")).toHaveLength(0);

    s.hub.onFrame(s.device, { t: "folders.req", id: "f2", agentId: s.idOf("dev"), op: "roots", args: {} });
    expect(s.device.of("folders.res").at(-1)).toMatchObject({ id: "f2", ok: false, error: { code: "unsupported" } });

    ask(s, s.device, "list", {}, "f3");
    s.hub.detach(s.con);
    expect(s.device.of("folders.res").at(-1)).toMatchObject({ id: "f3", ok: false, error: { code: "offline" } });
    ask(s, s.device, "list", {}, "f4");
    expect(s.device.of("folders.res").at(-1)).toMatchObject({ id: "f4", ok: false, error: { code: "offline" } });
  });

  it("ignores an answer from a connector that was not asked", () => {
    const s = setup();
    ask(s, s.device, "list");
    const req = s.con.of("folders.request").at(-1);
    const c2 = pairDevice(s.directory, "connector", "other-connector");
    const stranger = peer(c2.deviceId, "connector", false);
    s.hub.attachConnector(stranger);
    s.hub.onFrame(stranger, { t: "folders.response", id: req.id, ok: true, result: { entries: [{ name: "planted" }] } });
    expect(s.device.of("folders.res")).toHaveLength(0);
  });
});

describe("upgrading a database from before folders", () => {
  const dirs: string[] = [];
  const stores: SqlStore[] = [];
  afterEach(() => {
    for (const st of stores.splice(0)) st.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("gains the columns, keeps every row, writes down where each old session works, and old sessions run as they did", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-folders-"));
    dirs.push(dir);
    const path = join(dir, "homebase.db");
    // Agents, projects, threads and runs exactly as the hub created them on 2026-11-22, before round 6.
    const old = new NodeSqlStore(path);
    old.exec(`CREATE TABLE agents (
      id TEXT PRIMARY KEY, connector_id TEXT, key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]', workspaces TEXT NOT NULL DEFAULT '[]', permission_profile TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL, updated_at INTEGER NOT NULL, status_note TEXT, modes TEXT, default_mode TEXT, auth TEXT, gmail TEXT, vault TEXT,
      models TEXT, efforts TEXT, config_model TEXT, config_effort TEXT, default_model TEXT, default_effort TEXT, images TEXT);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT, last_message_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, mode TEXT,
      project_id TEXT, note TEXT, summary TEXT, recap TEXT, recap_at INTEGER, recap_run_id TEXT, last_run_status TEXT, last_agent_at INTEGER, read_at INTEGER,
      model TEXT, effort TEXT, session_reset_at INTEGER, image_route TEXT);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_agent_id TEXT, default_cwd TEXT, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, image_route TEXT);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, thread_id TEXT, prompt TEXT NOT NULL, status TEXT NOT NULL, session_ref TEXT,
      summary TEXT, error TEXT, cost_usd REAL, num_turns INTEGER, duration_ms INTEGER, last_event_idx INTEGER NOT NULL DEFAULT -1,
      started_by TEXT, cwd TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL, mode TEXT,
      model TEXT, effort TEXT);`);
    old.run(`INSERT INTO agents (id, connector_id, key, name, kind, status, updated_at, workspaces) VALUES ('agt_c', NULL, 'claude', 'Claude agent', 'claude', 'offline', 1, '[{"label":"sandbox","cwd":"${SANDBOX}"},{"label":"notetaker","cwd":"${BRAIN}"}]')`);
    old.run(`INSERT INTO projects (id, name, default_agent_id, default_cwd, created_at, updated_at) VALUES ('prj_b', 'Notetaker', 'agt_c', '${BRAIN}', 1, 1)`);
    old.run("INSERT INTO threads (id, title, agent_id, project_id, last_message_at, created_at, updated_at, last_run_status) VALUES ('thr_a', 'In the project', 'agt_c', 'prj_b', 2000, 1000, 2000, 'succeeded')");
    old.run("INSERT INTO threads (id, title, agent_id, last_message_at, created_at, updated_at) VALUES ('thr_b', 'Never ran', 'agt_c', NULL, 1000, 1000)");
    old.run("INSERT INTO threads (id, title, agent_id, last_message_at, created_at, updated_at, last_run_status) VALUES ('thr_c', 'Moved by hand', 'agt_c', 3000, 1000, 3000, 'failed')");
    old.run(`INSERT INTO runs (id, agent_id, thread_id, prompt, status, session_ref, cwd, created_at, updated_at) VALUES ('run_1', 'agt_c', 'thr_a', 'p', 'succeeded', '${S1}', '${BRAIN}', 1500, 2000)`);
    // A session whose newest run failed before it got an agent session: it still belongs where its conversation is.
    old.run(`INSERT INTO runs (id, agent_id, thread_id, prompt, status, session_ref, cwd, created_at, updated_at) VALUES ('run_2', 'agt_c', 'thr_c', 'p', 'succeeded', '${S2}', '${SANDBOX}', 1500, 2000)`);
    old.run(`INSERT INTO runs (id, agent_id, thread_id, prompt, status, session_ref, cwd, created_at, updated_at) VALUES ('run_3', 'agt_c', 'thr_c', 'p', 'failed', NULL, '${BRAIN}', 2500, 3000)`);
    old.close();

    const store = openStore(path);
    stores.push(store);
    const cols = (t: string) => store.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols("agents")).toEqual(expect.arrayContaining(["folders", "default_cwd", "default_folders"]));
    expect(cols("threads")).toEqual(expect.arrayContaining(["cwd", "folders"]));
    expect(cols("projects")).toEqual(expect.arrayContaining(["folders"]));
    expect(cols("runs")).toEqual(expect.arrayContaining(["folders"]));
    const count = (t: string) => store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
    expect([count("agents"), count("projects"), count("threads"), count("runs")]).toEqual([1, 1, 3, 3]);
    expect(readEntity<Project>(store, "projects", "prj_b")).toMatchObject({ name: "Notetaker", defaultCwd: BRAIN, folders: null });
    expect(readEntity<Agent>(store, "agents", "agt_c")).toMatchObject({ folders: null, defaultCwd: null, defaultFolders: null });
    expect(readEntity<Thread>(store, "threads", "thr_a")).toMatchObject({ cwd: null, folders: null });
    for (const [e, id] of [["agents", "agt_c"], ["projects", "prj_b"], ["threads", "thr_a"], ["runs", "run_1"]] as const) {
      expect(ENTITY_SCHEMAS[e].safeParse(readEntity(store, e, id)).success, e).toBe(true);
    }

    // The upgraded hub starts: each old session gets the folder it already works in written down. Nothing else moves.
    let now = 10_000;
    const hub = new WorkspaceHub(store, { quiet: true, now: () => now });
    seed(hub, { demo: false });
    hub.start(3_600_000);
    expect(readEntity<Thread>(store, "threads", "thr_a")).toMatchObject({ cwd: BRAIN, folders: null, title: "In the project", lastRunStatus: "succeeded" });
    expect(readEntity<Thread>(store, "threads", "thr_b")).toMatchObject({ cwd: null });
    expect(readEntity<Thread>(store, "threads", "thr_c")).toMatchObject({ cwd: SANDBOX });
    expect([count("agents"), count("projects"), count("threads"), count("runs")]).toEqual([1, 1, 3, 3]);
    const seqAfterFirst = hub.currentSeq();
    hub.stop();
    hub.start(3_600_000); // a second start finds nothing to do
    expect(hub.currentSeq()).toBe(seqAfterFirst);

    // With the upgraded connector registered, the old session resumes where it was, with no folders and no marker.
    const directory = new Directory(store, hub.now);
    const device = connectDevice(hub, directory);
    const con = connectConnector(hub, directory, [CLAUDE] as any);
    now += 1000;
    expect(hub.mutate(dev(device), mid(), "message.send", { threadId: "thr_a", messageId: newId("msg"), text: "where were we?", source: "text" }).ok).toBe(true);
    const start = con.of("cmd").filter((c) => c.name === "run.start").at(-1).run;
    expect(start).toMatchObject({ resumeSessionRef: S1, cwd: BRAIN });
    expect("folders" in start.options).toBe(false);
    expect(store.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE card IS NOT NULL")!.n).toBe(0);
    // The never-run session follows its level above when it starts: no project, so the sandbox.
    now += 1000;
    expect(hub.mutate(dev(device), mid(), "message.send", { threadId: "thr_b", messageId: newId("msg"), text: "first words", source: "text" }).ok).toBe(true);
    expect(con.of("cmd").filter((c) => c.name === "run.start").at(-1).run).toMatchObject({ resumeSessionRef: null, cwd: SANDBOX });
    hub.stop();
  });
});
