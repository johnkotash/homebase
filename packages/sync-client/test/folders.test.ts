import { describe, expect, it } from "vitest";
import type { Agent, AgentFolderFacts, Project, Thread } from "@homebase/protocol";
import { applyOptimistic, emptyMaps } from "../src";

const SANDBOX = "/home/o/data/claude-workspace";
const BRAIN = "/home/o/git/notetaker";
const DOCS = "/home/o/docs";
const facts: AgentFolderFacts = {
  browse: true, host: "homebase-server", sep: "/", roots: [{ label: "Home", path: "/home/o" }],
  approved: [
    { path: SANDBOX, label: "sandbox", access: "write", source: "sandbox" },
    { path: BRAIN, label: "notetaker", access: "write", source: "app" },
    { path: DOCS, label: "docs", access: "read", source: "app" },
  ],
};
const agent = (id: string, folders: AgentFolderFacts | null): Agent => ({
  id, connectorId: "con_1", key: id, name: id, kind: folders ? "claude" : "mock", description: "", capabilities: [], permissionProfile: "strict", status: "online", updatedAt: 1,
  workspaces: folders ? [{ label: "sandbox", cwd: SANDBOX }, { label: "notetaker", cwd: BRAIN }] : [], folders,
});
const thread = (id: string, agentId: string | null, over: Partial<Thread> = {}): Thread => ({
  id, title: "t", agentId, lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 1, ...over,
});
const project = (id: string, defaultAgentId: string | null): Project => ({ id, name: id, description: null, defaultAgentId, defaultCwd: null, pinned: false, archived: false, createdAt: 1, updatedAt: 1 });

function server() {
  const maps = emptyMaps();
  maps.agents = { agt_claude: agent("agt_claude", facts), agt_dev: agent("agt_dev", null) };
  maps.threads = {
    thr_new: thread("thr_new", "agt_claude"), thr_talked: thread("thr_talked", "agt_claude", { cwd: SANDBOX, lastRunStatus: "succeeded" }), thr_dev: thread("thr_dev", "agt_dev"),
  };
  maps.projects = { prj_b: project("prj_b", "agt_claude"), prj_bare: project("prj_bare", null) };
  return maps;
}
const set = (args: unknown, at: number) => ({ id: `m${at}`, name: "folders.set" as const, args, at });

describe("folders.set, predicted on the device", () => {
  it("a project's primary folder and extra folders show at once", () => {
    const s = server();
    const out = applyOptimistic(s, [set({ scope: "project", id: "prj_b", cwd: BRAIN, folders: [{ path: DOCS, access: "read" }, { path: BRAIN, access: "read" }] }, 5)], "dev_1");
    expect(out.projects.prj_b).toMatchObject({ defaultCwd: BRAIN, folders: [{ path: DOCS, access: "read" }], updatedAt: 5 }); // the primary folder is not also an extra
    expect(s.projects.prj_b.defaultCwd).toBeNull(); // hub-confirmed rows are not touched
    // A field that is not sent is left alone.
    const two = applyOptimistic(s, [set({ scope: "project", id: "prj_b", cwd: BRAIN }, 5), set({ scope: "project", id: "prj_b", folders: [{ path: DOCS, access: "read" }] }, 6)], "dev_1");
    expect(two.projects.prj_b).toMatchObject({ defaultCwd: BRAIN, folders: [{ path: DOCS, access: "read" }] });
  });

  it("an agent's default folders and a new session's folder show at once", () => {
    const out = applyOptimistic(server(), [
      set({ scope: "agent", id: "agt_claude", cwd: BRAIN, folders: [{ path: DOCS, access: "read" }] }, 5),
      set({ scope: "thread", id: "thr_new", cwd: BRAIN }, 6),
      { id: "m7", name: "thread.create" as const, at: 7, args: { threadId: "thr_x", title: "New session", agentId: "agt_claude", cwd: BRAIN, folders: [{ path: DOCS, access: "read" }] } },
    ], "dev_1");
    expect(out.agents.agt_claude).toMatchObject({ defaultCwd: BRAIN, defaultFolders: [{ path: DOCS, access: "read" }] });
    expect(out.agents.agt_claude.folders).toEqual(facts); // the connector's list is not the owner's to change
    expect(out.threads.thr_new).toMatchObject({ cwd: BRAIN });
    expect(out.threads.thr_new.sessionResetAt ?? null).toBeNull();
    expect(out.threads.thr_x).toMatchObject({ cwd: BRAIN, folders: [{ path: DOCS, access: "read" }] });
  });

  it("a session with a conversation moves only as a fresh agent session; an extra folder just adds", () => {
    const s = server();
    expect(applyOptimistic(s, [set({ scope: "thread", id: "thr_talked", cwd: BRAIN }, 5)], "dev_1").threads).toEqual(s.threads);
    const fresh = applyOptimistic(s, [set({ scope: "thread", id: "thr_talked", cwd: BRAIN, fresh: true }, 5)], "dev_1");
    expect(fresh.threads.thr_talked).toMatchObject({ cwd: BRAIN, sessionResetAt: 5 });
    const added = applyOptimistic(s, [set({ scope: "thread", id: "thr_talked", folders: [{ path: DOCS, access: "read" }] }, 5)], "dev_1");
    expect(added.threads.thr_talked).toMatchObject({ cwd: SANDBOX, folders: [{ path: DOCS, access: "read" }] });
    expect(added.threads.thr_talked.sessionResetAt ?? null).toBeNull();
  });

  it("shows nothing the hub would refuse: an unapproved folder, a read-only folder to work in or to write, a project folder without an agent", () => {
    const s = server();
    const out = applyOptimistic(s, [
      set({ scope: "thread", id: "thr_new", cwd: "/etc" }, 1),
      set({ scope: "thread", id: "thr_new", cwd: DOCS }, 2),
      set({ scope: "thread", id: "thr_new", folders: [{ path: DOCS, access: "write" }] }, 3),
      set({ scope: "thread", id: "thr_new", folders: [{ path: "/home/o/.ssh", access: "read" }] }, 4),
      set({ scope: "project", id: "prj_bare", cwd: BRAIN }, 5),
      set({ scope: "agent", id: "agt_dev", folders: [{ path: DOCS, access: "read" }] }, 6),
      set({ scope: "thread", id: "thr_dev", cwd: BRAIN }, 7),
    ], "dev_1");
    expect(out.threads).toEqual(s.threads);
    expect(out.projects).toEqual(s.projects);
    expect(out.agents).toEqual(s.agents);
  });
});
