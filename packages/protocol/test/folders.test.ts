import { describe, expect, it } from "vitest";
import {
  ACCESS_BLURB, Agent, FolderList, MUTATIONS, Project, Run, SessionMarkerCard, Thread, approvedFolder, canBrowseFolders, countsAsAgentOutput, folderChanges, folderLabel,
  folderName, foldersChipText, foldersMarkerText, moveOptions, normFolder, offersFolders, pathTail, resolveRunCwd, resolveRunFolders, sameFolder, startFolders, switchMarkerText,
  tidyFolders, type AgentFolderFacts, type FolderAgent,
} from "../src";

const facts = (approved: AgentFolderFacts["approved"]): AgentFolderFacts => ({ browse: true, host: "homebase-server", sep: "/", roots: [{ label: "Home", path: "/home/o" }], approved });
const SANDBOX = "/home/o/homebase-data/claude-workspace";
const agent = (over: Partial<FolderAgent> = {}): FolderAgent => ({
  workspaces: [{ label: "sandbox", cwd: SANDBOX }, { label: "notetaker", cwd: "/home/o/git/notetaker" }],
  folders: facts([
    { path: SANDBOX, label: "sandbox", access: "write", source: "sandbox" },
    { path: "/home/o/git/notetaker", label: "notetaker", access: "write", source: "app" },
    { path: "/home/o/git/site", label: "site", access: "write", source: "config" },
    { path: "/home/o/docs", label: "docs", access: "read", source: "app" },
    { path: "/mnt/usb/assets", label: "assets", access: "write", source: "app", missing: true },
  ]),
  ...over,
});

describe("folder paths, compared without a filesystem", () => {
  it("treats slashes, a trailing slash and Windows case as the same folder", () => {
    expect(sameFolder("C:\\Users\\Me\\git\\notetaker", "c:/users/me/git/notetaker/")).toBe(true);
    expect(sameFolder("/home/o/Git", "/home/o/git")).toBe(false); // case matters on Linux
    expect(sameFolder("/home/o/git/", "/home/o/git")).toBe(true);
    expect(sameFolder("C:\\", "c:/")).toBe(true);
    expect(sameFolder(null, null)).toBe(false);
    expect(normFolder("/")).toBe("/");
    expect(folderName("C:\\Users\\Me\\git\\notetaker\\")).toBe("notetaker");
    expect(folderName("/srv/repos/site")).toBe("site");
  });

  it("knows what an agent offers", () => {
    const a = agent();
    expect(offersFolders(a)).toBe(true);
    expect(canBrowseFolders(a)).toBe(true);
    expect(offersFolders({ workspaces: [] })).toBe(false); // a scripted agent, or an older connector
    expect(approvedFolder(a, "/home/o/docs/")?.access).toBe("read");
    expect(approvedFolder(a, "/home/o/elsewhere")).toBeUndefined();
    // A session can only start in a folder approved for writing that is on disk.
    expect(startFolders(a).map((f) => f.label)).toEqual(["sandbox", "notetaker", "site"]);
    // An older connector reports no folders: its workspaces are what a session can start in.
    expect(startFolders({ workspaces: [{ label: "sandbox", cwd: SANDBOX }] })).toEqual([{ label: "sandbox", path: SANDBOX }]);
    expect(folderLabel(a, "/home/o/git/notetaker")).toBe("notetaker");
    expect(folderLabel(a, "/somewhere/else")).toBe("else");
  });
});

describe("the primary folder of a run (cwd and resume rules)", () => {
  const a = agent();
  it("with nothing chosen anywhere it is the agent's sandbox, as before folders existed", () => {
    expect(resolveRunCwd({ agent: a })).toEqual({ cwd: SANDBOX, from: "connector" });
    expect(resolveRunCwd({ agent: a, project: { defaultCwd: null }, thread: { cwd: null } })).toEqual({ cwd: SANDBOX, from: "connector" });
  });

  it("a new session starts in its project's folder, when the agent has it", () => {
    expect(resolveRunCwd({ agent: a, project: { defaultCwd: "/home/o/git/notetaker" } })).toEqual({ cwd: "/home/o/git/notetaker", from: "project" });
    // Another agent's folder, or one that is approved read-only, is not a place to work: the next level applies.
    expect(resolveRunCwd({ agent: a, project: { defaultCwd: "/srv/other" } }).from).toBe("connector");
    expect(resolveRunCwd({ agent: a, project: { defaultCwd: "/home/o/docs" } }).from).toBe("connector");
  });

  it("the agent's default folder comes after the project's and before the sandbox", () => {
    const withDefault = agent({ defaultCwd: "/home/o/git/site" });
    expect(resolveRunCwd({ agent: withDefault })).toEqual({ cwd: "/home/o/git/site", from: "agent" });
    expect(resolveRunCwd({ agent: withDefault, project: { defaultCwd: "/home/o/git/notetaker" } }).from).toBe("project");
    expect(resolveRunCwd({ agent: agent({ defaultCwd: "/gone" }) }).from).toBe("connector");
  });

  it("the session's own folder beats the project's and the agent's", () => {
    const r = resolveRunCwd({ agent: agent({ defaultCwd: "/home/o/git/site" }), project: { defaultCwd: "/home/o/git/notetaker" }, thread: { cwd: "/home/o/git/site" } });
    expect(r).toEqual({ cwd: "/home/o/git/site", from: "session" });
  });

  it("a session that resumes runs where its agent session started, whatever was chosen since", () => {
    const r = resolveRunCwd({ agent: a, project: { defaultCwd: "/home/o/git/site" }, thread: { cwd: "/home/o/git/site" }, resumeCwd: "/home/o/git/notetaker", lastCwd: "/home/o/git/notetaker" });
    expect(r).toEqual({ cwd: "/home/o/git/notetaker", from: "resume" });
  });

  it("a fresh agent session stays where the session worked, unless it was given a new folder", () => {
    // "Start fresh" from the model picker: no resume, no new folder.
    expect(resolveRunCwd({ agent: a, lastCwd: "/home/o/git/notetaker", project: { defaultCwd: "/home/o/git/site" } })).toEqual({ cwd: "/home/o/git/notetaker", from: "last" });
    // "Start fresh in the new folder".
    expect(resolveRunCwd({ agent: a, thread: { cwd: "/home/o/git/site" }, lastCwd: "/home/o/git/notetaker" })).toEqual({ cwd: "/home/o/git/site", from: "session" });
  });

  it("a session's folder the connector no longer has is still passed on, so the connector refuses instead of the agent working elsewhere", () => {
    expect(resolveRunCwd({ agent: a, thread: { cwd: "/home/o/git/removed" } })).toEqual({ cwd: "/home/o/git/removed", from: "session" });
  });

  it("a folder asked for on one run wins (the agent page's Start a run)", () => {
    expect(resolveRunCwd({ agent: a, asked: "/home/o/git/site", thread: { cwd: "/home/o/git/notetaker" } }).from).toBe("run");
  });
});

describe("the extra folders of a run (project to session inheritance)", () => {
  it("nothing set: no extra folders", () => {
    expect(resolveRunFolders({ agent: agent() })).toEqual({ folders: [], skipped: [] });
  });

  it("adds the agent's defaults, then the project's, then the session's own", () => {
    const r = resolveRunFolders({
      agent: agent({ defaultFolders: [{ path: "/home/o/docs", access: "read" }] }),
      project: { folders: [{ path: "/home/o/git/site", access: "read" }] },
      thread: { folders: [{ path: "/home/o/git/notetaker", access: "write" }] },
      cwd: SANDBOX,
    });
    expect(r.folders).toEqual([
      { path: "/home/o/docs", access: "read", from: "agent" },
      { path: "/home/o/git/site", access: "read", from: "project" },
      { path: "/home/o/git/notetaker", access: "write", from: "session" },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("the same folder at two levels takes the more specific level's access", () => {
    const r = resolveRunFolders({
      agent: agent(), project: { folders: [{ path: "/home/o/git/site", access: "write" }] }, thread: { folders: [{ path: "/home/o/git/site/", access: "read" }] }, cwd: SANDBOX,
    });
    expect(r.folders).toEqual([{ path: "/home/o/git/site", access: "read", from: "session" }]);
  });

  it("never passes a folder on for more than its connector approved it for", () => {
    const r = resolveRunFolders({ agent: agent(), thread: { folders: [{ path: "/home/o/docs", access: "write" }] }, cwd: SANDBOX });
    expect(r.folders).toEqual([{ path: "/home/o/docs", access: "read", from: "session" }]);
  });

  it("drops what is not approved, what is not on disk and the primary folder itself, and says which", () => {
    const r = resolveRunFolders({
      agent: agent(),
      project: { folders: [{ path: "/etc", access: "read" }, { path: "/mnt/usb/assets", access: "write" }, { path: "/home/o/git/notetaker", access: "read" }] },
      cwd: "/home/o/git/notetaker",
    });
    expect(r.folders).toEqual([]);
    expect(r.skipped.map((s) => [s.path, s.why])).toEqual([["/etc", "not_approved"], ["/mnt/usb/assets", "missing"], ["/home/o/git/notetaker", "primary"]]);
  });

  it("an agent that takes no folders gets none, whatever a project says", () => {
    const scripted: FolderAgent = { workspaces: [{ label: "x", cwd: "/srv/x" }] };
    expect(resolveRunFolders({ agent: scripted, project: { folders: [{ path: "/home/o/docs", access: "read" }] } }).folders).toEqual([]);
  });

  it("tidies a list for storing and tells two lists apart", () => {
    expect(tidyFolders([{ path: "/a", access: "read" }, { path: "/a/", access: "write" }, { path: "/b", access: "read" }], "/b")).toEqual([{ path: "/a/", access: "write" }]);
    const c = folderChanges([{ path: "/a", access: "read" }, { path: "/b", access: "read" }], [{ path: "/a", access: "write" }, { path: "/c", access: "read" }]);
    expect(c).toEqual({ added: [{ path: "/c", access: "read" }], removed: [{ path: "/b", access: "read" }], changed: [{ path: "/a", access: "write" }] });
    expect(folderChanges(null, null)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe("migration: rows from before folders existed", () => {
  it("an agent, a project, a session and a run without any folder field are still valid", () => {
    const ts = 1;
    expect(Agent.safeParse({ id: "agt_1", connectorId: null, key: "claude", name: "Claude", kind: "claude", description: "", capabilities: [], workspaces: [], permissionProfile: "strict", status: "online", updatedAt: ts }).success).toBe(true);
    expect(Project.safeParse({ id: "prj_1", name: "Notetaker", description: null, defaultAgentId: null, defaultCwd: null, pinned: false, archived: false, createdAt: ts, updatedAt: ts }).success).toBe(true);
    expect(Thread.safeParse({ id: "thr_1", title: "x", agentId: null, lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: ts, updatedAt: ts }).success).toBe(true);
    expect(Run.safeParse({
      id: "run_1", agentId: "agt_1", threadId: null, prompt: "x", status: "queued", sessionRef: null, summary: null, error: null, costUsd: null, numTurns: null,
      durationMs: null, lastEventIdx: -1, startedBy: null, cwd: "/srv/x", createdAt: ts, startedAt: null, endedAt: null, updatedAt: ts,
    }).success).toBe(true);
  });

  it("validates the new mutation and refuses paths with control characters or too many folders", () => {
    const set = MUTATIONS["folders.set"];
    expect(set.safeParse({ scope: "project", id: "prj_1", cwd: "C:\\Users\\me\\git\\notetaker", folders: [{ path: "C:\\docs", access: "read" }] }).success).toBe(true);
    expect(set.safeParse({ scope: "thread", id: "thr_1", cwd: null }).success).toBe(true);
    expect(set.safeParse({ scope: "thread", id: "thr_1", cwd: "/a\n--dangerous" }).success).toBe(false);
    expect(set.safeParse({ scope: "thread", id: "thr_1", folders: [{ path: "/a", access: "admin" }] }).success).toBe(false);
    expect(FolderList.safeParse(Array.from({ length: 13 }, (_, i) => ({ path: `/f${i}`, access: "read" }))).success).toBe(false);
    expect(MUTATIONS["thread.create"].safeParse({ threadId: "thr_1", title: "x" }).success).toBe(true);
  });
});

describe("the words the owner reads", () => {
  it("says honestly what read-only is: a permission rule on file tools, not a sandbox", () => {
    expect(ACCESS_BLURB.read).toMatch(/file tools cannot create or change anything/);
    expect(ACCESS_BLURB.read).toMatch(/not a sandbox/);
    expect(ACCESS_BLURB.read).toMatch(/a command you approve can still write here/);
    expect(ACCESS_BLURB.write).toMatch(/In Manual every edit and command still asks/);
  });

  it("explains why a session cannot change folder in place and offers the two honest ways", () => {
    const o = moveOptions("claude-workspace", "notetaker");
    expect(o.why).toBe("This session's conversation is stored with claude-workspace, the folder it started in. Claude Code can only resume a conversation from that folder, so the session cannot simply carry on in notetaker.");
    expect(o.fresh.title).toBe("Start fresh in notetaker");
    expect(o.fresh.body).toMatch(/will not remember this conversation/);
    expect(o.fresh.body).toMatch(/The messages stay here/);
    expect(o.extra.title).toBe("Keep the conversation, add notetaker");
    expect(o.extra.body).toMatch(/stays in claude-workspace and keeps everything said so far/);
  });

  it("writes the lines a session shows where its folders changed", () => {
    expect(switchMarkerText("fresh", "claude-sonnet-5-5", "high", "notetaker")).toBe("New agent session in notetaker, on Sonnet 5.5 · High. The agent does not see the messages above.");
    expect(switchMarkerText("fresh", "claude-sonnet-5-5", "high")).toBe("New agent session on Sonnet 5.5 · High. The agent does not see the messages above.");
    expect(foldersMarkerText({ added: [{ path: "/home/o/docs", access: "read" }], removed: [{ path: "/x/old", access: "read" }], changed: [{ path: "/y/site", access: "write" }] }))
      .toBe("Folders for the agent from here on: added docs (read-only); site is now read & write; removed old.");
    expect(foldersMarkerText({ added: [], removed: [], changed: [] })).toBe("");
    // The connector's own name for a folder is used when the caller knows it ("sandbox", not "claude-workspace").
    expect(foldersMarkerText({ added: [{ path: "/data/claude-workspace", access: "read" }], removed: [], changed: [] }, () => "sandbox")).toBe("Folders for the agent from here on: added sandbox (read-only).");
    expect(pathTail("C:\\Users\\me\\Documents\\git\\notetaker", 20)).toBe("…\\git\\notetaker");
    expect(pathTail("/srv/x", 20)).toBe("/srv/x");
    expect(foldersChipText("notetaker", 2)).toBe("notetaker +2");
    expect(foldersChipText("sandbox", 0)).toBe("sandbox");
  });

  it("a folders line is a marker, not something the agent said, so it never makes a session unread", () => {
    const card = SessionMarkerCard.parse({ type: "session_marker", kind: "folders", model: null, effort: null });
    expect(countsAsAgentOutput({ role: "system", card })).toBe(false);
    expect(SessionMarkerCard.safeParse({ type: "session_marker", kind: "fresh", model: null, effort: null, cwd: "/home/o/git/site" }).success).toBe(true);
  });
});
