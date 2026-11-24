import { z } from "zod";

/**
 * Folders: what an agent has at its disposal on the machine it runs on.
 *
 * A run has one **primary folder** (its working directory, where the agent starts and where its
 * session is stored) and any number of **extra folders** next to it, each read-only or read & write.
 * Three levels can set them: an agent's defaults, a project, and a session. Nothing here is specific to
 * one provider: Claude Code takes them as its cwd and `--add-dir`, Codex as `-C` and `--add-dir`.
 *
 * The real fence is on the connector: a folder is used only when that machine's own allowlist has it
 * (its config file, plus the folders the owner approved from the app). The hub and the clients only
 * carry the owner's choice. Everything in this file is pure: the shapes, the rule that decides what a
 * run gets, and the words the owner reads.
 */

export const FOLDER_ACCESS = ["read", "write"] as const;
export const FolderAccess = z.enum(FOLDER_ACCESS);
export type FolderAccess = z.infer<typeof FolderAccess>;
export const ACCESS_LABEL: Record<FolderAccess, string> = { read: "Read-only", write: "Read & write" };
export const ACCESS_TAG: Record<FolderAccess, string> = { read: "READ-ONLY", write: "READ & WRITE" };

/** A path on the connector's machine. No control characters, so it is always one safe argument. */
export const FolderPath = z.string().min(1).max(1000).regex(/^[^\u0000-\u001f]+$/);
export const MAX_EXTRA_FOLDERS = 12;
/** An extra folder next to the primary one. */
export const FolderRef = z.object({ path: FolderPath, access: FolderAccess });
export type FolderRef = z.infer<typeof FolderRef>;
export const FolderList = z.array(FolderRef).max(MAX_EXTRA_FOLDERS);

/** A folder the connector will accept, and the most it may be used for. */
export const ApprovedFolder = z.object({
  path: FolderPath, label: z.string().max(80),
  /** "write": may be a primary folder or a read & write extra. "read": only ever a read-only extra. */
  access: FolderAccess,
  /** sandbox: the agent's own scratch folder. config: listed in the connector's config file. app: approved by the owner from the app. */
  source: z.enum(["sandbox", "config", "app"]),
  addedAt: z.number().int().nullable().optional(),
  /** True when the folder is approved but not on disk right now (an unplugged drive, a renamed folder). */
  missing: z.boolean().optional(),
});
export type ApprovedFolder = z.infer<typeof ApprovedFolder>;

/** What a connector says about folders for one agent. Paths and labels only; never file names or contents. */
export const AgentFolderFacts = z.object({
  /** True when the owner may browse this machine and approve folders from the app. */
  browse: z.boolean(),
  /** The machine the folders are on, and its path separator. */
  host: z.string().max(200), sep: z.enum(["/", "\\"]),
  /** Where the folder browser starts. Nothing outside these can be listed or approved from the app. */
  roots: z.array(z.object({ label: z.string().max(80), path: FolderPath })).max(20),
  approved: z.array(ApprovedFolder).max(300),
});
export type AgentFolderFacts = z.infer<typeof AgentFolderFacts>;

// ---------------------------------------------------------------- the folder browser (device ⇄ hub ⇄ connector)

/**
 * roots / list / check only read folder names. approve and forget change the connector's allowlist:
 * the hub takes them only from a device that may approve, and writes them to the audit log.
 */
export const FOLDER_OPS = ["roots", "list", "check", "approve", "forget"] as const;
export const FolderOp = z.enum(FOLDER_OPS);
export type FolderOp = z.infer<typeof FolderOp>;
export const FOLDER_WRITE_OPS: readonly FolderOp[] = ["approve", "forget"];

/** One folder as the connector judges it. */
export interface FolderCheck {
  /** The real path (links resolved, `~` expanded). */
  path: string;
  label: string;
  /** False when this folder can never be added, with `reason`. */
  ok: boolean;
  reason: string | null;
  /** How it is approved today, or null. */
  approved: FolderAccess | null;
  source: ApprovedFolder["source"] | null;
  /** The most it can be approved for. Some broad folders are read-only at most. */
  maxAccess: FolderAccess;
  /** Things worth knowing before approving (for example "everything in your Documents becomes reachable"). */
  warnings: string[];
  git: boolean;
}
export interface FolderEntry {
  name: string;
  path: string;
  git: boolean;
  approved: FolderAccess | null;
  /** Why this folder cannot be added. It may still be opened to pick a folder inside it. */
  blocked: string | null;
  /** False when the browser will not go inside (a credential or system folder). */
  canOpen: boolean;
}
export interface FolderListing {
  self: FolderCheck;
  /** The folder above, or null at a browse root. */
  parent: string | null;
  /** From the browse root down to this folder. */
  crumbs: Array<{ label: string; path: string }>;
  entries: FolderEntry[];
  /** How many folders were left out: hidden ones, and anything past the cap. */
  hidden: number;
  truncated: boolean;
}

// ---------------------------------------------------------------- paths, compared without a filesystem

const WINDOWS = /^[A-Za-z]:[\\/]|^\\\\/;
/** One spelling per folder, for comparing: forward slashes, no trailing slash, lower case for a Windows path. */
export function normFolder(p: string): string {
  const win = WINDOWS.test(p);
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!s) s = "/";
  if (/^[A-Za-z]:$/.test(s)) s += "/";
  return win ? s.toLowerCase() : s;
}
export const sameFolder = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && normFolder(a) === normFolder(b);
/** The last part of a path: "notetaker" for C:\Users\me\git\notetaker. */
export function folderName(p: string | null | undefined): string {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

// ---------------------------------------------------------------- what an agent offers

export interface FolderAgent {
  workspaces?: Array<{ label: string; cwd: string }> | null;
  folders?: AgentFolderFacts | null;
  defaultCwd?: string | null;
  defaultFolders?: FolderRef[] | null;
}
export interface FolderProject {
  defaultAgentId?: string | null;
  defaultCwd?: string | null;
  folders?: FolderRef[] | null;
}
export interface FolderThread {
  cwd?: string | null;
  folders?: FolderRef[] | null;
}

/** True when this agent's connector reports folders, so the owner can pick them. A scripted agent, Comms and Notes do not. */
export const offersFolders = (agent: FolderAgent | null | undefined): boolean => !!agent?.folders;
/** True when the owner can also browse that machine and approve new folders from the app. */
export const canBrowseFolders = (agent: FolderAgent | null | undefined): boolean => !!agent?.folders?.browse;

/** How the agent's connector has a folder approved, or undefined. */
export function approvedFolder(agent: FolderAgent | null | undefined, path: string | null | undefined): ApprovedFolder | undefined {
  if (!path) return undefined;
  return agent?.folders?.approved.find((f) => sameFolder(f.path, path));
}
/** The folders a session may start in: approved for writing. With an older connector, its workspaces. */
export function startFolders(agent: FolderAgent | null | undefined): Array<{ label: string; path: string }> {
  if (agent?.folders) return agent.folders.approved.filter((f) => f.access === "write" && !f.missing).map((f) => ({ label: f.label, path: f.path }));
  return (agent?.workspaces ?? []).map((w) => ({ label: w.label, path: w.cwd }));
}
const offersStart = (agent: FolderAgent, path: string | null | undefined): boolean =>
  !!path && ((agent.workspaces ?? []).some((w) => sameFolder(w.cwd, path)) || startFolders(agent).some((f) => sameFolder(f.path, path)));
/** A short name for a folder: the connector's label when it has one, else the last part of the path. */
export function folderLabel(agent: FolderAgent | null | undefined, path: string | null | undefined): string {
  if (!path) return "";
  return approvedFolder(agent, path)?.label ?? agent?.workspaces?.find((w) => sameFolder(w.cwd, path))?.label ?? folderName(path);
}

// ---------------------------------------------------------------- what a run gets

export type CwdSource = "run" | "resume" | "session" | "last" | "project" | "agent" | "connector";

/**
 * The primary folder of a run, and why. The order is the whole rule:
 *   run        asked for on this one run (the agent page's "Start a run")
 *   resume     the run continues an agent session, so it runs where that session started. Claude Code
 *              stores a conversation per folder and cannot resume it from anywhere else.
 *   session    the session's own folder: chosen when it was created, before its first message, or with
 *              "start fresh in another folder"
 *   last       a fresh agent session with no new folder stays where the session worked before
 *   project    the project's primary folder, when this agent has it
 *   agent      the owner's default folder for the agent, when it still has it
 *   connector  the agent's first workspace (its sandbox)
 * A session's own folder is passed on even if the connector no longer has it: the connector then refuses
 * the run and says so, instead of the agent quietly working somewhere else.
 */
export function resolveRunCwd(i: {
  agent: FolderAgent; project?: FolderProject | null; thread?: FolderThread | null;
  asked?: string | null; resumeCwd?: string | null; lastCwd?: string | null;
}): { cwd: string | null; from: CwdSource } {
  if (i.asked) return { cwd: i.asked, from: "run" };
  if (i.resumeCwd) return { cwd: i.resumeCwd, from: "resume" };
  if (i.thread?.cwd) return { cwd: i.thread.cwd, from: "session" };
  if (i.lastCwd) return { cwd: i.lastCwd, from: "last" };
  if (i.project?.defaultCwd && offersStart(i.agent, i.project.defaultCwd)) return { cwd: i.project.defaultCwd, from: "project" };
  if (i.agent.defaultCwd && offersStart(i.agent, i.agent.defaultCwd)) return { cwd: i.agent.defaultCwd, from: "agent" };
  return { cwd: i.agent.workspaces?.[0]?.cwd ?? startFolders(i.agent)[0]?.path ?? null, from: "connector" };
}

export type FolderSource = "session" | "project" | "agent";
export interface ResolvedFolder extends FolderRef {
  from: FolderSource;
}
export interface SkippedFolder extends ResolvedFolder {
  why: "not_approved" | "missing" | "primary";
}

/**
 * The extra folders of a run: the agent's defaults, then the project's, then the session's own. The same
 * folder named twice takes the access of the more specific level (session over project over agent).
 * A folder is dropped, and listed in `skipped`, when it is the primary folder itself or when the agent's
 * connector does not have it approved. A folder approved read-only is never passed on as read & write.
 */
export function resolveRunFolders(i: { agent: FolderAgent; project?: FolderProject | null; thread?: FolderThread | null; cwd?: string | null }): { folders: ResolvedFolder[]; skipped: SkippedFolder[] } {
  const merged = new Map<string, ResolvedFolder>();
  const add = (list: FolderRef[] | null | undefined, from: FolderSource) => {
    for (const f of list ?? []) {
      const key = normFolder(f.path);
      merged.delete(key); // the more specific level moves to the end and wins
      merged.set(key, { path: f.path, access: f.access, from });
    }
  };
  add(i.agent.defaultFolders, "agent");
  add(i.project?.folders, "project");
  add(i.thread?.folders, "session");
  const folders: ResolvedFolder[] = [];
  const skipped: SkippedFolder[] = [];
  for (const f of merged.values()) {
    if (i.cwd && sameFolder(f.path, i.cwd)) {
      skipped.push({ ...f, why: "primary" });
      continue;
    }
    const ok = approvedFolder(i.agent, f.path);
    if (!ok) skipped.push({ ...f, why: "not_approved" });
    else if (ok.missing) skipped.push({ ...f, why: "missing" });
    else folders.push({ path: ok.path, access: ok.access === "read" ? "read" : f.access, from: f.from });
  }
  return { folders: folders.slice(0, MAX_EXTRA_FOLDERS), skipped };
}

/** A clean list for storing: one entry per folder (the last one wins), without the primary folder. */
export function tidyFolders(list: FolderRef[], cwd?: string | null): FolderRef[] {
  const m = new Map<string, FolderRef>();
  for (const f of list) if (!(cwd && sameFolder(f.path, cwd))) m.set(normFolder(f.path), { path: f.path, access: f.access });
  return [...m.values()];
}

/** What changed between the extra folders of two runs, for the line a session shows where it happened. */
export function folderChanges(before: FolderRef[] | null | undefined, after: FolderRef[] | null | undefined): { added: FolderRef[]; removed: FolderRef[]; changed: FolderRef[] } {
  const a = new Map((before ?? []).map((f) => [normFolder(f.path), f]));
  const b = new Map((after ?? []).map((f) => [normFolder(f.path), f]));
  return {
    added: [...b].filter(([k]) => !a.has(k)).map(([, f]) => f),
    removed: [...a].filter(([k]) => !b.has(k)).map(([, f]) => f),
    changed: [...b].filter(([k, f]) => a.has(k) && a.get(k)!.access !== f.access).map(([, f]) => f),
  };
}

// ---------------------------------------------------------------- the words

/**
 * What read-only and read & write really mean, as enforced (checked against Claude Code 2.1.319).
 * `--add-dir` by itself gives the agent's file tools reach into a folder for reading AND writing; it has
 * no read-only form. Read-only is HomeBase's rule on top: the connector refuses every file-tool edit
 * there, in every mode, and the CLI is also started with a deny rule for edits in that folder. Shell
 * commands are judged by their command line, not confined by the operating system.
 */
export const ACCESS_BLURB: Record<FolderAccess, string> = {
  read: "The agent can read and search here. Its file tools cannot create or change anything in this folder, in any mode, and that cannot be approved from a card. "
    + "A shell command is different: in Manual every command asks you anyway, and in Auto a command that could change this folder asks first. "
    + "It is a permission rule, not a sandbox, so a command you approve can still write here.",
  write: "The agent can read here and change files here. In Manual every edit and command still asks you first. In Auto it edits and runs commands here without asking.",
};
export const PRIMARY_BLURB =
  "Where the agent starts and works. Edits here follow the session's mode (Manual asks, Auto does not). A session stays in the folder it started in, because that is where its conversation is stored.";
export const APPROVE_NOTE =
  "Approving adds this folder to the list this machine's connector accepts. An agent, including one in Auto mode with a shell, can then be pointed at it. Nothing outside the approved folders is ever used.";

/** The end of a path, for a narrow line: "…\git\notetaker". The start of a long path says the least. */
export function pathTail(path: string, max = 40): string {
  if (path.length <= max) return path;
  const cut = path.slice(path.length - max + 1);
  const at = cut.search(/[\\/]/);
  return `…${at > 0 && at < cut.length - 1 ? cut.slice(at) : cut}`;
}

/** "notetaker +2", for the chip above the message box. */
export function foldersChipText(primaryLabel: string, extras: number): string {
  return extras > 0 ? `${primaryLabel} +${extras}` : primaryLabel;
}

/**
 * Changing a session's primary folder once it has a conversation. It cannot be done in place, so the
 * owner is shown why and offered the two honest ways. Kept here so both clients and the tests say the same.
 */
export function moveOptions(from: string, to: string): { why: string; fresh: { title: string; body: string }; extra: { title: string; body: string } } {
  return {
    why: `This session's conversation is stored with ${from}, the folder it started in. Claude Code can only resume a conversation from that folder, so the session cannot simply carry on in ${to}.`,
    fresh: {
      title: `Start fresh in ${to}`,
      body: `A new agent session that works in ${to}. The agent will not remember this conversation. The messages stay here for you to read. `
        + "Ask for a recap first if you want something to hand over.",
    },
    extra: {
      title: `Keep the conversation, add ${to}`,
      body: `The session stays in ${from} and keeps everything said so far. ${to} is added next to it as an extra folder, from your next message.`,
    },
  };
}

/** The line a session shows where its extra folders changed. Empty when nothing did. */
export function foldersMarkerText(c: { added: FolderRef[]; removed: FolderRef[]; changed: FolderRef[] }, label: (path: string) => string = folderName): string {
  const name = (f: FolderRef) => `${label(f.path)} (${ACCESS_LABEL[f.access].toLowerCase()})`;
  const parts = [
    c.added.length ? `added ${c.added.map(name).join(", ")}` : "",
    c.changed.length ? `${c.changed.map((f) => `${label(f.path)} is now ${ACCESS_LABEL[f.access].toLowerCase()}`).join(", ")}` : "",
    c.removed.length ? `removed ${c.removed.map((f) => label(f.path)).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `Folders for the agent from here on: ${parts.join("; ")}.` : "";
}
