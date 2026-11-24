import { describe, expect, it } from "vitest";
import {
  ENTITY_SCHEMAS, UNSORTED, buildSessionRows, digestText, excerpt, filterSessions, isDefaultTitle, leftOff, projectAgents, projectStats, recapIsStale,
  searchSessions, sessionStatus, sortProjects, sortSessions, titleFromMessage,
  type Agent, type Approval, type Message, type Project, type Run, type Thread,
} from "../src";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22, 15);

const agent = (id: string, name: string): Agent => ({
  id, connectorId: "con_1", key: id, name, kind: "claude", description: "", capabilities: [], workspaces: [], permissionProfile: "standard", status: "online", updatedAt: NOW,
});
const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  id, name, description: null, defaultAgentId: null, defaultCwd: null, pinned: false, archived: false, createdAt: NOW - 30 * DAY, updatedAt: NOW, ...extra,
});
const thread = (id: string, title: string, daysAgo: number, extra: Partial<Thread> = {}): Thread => ({
  id, title, agentId: "agt_claude", lastMessageAt: NOW - daysAgo * DAY, pinned: false, archived: false, createdBy: null, createdAt: NOW - (daysAgo + 1) * DAY,
  updatedAt: NOW - daysAgo * DAY, ...extra,
});
const msg = (id: string, threadId: string, role: Message["role"], text: string, daysAgo: number): Message => ({
  id, threadId, role, text, source: role === "user" ? "text" : "agent", runId: null, authorDeviceId: null, createdAt: NOW - daysAgo * DAY,
});
const run = (id: string, threadId: string, status: Run["status"], daysAgo: number): Run => ({
  id, agentId: "agt_claude", threadId, prompt: "p", status, sessionRef: null, summary: null, error: null, costUsd: null, numTurns: null, durationMs: null,
  lastEventIdx: -1, startedBy: null, cwd: null, createdAt: NOW - daysAgo * DAY, startedAt: null, endedAt: null, updatedAt: NOW,
});

const agents = { agt_claude: agent("agt_claude", "Claude agent"), agt_comms: agent("agt_comms", "Comms agent") };
const projects = { prj_brain: project("prj_brain", "Notetaker", { pinned: true }), prj_salt: project("prj_salt", "Northwind Supply") };
const threads: Thread[] = [
  thread("thr_1", "Fix the sync cursor on upgrade", 8, { projectId: "prj_brain", summary: "Shipped the cursor fix; the emulator test is still red.", lastRunStatus: "succeeded" }),
  thread("thr_2", "Checkout tax bug", 2, { projectId: "prj_salt", note: "Blocked on the staging tunnel. Ask Renee for VPN access.", lastRunStatus: "failed" }),
  thread("thr_3", "New session with Claude agent", 0.1, { lastRunStatus: "waiting_approval" }),
  thread("thr_4", "Weekly digest email", 20, { agentId: "agt_comms", recap: "**Doing:** the weekly digest.\n**Next:** approve the draft.", recapAt: NOW - 20 * DAY, lastRunStatus: "succeeded" }),
  thread("thr_5", "Old experiment", 60, { projectId: "prj_brain", archived: true }),
  thread("thr_6", "Release checklist", 1, { projectId: "prj_brain", pinned: true, lastRunStatus: "running" }),
];
const messages: Message[] = [
  msg("m1", "thr_1", "user", "The cursor key should include the entity list.", 9),
  msg("m2", "thr_1", "assistant", "Done. I also found a :critical[race in hydrate()] that drops the outbox.", 8),
  msg("m3", "thr_3", "user", "Rotate the Resend webhook secret for Notetaker.", 0.1),
  msg("m4", "thr_6", "assistant", "Tagged v1.4.0 and pushed.", 1),
];
const rows = () => buildSessionRows({ threads, projects, agents, messages });
const ids = (list: Array<{ thread: Thread }>) => list.map((r) => r.thread.id);

describe("schemas", () => {
  it("a thread from before session organisation is still a valid thread, and so is one with every new field", () => {
    const old = { id: "thr_x", title: "t", agentId: null, lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 1 };
    expect(ENTITY_SCHEMAS.threads.safeParse(old).success).toBe(true);
    expect(ENTITY_SCHEMAS.threads.safeParse({ ...old, projectId: null, note: null, summary: null, recap: null, recapAt: null, recapRunId: null, lastRunStatus: null }).success).toBe(true);
    for (const t of threads) expect(ENTITY_SCHEMAS.threads.safeParse(t).success).toBe(true);
    expect(ENTITY_SCHEMAS.threads.safeParse({ ...old, lastRunStatus: "exploded" }).success).toBe(false);
  });

  it("a project needs a name", () => {
    expect(ENTITY_SCHEMAS.projects.safeParse(projects.prj_brain).success).toBe(true);
    expect(ENTITY_SCHEMAS.projects.safeParse({ ...projects.prj_brain, name: "" }).success).toBe(false);
  });
});

describe("titles and digests", () => {
  it("knows a placeholder title from a real one", () => {
    for (const t of ["New chat with Claude agent", "New scratch thread", "New session", "New session with Comms agent", "New session in Notetaker"]) expect(isDefaultTitle(t)).toBe(true);
    for (const t of ["Notes · Thu Nov 19", "Reply: Quote request", "New pricing page", "Renamed offline", "t"]) expect(isDefaultTitle(t)).toBe(false);
  });

  it("names a session after the first thing said in it", () => {
    expect(titleFromMessage("Fix the contact form 500 on harborpine.\n\nIt started Tuesday.")).toBe("Fix the contact form 500 on harborpine");
    expect(titleFromMessage("  \n**Rotate** the `Resend` webhook secret, please.  ")).toBe("Rotate the Resend webhook secret, please");
    const long = titleFromMessage("Investigate why checkout applies sales tax twice on northwindsupply.example and do not change anything yet");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("…")).toBe(true);
    expect(titleFromMessage("   ")).toBe("Untitled session");
  });

  it("digests agent text to one plain line", () => {
    expect(digestText("## Result\n- Found :critical[an SQL injection] in `/login`\n- See [the docs](https://x.test) and [[Clients/Acme|Acme]]\n\n```sh\nrm -rf /\n```"))
      .toBe("Result Found an SQL injection in /login See the docs and Acme");
    const cut = digestText("word ".repeat(200), 50);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith("…")).toBe(true);
    expect(digestText("")).toBe("");
  });
});

describe("status and where a session was left", () => {
  it("maps the newest run's status to what the owner needs to know", () => {
    expect(sessionStatus("waiting_approval")).toBe("waiting");
    expect(sessionStatus("failed")).toBe("failed");
    expect(sessionStatus("offline")).toBe("offline");
    for (const s of ["queued", "starting", "running"] as const) expect(sessionStatus(s)).toBe("running");
    for (const s of ["succeeded", "cancelled", null, undefined] as const) expect(sessionStatus(s)).toBe("idle");
  });

  it("prefers the owner's note, then a fresh recap, then the digest, then an old recap", () => {
    const base = { note: null, recap: null, recapAt: null, summary: null, lastMessageAt: NOW };
    expect(leftOff(base).source).toBe("none");
    expect(leftOff({ ...base, summary: "Last thing said." })).toMatchObject({ source: "summary", text: "Last thing said." });
    const fresh = { ...base, summary: "Last thing said.", recap: "**Doing:** x\n**Next:** y", recapAt: NOW };
    expect(leftOff(fresh)).toMatchObject({ source: "recap", text: "Doing: x Next: y", stale: false });
    // Something was said after the recap: the digest of that is newer than the recap.
    const stale = { ...fresh, lastMessageAt: NOW + 5 * 60_000 };
    expect(recapIsStale(stale)).toBe(true);
    expect(leftOff(stale).source).toBe("summary");
    expect(leftOff({ ...stale, summary: null })).toMatchObject({ source: "recap", stale: true });
    expect(leftOff({ ...stale, note: "  my own words  " })).toMatchObject({ source: "note", text: "my own words" });
  });
});

describe("rows, scope, filter and sort", () => {
  it("builds one row per session with its project, agent, status and left-off line", () => {
    const r = rows();
    expect(r).toHaveLength(6);
    const byId = Object.fromEntries(r.map((x) => [x.thread.id, x]));
    expect(byId.thr_1).toMatchObject({ project: { name: "Notetaker" }, agent: { name: "Claude agent" }, status: "idle", left: { source: "summary" } });
    expect(byId.thr_2).toMatchObject({ status: "failed", left: { source: "note" } });
    expect(byId.thr_3).toMatchObject({ project: null, status: "waiting", last: { role: "user" } });
    expect(byId.thr_4.left).toMatchObject({ source: "recap", stale: false });
  });

  it("a run the device knows is fresher than the stored status, and a pending approval names what is waited on", () => {
    const runs = [run("run_a", "thr_1", "succeeded", 8), run("run_b", "thr_1", "waiting_approval", 0.01)];
    const approvals = [{ id: "apr_1", runId: "run_b", status: "pending", title: "Push to origin" } as Approval];
    const r = buildSessionRows({ threads, projects, agents, messages, runs, approvals }).find((x) => x.thread.id === "thr_1")!;
    expect(r).toMatchObject({ status: "waiting", waitingOn: "Push to origin" });
  });

  it("a session whose project is unknown on this device is shown in Unsorted, never lost", () => {
    const r = buildSessionRows({ threads: [thread("thr_9", "Orphan", 1, { projectId: "prj_gone" })], projects, agents });
    expect(ids(filterSessions(r, { scope: UNSORTED }))).toEqual(["thr_9"]);
    expect(ids(filterSessions(r, { scope: "all" }))).toEqual(["thr_9"]);
  });

  it("narrows by project, Unsorted and filter; archived sessions only show under Archived", () => {
    const r = rows();
    expect(ids(filterSessions(r, {})).sort()).toEqual(["thr_1", "thr_2", "thr_3", "thr_4", "thr_6"]);
    expect(ids(filterSessions(r, { scope: UNSORTED })).sort()).toEqual(["thr_3", "thr_4"]);
    expect(ids(filterSessions(r, { scope: "prj_brain" })).sort()).toEqual(["thr_1", "thr_6"]);
    expect(ids(filterSessions(r, { scope: "prj_brain", filter: "archived" }))).toEqual(["thr_5"]);
    expect(ids(filterSessions(r, { filter: "attention" })).sort()).toEqual(["thr_2", "thr_3"]);
    expect(ids(filterSessions(r, { filter: "running" })).sort()).toEqual(["thr_3", "thr_6"]);
  });

  it("sorts by recent (pinned first), by what needs the owner, oldest first and by title", () => {
    const open = filterSessions(rows(), {});
    expect(ids(sortSessions(open, "recent"))).toEqual(["thr_6", "thr_3", "thr_2", "thr_1", "thr_4"]);
    expect(ids(sortSessions(open, "attention"))).toEqual(["thr_3", "thr_2", "thr_6", "thr_1", "thr_4"]);
    expect(ids(sortSessions(open, "oldest"))).toEqual(["thr_4", "thr_1", "thr_2", "thr_6", "thr_3"]);
    expect(ids(sortSessions(open, "title"))).toEqual(["thr_2", "thr_1", "thr_3", "thr_6", "thr_4"]);
    expect(ids(open)).not.toEqual(ids(sortSessions(open, "oldest"))); // the input is not reordered
  });
});

describe("search", () => {
  const find = (q: string, r = filterSessions(rows(), {})) => searchSessions(r, q, messages);

  it("an empty query returns everything", () => {
    expect(find("   ")).toHaveLength(5);
  });

  it("finds a session by its title, case-insensitively, and shows no snippet when the title says it", () => {
    const hits = find("CHECKOUT");
    expect(ids(hits.map((h) => h.row))).toEqual(["thr_2"]);
    expect(hits[0].hit).toBeNull();
  });

  it("finds by the owner's note, the agent's recap, the last-reply digest, the project and the agent", () => {
    expect(find("tunnel")[0]).toMatchObject({ row: { thread: { id: "thr_2" } }, hit: { field: "note" } });
    expect(find("approve the draft")[0]).toMatchObject({ row: { thread: { id: "thr_4" } }, hit: { field: "recap" } });
    expect(find("emulator")[0]).toMatchObject({ row: { thread: { id: "thr_1" } }, hit: { field: "summary", snippet: "Shipped the cursor fix; the emulator test is still red." } });
    expect(ids(find("notetaker").map((h) => h.row)).sort()).toEqual(["thr_1", "thr_3", "thr_6"]); // two by project, one by a message
    expect(ids(find("comms").map((h) => h.row))).toEqual(["thr_4"]);
    expect(ids(find("unsorted").map((h) => h.row)).sort()).toEqual(["thr_3", "thr_4"]);
  });

  it("finds by what was said, with the words around the match and without the tone markup", () => {
    const [h] = find("hydrate");
    expect(h.row.thread.id).toBe("thr_1");
    expect(h.hit).toMatchObject({ field: "message", role: "assistant", snippet: "Done. I also found a race in hydrate() that drops the outbox." });
    expect(find("webhook secret")[0].hit).toMatchObject({ field: "message", role: "user" });
  });

  it("needs every word, but the words may be in different places", () => {
    expect(ids(find("notetaker cursor").map((h) => h.row))).toEqual(["thr_1"]); // project + title
    expect(ids(find("northwind tunnel renee").map((h) => h.row))).toEqual(["thr_2"]); // project + note
    expect(find("notetaker tunnel")).toHaveLength(0);
    expect(find("zebra")).toHaveLength(0);
  });

  it("ranks a title match above a match deep in the conversation, and newer first on a tie", () => {
    const extra = [...threads, thread("thr_7", "Cursor rules for the repo", 30)];
    const r = filterSessions(buildSessionRows({ threads: extra, projects, agents, messages }), {});
    expect(ids(searchSessions(r, "cursor", messages).map((h) => h.row))).toEqual(["thr_1", "thr_7"]); // both in the title: newer first
    const deep = [...messages, msg("m9", "thr_6", "assistant", "The cursor moved.", 1)];
    expect(ids(searchSessions(r, "cursor", deep).map((h) => h.row))).toEqual(["thr_1", "thr_7", "thr_6"]);
  });

  it("reads the conversation only when no other field has the word, newest message first", () => {
    const many = [msg("a", "thr_6", "user", "deploy to staging", 3), msg("b", "thr_6", "assistant", "deploy finished on staging", 1)];
    const hits = searchSessions(filterSessions(rows(), {}), "staging", many);
    // thr_2 has the word in its note, which outranks a message; thr_6 only said it.
    expect(hits.map((h) => [h.row.thread.id, h.hit?.field])).toEqual([["thr_2", "note"], ["thr_6", "message"]]);
    expect(hits[1].hit).toMatchObject({ snippet: "deploy finished on staging", role: "assistant" });
  });

  it("cuts a long passage around the match", () => {
    const text = `${"lorem ".repeat(30)}needle ${"ipsum ".repeat(30)}`;
    const e = excerpt(text, "needle", 20);
    expect(e.startsWith("…")).toBe(true);
    expect(e.endsWith("…")).toBe(true);
    expect(e).toContain("needle");
    expect(e.length).toBeLessThan(60);
  });
});

describe("projects", () => {
  it("counts a project's sessions, what runs, what needs the owner and the session to continue", () => {
    const r = rows();
    expect(projectStats(r, "prj_brain")).toMatchObject({ sessions: 2, archived: 1, running: 1, attention: 0, latest: { thread: { id: "thr_6" } } });
    expect(projectStats(r, "prj_salt")).toMatchObject({ sessions: 1, attention: 1, running: 0 });
    expect(projectStats(r, UNSORTED)).toMatchObject({ sessions: 2, attention: 1, latest: { thread: { id: "thr_3" } } });
    expect(projectStats(r, "prj_none")).toMatchObject({ sessions: 0, lastAt: null, latest: null });
  });

  it("lists pinned projects first, then by last activity; archived ones only when asked", () => {
    const list = [project("a", "Alpha"), project("b", "Beta", { pinned: true }), project("c", "Gamma", { archived: true }), project("d", "Delta")];
    const last: Record<string, number> = { a: 5, d: 9 };
    expect(sortProjects(list, (p) => last[p.id] ?? null).map((p) => p.id)).toEqual(["b", "d", "a"]);
    expect(sortProjects(list, (p) => last[p.id] ?? null, true).map((p) => p.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("lists a project's agents: the default first, then by how many sessions each has there", () => {
    const p = { ...projects.prj_brain, defaultAgentId: "agt_comms" };
    const team = projectAgents(rows(), p, agents);
    expect(team.map((a) => [a.agent.id, a.sessions, a.isDefault])).toEqual([["agt_comms", 0, true], ["agt_claude", 2, false]]);
    expect(projectAgents(rows(), projects.prj_salt, agents).map((a) => a.agent.id)).toEqual(["agt_claude"]);
  });
});
