import type { Agent, Approval, Message, Project, Run, Thread } from "./entities";
import { isLiveRun, type RunStatus } from "./enums";
import { stripAgentMarkup } from "./agentMarkup";
import { messagePreview } from "./attachments";

/**
 * Session organisation: the pure rules both clients and the hub share. A session is a chat thread
 * with an agent; it is filed in one project or sits in Unsorted. Nothing here touches storage or UI.
 */

/** The scope for sessions that are in no project. */
export const UNSORTED = "unsorted";
/** "all", "unsorted" or a project id. */
export type SessionScope = string;
export type SessionSort = "recent" | "attention" | "oldest" | "title";
export type SessionFilter = "open" | "unread" | "attention" | "running" | "archived";
export const SESSION_SORTS: Array<{ value: SessionSort; label: string }> = [
  { value: "recent", label: "Recent" }, { value: "attention", label: "Needs you" }, { value: "oldest", label: "Oldest" }, { value: "title", label: "A–Z" },
];
export const SESSION_FILTERS: Array<{ value: SessionFilter; label: string }> = [
  { value: "open", label: "Open" }, { value: "unread", label: "Unread" }, { value: "attention", label: "Needs you" }, { value: "running", label: "Running" },
  { value: "archived", label: "Archived" },
];

// ---------------------------------------------------------------- titles and digests

const DEFAULT_TITLE = /^(New chat with .+|New scratch thread|New session(?: (?:with|in) .+)?)$/;
/** True for the placeholder a new session gets before anything was said in it. */
export const isDefaultTitle = (title: string) => DEFAULT_TITLE.test(title.trim());

/** Agent text as one plain line: tone markup, Markdown marks and line breaks removed, cut at a word. */
export function digestText(text: string, max = 280): string {
  const plain = stripAgentMarkup(text)
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[\[([^\]\n|]+\|)?([^\]\n]+)\]\]/g, "$2")
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/gm, "")
    .replace(/\*\*|__|~~|==|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** A session title from the first thing the owner said in it. */
export function titleFromMessage(text: string, max = 64): string {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l && !/^<\/?[a-z_]+[^>]*>$/i.test(l)) ?? "";
  return digestText(first, max).replace(/[.,;:\s]+$/, "") || "Untitled session";
}

/** What the chat shows when the owner asks for a recap. The agent gets RECAP_PROMPT. */
export const RECAP_REQUEST = "Recap where we left off.";
export const RECAP_PROMPT =
  "Write a recap of this session so the owner can pick it up later without rereading it. Do not run any tools and do not start new work. " +
  "Under 120 words, in three short parts: **Doing** (what this session is for), **Done** (what is finished), " +
  "**Next** (the next step, and anything that is waiting on the owner).";

// ---------------------------------------------------------------- status and "where I left off"

export type SessionStatus = "waiting" | "failed" | "running" | "offline" | "idle";
/** Lower sorts first under "Needs you". */
export const STATUS_RANK: Record<SessionStatus, number> = { waiting: 0, failed: 1, offline: 2, running: 3, idle: 4 };

export function sessionStatus(lastRunStatus: RunStatus | null | undefined): SessionStatus {
  if (!lastRunStatus) return "idle";
  if (lastRunStatus === "waiting_approval") return "waiting";
  if (lastRunStatus === "failed") return "failed";
  if (lastRunStatus === "offline") return "offline";
  return isLiveRun(lastRunStatus) ? "running" : "idle";
}
export const needsOwner = (s: SessionStatus) => s === "waiting" || s === "failed" || s === "offline";

export interface LeftOff {
  /** note: the owner wrote it. recap: the agent wrote it on request. summary: the hub's digest of the last reply. */
  source: "note" | "recap" | "summary" | "none";
  text: string;
  at: number | null;
  /** A recap that is older than the session's last message. */
  stale: boolean;
}

/** True when something was said in the session after its recap was written. */
export function recapIsStale(t: Pick<Thread, "recapAt" | "lastMessageAt">): boolean {
  // A minute of slack: the recap is itself a message in the session.
  return (t.lastMessageAt ?? 0) > (t.recapAt ?? 0) + 60_000;
}

/** The one line that says where a session stands: the owner's note, else a fresh recap, else the digest, else an old recap. */
export function leftOff(t: Pick<Thread, "note" | "recap" | "recapAt" | "summary" | "lastMessageAt">): LeftOff {
  if (t.note?.trim()) return { source: "note", text: t.note.trim(), at: null, stale: false };
  const recap = t.recap?.trim() ? digestText(t.recap, 400) : "";
  const stale = !!recap && recapIsStale(t);
  if (recap && !stale) return { source: "recap", text: recap, at: t.recapAt ?? null, stale: false };
  if (t.summary?.trim()) return { source: "summary", text: t.summary.trim(), at: t.lastMessageAt ?? null, stale: false };
  if (recap) return { source: "recap", text: recap, at: t.recapAt ?? null, stale: true };
  return { source: "none", text: "", at: null, stale: false };
}

// ---------------------------------------------------------------- unread
//
// The hub keeps two times on a session: `lastAgentAt` (the agent last put something in it) and `readAt`
// (up to when the owner has seen that, on any device). Both come from the hub, so no device clock is compared.

/** True when the agent has said something in the session that the owner has not had in view yet. */
export function isUnread(t: Pick<Thread, "lastAgentAt" | "readAt">): boolean {
  return t.lastAgentAt != null && t.lastAgentAt > (t.readAt ?? 0);
}

/** How many sessions have unread agent output: the number on the Sessions tab. Archived sessions never count. */
export function unreadCount(threads: Iterable<Pick<Thread, "lastAgentAt" | "readAt" | "archived">>): number {
  let n = 0;
  for (const t of threads) if (!t.archived && isUnread(t)) n++;
  return n;
}

/**
 * Whether a message is something the agent said that the owner should see. Not the owner's own words,
 * not the receipt for a dictation (the Notes tab already shows it), and not the line that marks a model
 * or session switch the owner made themselves.
 */
export function countsAsAgentOutput(m: Pick<Message, "role" | "card">): boolean {
  if (m.role === "user") return false;
  const card: string | undefined = m.card?.type;
  return card !== "vault_capture" && card !== "session_marker";
}

/** What `thread.read` leaves in `readAt`, or null when there is nothing to write. Never past what the agent has said. */
export function readUpTo(t: Pick<Thread, "lastAgentAt" | "readAt">, at?: number | null): number | null {
  if (t.lastAgentAt == null) return null;
  const upTo = Math.min(at ?? t.lastAgentAt, t.lastAgentAt);
  return upTo > (t.readAt ?? 0) ? upTo : null;
}

// ---------------------------------------------------------------- rows

export interface SessionRow {
  thread: Thread;
  project: Project | null;
  agent: Agent | null;
  /** Last message, else when it was created. */
  lastAt: number;
  status: SessionStatus;
  left: LeftOff;
  /** The pending approval the session waits on, when there is one. */
  waitingOn: string | null;
  /** The agent said something here that the owner has not seen yet. */
  unread: boolean;
  /** The newest message, for a preview when nothing better is known. */
  last: { text: string; role: Message["role"]; at: number; author: string | null } | null;
}

export interface SessionSources {
  threads: Iterable<Thread>;
  projects: Record<string, Project>;
  agents: Record<string, Agent>;
  messages?: Iterable<Message>;
  runs?: Iterable<Run>;
  approvals?: Iterable<Approval>;
}

/** One row per session, with everything a list needs. Cheap: a single pass over each input. */
export function buildSessionRows(src: SessionSources): SessionRow[] {
  const last = new Map<string, NonNullable<SessionRow["last"]>>();
  for (const m of src.messages ?? []) {
    const cur = last.get(m.threadId);
    if (!cur || m.createdAt >= cur.at) last.set(m.threadId, { text: messagePreview(m), role: m.role, at: m.createdAt, author: m.authorDeviceId });
  }
  // The newest run a device knows about wins over the hub's stored status (it may be fresher).
  const newest = new Map<string, Run>();
  for (const r of src.runs ?? []) {
    if (!r.threadId) continue;
    const cur = newest.get(r.threadId);
    if (!cur || r.createdAt > cur.createdAt || (r.createdAt === cur.createdAt && r.id > cur.id)) newest.set(r.threadId, r);
  }
  const waiting = new Map<string, string>();
  for (const a of src.approvals ?? []) if (a.status === "pending") waiting.set(a.runId, a.title);
  const rows: SessionRow[] = [];
  for (const thread of src.threads) {
    const run = newest.get(thread.id);
    const status = sessionStatus(run?.status ?? thread.lastRunStatus);
    rows.push({
      thread,
      project: (thread.projectId && src.projects[thread.projectId]) || null,
      agent: (thread.agentId && src.agents[thread.agentId]) || null,
      lastAt: thread.lastMessageAt ?? thread.createdAt,
      status,
      left: leftOff(thread),
      waitingOn: status === "waiting" && run ? waiting.get(run.id) ?? null : null,
      unread: isUnread(thread),
      last: last.get(thread.id) ?? null,
    });
  }
  return rows;
}

export function inScope(row: SessionRow, scope: SessionScope): boolean {
  if (scope === "all") return true;
  // A session whose project is gone from this device counts as Unsorted.
  if (scope === UNSORTED) return !row.project;
  return row.project?.id === scope;
}

export function filterSessions(rows: SessionRow[], o: { scope?: SessionScope; filter?: SessionFilter }): SessionRow[] {
  const scope = o.scope ?? "all";
  const filter = o.filter ?? "open";
  return rows.filter((r) => {
    if (!inScope(r, scope)) return false;
    if (filter === "archived") return r.thread.archived;
    if (r.thread.archived) return false;
    if (filter === "unread") return r.unread;
    if (filter === "attention") return needsOwner(r.status);
    if (filter === "running") return r.status === "running" || r.status === "waiting";
    return true;
  });
}

export function sortSessions(rows: SessionRow[], sort: SessionSort): SessionRow[] {
  const recent = (a: SessionRow, b: SessionRow) => b.lastAt - a.lastAt || (a.thread.id < b.thread.id ? 1 : -1);
  const pinned = (a: SessionRow, b: SessionRow) => Number(b.thread.pinned) - Number(a.thread.pinned);
  const by: Record<SessionSort, (a: SessionRow, b: SessionRow) => number> = {
    recent: (a, b) => pinned(a, b) || recent(a, b),
    attention: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || pinned(a, b) || recent(a, b),
    oldest: (a, b) => -recent(a, b),
    title: (a, b) => a.thread.title.localeCompare(b.thread.title, undefined, { sensitivity: "base", numeric: true }) || recent(a, b),
  };
  return [...rows].sort(by[sort]);
}

// ---------------------------------------------------------------- search

export type SearchField = "title" | "note" | "recap" | "project" | "agent" | "summary" | "message";
const FIELD_WEIGHT: Record<SearchField, number> = { title: 10, note: 7, recap: 6, project: 5, summary: 4, agent: 3, message: 2 };

export interface SessionHit {
  row: SessionRow;
  score: number;
  /** Where the best match outside the title was found, with the text around it. Null when the title says it all. */
  hit: { field: Exclude<SearchField, "title">; snippet: string; at: number | null; role?: Message["role"] } | null;
}

export const searchTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

/** The text around the first place `term` appears, on one line. */
export function excerpt(text: string, term: string, radius = 48): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(term);
  if (i < 0) return flat.slice(0, radius * 2);
  const from = Math.max(0, i - radius);
  const to = Math.min(flat.length, i + term.length + radius);
  return `${from > 0 ? "…" : ""}${flat.slice(from, to).trim()}${to < flat.length ? "…" : ""}`;
}

/**
 * Finds sessions by any of: title, the owner's note, the agent's recap, the last-reply digest, project
 * name, agent name and the text of the messages a device holds. Every word of the query must appear
 * somewhere in the session (in any field); a match in the title or the note ranks above a match deep
 * in the conversation, and newer sessions win ties. An empty query returns every row, unranked.
 */
export function searchSessions(rows: SessionRow[], query: string, messages: Iterable<Message> = []): SessionHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return rows.map((row) => ({ row, score: 0, hit: null }));
  let byThread: Map<string, Message[]> | null = null;
  const messagesOf = (threadId: string): Message[] => {
    if (!byThread) {
      byThread = new Map();
      for (const m of messages) {
        const list = byThread.get(m.threadId);
        if (list) list.push(m);
        else byThread.set(m.threadId, [m]);
      }
      for (const list of byThread.values()) list.sort((a, b) => b.createdAt - a.createdAt);
    }
    return byThread.get(threadId) ?? [];
  };
  const out: SessionHit[] = [];
  for (const row of rows) {
    const t = row.thread;
    const fields: Array<[Exclude<SearchField, "message">, string]> = [
      ["title", t.title], ["note", t.note ?? ""], ["recap", t.recap ?? ""], ["project", row.project?.name ?? "Unsorted"],
      ["agent", row.agent?.name ?? ""], ["summary", t.summary ?? ""],
    ];
    const lower = fields.map(([f, v]) => [f, v, v.toLowerCase()] as const);
    let score = 0;
    let best: SessionHit["hit"] = null;
    let bestWeight = 0;
    let ok = true;
    for (const term of terms) {
      let weight = 0;
      let where: SessionHit["hit"] = null;
      for (const [f, v, lc] of lower) {
        const i = lc.indexOf(term);
        if (i < 0 || FIELD_WEIGHT[f] <= weight) continue;
        weight = FIELD_WEIGHT[f] + (f === "title" && (i === 0 || /\W/.test(lc[i - 1])) ? 2 : 0);
        where = f === "title" ? null : { field: f, snippet: excerpt(v, term), at: f === "recap" ? t.recapAt ?? null : null };
      }
      if (weight === 0) {
        // Only now is the conversation read, newest message first.
        const m = messagesOf(t.id).find((x) => x.text.toLowerCase().includes(term));
        if (m) {
          weight = FIELD_WEIGHT.message;
          where = { field: "message", snippet: excerpt(stripAgentMarkup(m.text), term), at: m.createdAt, role: m.role };
        }
      }
      if (weight === 0) {
        ok = false;
        break;
      }
      score += weight;
      // The snippet shown is for the word that was hardest to find: the one the title does not explain.
      if (where && (!best || weight < bestWeight)) {
        best = where;
        bestWeight = weight;
      }
    }
    if (ok) out.push({ row, score, hit: best });
  }
  return out.sort((a, b) => b.score - a.score || b.row.lastAt - a.row.lastAt);
}

// ---------------------------------------------------------------- projects

export interface ProjectStats {
  sessions: number;
  archived: number;
  running: number;
  attention: number;
  lastAt: number | null;
  /** The session to continue: the one touched last. */
  latest: SessionRow | null;
}

export function projectStats(rows: SessionRow[], scope: SessionScope): ProjectStats {
  const s: ProjectStats = { sessions: 0, archived: 0, running: 0, attention: 0, lastAt: null, latest: null };
  for (const r of rows) {
    if (!inScope(r, scope)) continue;
    if (r.thread.archived) {
      s.archived++;
      continue;
    }
    s.sessions++;
    if (r.status === "running") s.running++;
    if (needsOwner(r.status)) s.attention++;
    if (s.lastAt == null || r.lastAt > s.lastAt) {
      s.lastAt = r.lastAt;
      s.latest = r;
    }
  }
  return s;
}

/** Pinned first, then by what was touched last, then by name. Archived projects are left out unless asked for. */
export function sortProjects(projects: Project[], lastAt: (p: Project) => number | null, includeArchived = false): Project[] {
  return projects
    .filter((p) => includeArchived || !p.archived)
    .sort((a, b) => Number(a.archived) - Number(b.archived) || Number(b.pinned) - Number(a.pinned)
      || (lastAt(b) ?? b.createdAt) - (lastAt(a) ?? a.createdAt) || a.name.localeCompare(b.name));
}

export interface ProjectAgent {
  agent: Agent;
  sessions: number;
  lastAt: number | null;
  isDefault: boolean;
}

/** The agents that work in a project: its default agent first, then by how many sessions each has there. */
export function projectAgents(rows: SessionRow[], project: Project, agents: Record<string, Agent>): ProjectAgent[] {
  const m = new Map<string, ProjectAgent>();
  const def = project.defaultAgentId ? agents[project.defaultAgentId] : undefined;
  if (def) m.set(def.id, { agent: def, sessions: 0, lastAt: null, isDefault: true });
  for (const r of rows) {
    if (r.project?.id !== project.id || !r.agent || r.thread.archived) continue;
    const cur = m.get(r.agent.id) ?? { agent: r.agent, sessions: 0, lastAt: null, isDefault: false };
    cur.sessions++;
    cur.lastAt = Math.max(cur.lastAt ?? 0, r.lastAt);
    m.set(r.agent.id, cur);
  }
  return [...m.values()].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.sessions - a.sessions || a.agent.name.localeCompare(b.agent.name));
}
