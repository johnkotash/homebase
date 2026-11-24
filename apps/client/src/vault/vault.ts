import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { isLiveRun, newId, resolveLink, type Agent, type AgentVaultStatus, type Message, type Thread, type VaultCaptureCard, type VaultFile } from "@homebase/protocol";
import { useList, useMap, useSync } from "../sync/hooks";
import { mutate, showToast, syncStore, vaultRequest } from "../sync/session";
import { cacheGet, cachePut, type NoteBody } from "./cache";
import { deviceTz, todayIn, type Today } from "./pure";

export { buildTree, deviceTz, displayTitle, fileName, folderLabel, looksLikeQuestion, todayIn, type Today, type TreeNode } from "./pure";

/**
 * The Notes tab's view of the vault (NOTES-PLAN.md 6, 7.3). Note metadata is synced like every other
 * entity; bodies are fetched from the vault on request and the last 50 opened are cached on this device.
 */

// ---------------------------------------------------------------- the Notes agent

export const isNotesAgent = (a: Pick<Agent, "key" | "vault"> | undefined | null) => !!a && (a.key === "notes" || !!a.vault);

export function useNotesAgent(): Agent | undefined {
  const agents = useMap("agents");
  return useMemo(() => Object.values(agents).find((a) => a.key === "notes") ?? Object.values(agents).find((a) => !!a.vault), [agents]);
}

export function useVaultFiles(): VaultFile[] {
  return useList("vault_files");
}

/** The Notes agent chat for a day. One chat per day keeps each agent session short. */
function threadFor(agent: Agent, today: Today): { id: string; create: boolean } {
  const title = `Notes · ${today.label}`;
  const threads = Object.values(syncStore.getState().entities.threads) as Thread[];
  const found = threads.filter((t) => t.agentId === agent.id && t.title === title && !t.archived).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (found) return { id: found.id, create: false };
  return { id: newId("thr"), create: true };
}

function sendToNotes(agent: Agent, text: string, source: "text" | "voice", dictation: boolean): string {
  const today = todayIn(agent.vault?.tz, Date.now());
  const th = threadFor(agent, today);
  if (th.create) void mutate("thread.create", { threadId: th.id, title: `Notes · ${today.label}`, agentId: agent.id });
  void mutate("message.send", {
    threadId: th.id, messageId: newId("msg"), text, source,
    // When it was said, on this device's clock: a queued dictation is filed under the day it was spoken.
    ...(dictation ? { capturedAt: Date.now(), tz: deviceTz() } : {}),
  });
  return th.id;
}

/** "Add to today": the text goes to the Notes agent as a dictation for the daily note. Works offline (queued). */
export function addToToday(agent: Agent | undefined, text: string, source: "text" | "voice"): string | null {
  const clean = text.trim();
  if (!clean) return null;
  if (!agent) {
    showToast("No Notes agent yet", "Start the connector on the machine that holds your vault.", "error");
    return null;
  }
  const threadId = sendToNotes(agent, clean.slice(0, 20000), source, true);
  const online = syncStore.getState().status === "online";
  showToast(online ? "Sent to your daily note" : "Queued for your daily note", online ? "The Notes agent is filing it." : "It will be filed under the time you said it, once you are back online.", "ok", `/chats/${threadId}`);
  return threadId;
}

/** "Ask instead": the same text as a question, and straight to the chat. */
export function askNotes(agent: Agent | undefined, text: string, source: "text" | "voice"): void {
  if (!agent) return showToast("No Notes agent yet", "Start the connector on the machine that holds your vault.", "error");
  const clean = text.trim();
  let threadId: string;
  if (clean) threadId = sendToNotes(agent, clean.slice(0, 20000), source, false);
  else {
    const today = todayIn(agent.vault?.tz, Date.now());
    const th = threadFor(agent, today);
    if (th.create) void mutate("thread.create", { threadId: th.id, title: `Notes · ${today.label}`, agentId: agent.id });
    threadId = th.id;
  }
  router.navigate(`/chats/${threadId}` as any);
}

/** The Notes agent's latest capture card for a day, and whether a run is filing something right now. */
export function useCaptureState(agent: Agent | undefined, ymd: string): { last: (Message & { card: VaultCaptureCard }) | null; filing: boolean; queued: number } {
  const messages = useMap("messages");
  const runs = useMap("runs");
  const outbox = useSync((s) => s.outbox);
  return useMemo(() => {
    let last: (Message & { card: VaultCaptureCard }) | null = null;
    for (const m of Object.values(messages)) {
      if (m.card?.type !== "vault_capture" || m.card.date !== ymd) continue;
      if (!last || m.createdAt > last.createdAt) last = m as Message & { card: VaultCaptureCard };
    }
    const filing = !!agent && Object.values(runs).some((r) => r.agentId === agent.id && isLiveRun(r.status));
    const queued = outbox.filter((m) => m.name === "message.send" && (m.args as any)?.capturedAt).length;
    return { last, filing, queued };
  }, [messages, runs, outbox, agent, ymd]);
}

// ---------------------------------------------------------------- opening notes and links

export interface NoteTarget {
  path: string;
  day?: string | null;
  heading?: string | null;
  line?: number | null;
}

export function noteHref(t: NoteTarget): string {
  const q = [`path=${encodeURIComponent(t.path)}`];
  if (t.day) q.push(`day=${encodeURIComponent(t.day)}`);
  if (t.heading) q.push(`heading=${encodeURIComponent(t.heading)}`);
  if (t.line) q.push(`line=${t.line}`);
  return `/notes/view?${q.join("&")}`;
}

export function openNote(t: NoteTarget) {
  router.navigate(noteHref(t) as any);
}

/** Follows a wikilink the way Obsidian would. A dead or ambiguous link says so instead of guessing. */
export function openLink(link: { target: string; heading: string | null; embed?: boolean }, from: string | null) {
  const files = Object.values(syncStore.getState().entities.vault_files) as VaultFile[];
  if (/\.(png|jpe?g|gif|webp|svg|pdf|csv)$/i.test(link.target)) return showToast("Attachment", `${link.target.split("/").pop()} — images and files open in a later version.`);
  const r = resolveLink(link.target, from, files.map((f) => f.path));
  if (r.kind === "dead") return showToast("No note behind this link", link.target, "error");
  if (r.kind === "ambiguous") return showToast("This link matches more than one note", r.candidates.slice(0, 3).join(" · "), "error");
  const day = link.heading && /^\d{8}$/.test(link.heading.trim()) ? link.heading.trim() : null;
  openNote({ path: r.path, day, heading: day ? null : link.heading });
}

// ---------------------------------------------------------------- bodies

export type { NoteBody };

export type NoteState =
  | { status: "loading"; note: NoteBody | null; cached: boolean; error: null }
  | { status: "ready"; note: NoteBody; cached: boolean; error: null }
  | { status: "error"; note: NoteBody | null; cached: boolean; error: string };

/**
 * A note's text: the cached copy at once, then a fresh one when the device is online and the vault's
 * copy has a different hash. Offline, a note that was never opened here cannot be shown, and says so.
 */
export function useNote(path: string | undefined, reloadKey = 0): NoteState {
  const online = useSync((s) => s.status === "online");
  const hash = useSync((s) => {
    if (!path) return null;
    for (const f of Object.values(s.entities.vault_files)) if (f.path === path) return f.hash;
    return null;
  });
  const [state, setState] = useState<NoteState>({ status: "loading", note: null, cached: false, error: null });
  useEffect(() => {
    if (!path) return;
    let gone = false;
    setState((s) => (s.note?.path === path ? s : { status: "loading", note: null, cached: false, error: null }));
    void (async () => {
      const cached = await cacheGet(path);
      if (gone) return;
      const fresh = cached && hash && cached.hash === hash;
      if (cached) setState({ status: fresh || !online ? "ready" : "loading", note: cached, cached: true, error: null } as NoteState);
      if (fresh) return;
      if (!online) {
        if (!cached) setState({ status: "error", note: null, cached: false, error: "Offline. This note has not been opened on this device before, so there is no cached copy." });
        return;
      }
      try {
        const r = await vaultRequest<Omit<NoteBody, "at">>("read", { path });
        if (gone) return;
        const note: NoteBody = { ...r, at: Date.now() };
        setState({ status: "ready", note, cached: false, error: null });
        void cachePut(note);
      } catch (err) {
        if (gone) return;
        if (cached) setState({ status: "ready", note: cached, cached: true, error: null });
        else setState({ status: "error", note: null, cached: false, error: (err as Error).message });
      }
    })();
    return () => {
      gone = true;
    };
  }, [path, hash, online, reloadKey]);
  return state;
}

// ---------------------------------------------------------------- search and backlinks

export interface SearchHit {
  path: string;
  title: string;
  line: number;
  text: string;
  from?: "raw" | "archive";
}

/** Title matches at once from synced metadata (works offline), full-text hits as they arrive from the vault. */
export function useVaultSearch(query: string, files: VaultFile[]): { titles: VaultFile[]; hits: SearchHit[]; state: "idle" | "searching" | "done" | "offline" | "error"; error: string | null } {
  const q = query.trim();
  const online = useSync((s) => s.status === "online");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "offline" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const titles = useMemo(() => {
    if (q.length < 2) return [];
    const ql = q.toLowerCase();
    return files.filter((f) => !f.path.startsWith("_Archive/") && (f.title.toLowerCase().includes(ql) || f.path.toLowerCase().includes(ql))).sort((a, b) => b.mtime - a.mtime).slice(0, 12);
  }, [q, files]);
  useEffect(() => {
    if (q.length < 2) {
      setHits([]);
      setState("idle");
      return;
    }
    if (!online) {
      setHits([]);
      setState("offline");
      return;
    }
    let gone = false;
    setState("searching");
    const t = setTimeout(() => {
      vaultRequest<{ hits: SearchHit[] }>("search", { query: q })
        .then((r) => {
          if (gone) return;
          setHits(r.hits ?? []);
          setState("done");
        })
        .catch((e) => {
          if (gone || (e as any).code === "superseded") return;
          setError((e as Error).message);
          setState("error");
        });
    }, 280);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [q, online]);
  return { titles, hits, state, error };
}

export interface Backlink {
  path: string;
  title: string;
  line: number;
  context: string;
}

export function useBacklinks(path: string | undefined): Backlink[] | null {
  const online = useSync((s) => s.status === "online");
  const [list, setList] = useState<Backlink[] | null>(null);
  useEffect(() => {
    setList(null);
    if (!path || !online) return;
    let gone = false;
    vaultRequest<{ backlinks: Backlink[] }>("backlinks", { path }).then((r) => !gone && setList(r.backlinks ?? [])).catch(() => {});
    return () => {
      gone = true;
    };
  }, [path, online]);
  return list;
}

export type { AgentVaultStatus };
