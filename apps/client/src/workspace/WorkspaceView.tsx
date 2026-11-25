"use dom";

import "@xterm/xterm/css/xterm.css";
import { EditorView } from "@codemirror/view";
import { EditorState, type Text } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import { redo, undo } from "@codemirror/commands";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import React, { useCallback, useEffect, useMemo, useRef, useState, type Ref } from "react";
import { useDOMImperativeHandle, type DOMProps } from "expo/dom";
import { detectIndent, languageFor, type EditorLanguage, type FileEntry, type FileListing, type FileRead, type FileRoots, type FileStat } from "@homebase/protocol";
import type { PushEvent, Reply, TermAction, WorkspaceHandle, WorkspaceInit } from "./bridge";
import { LANGUAGE_LABEL, createState, indentConf, indentExtension } from "./editorSetup";
import { KEY_BAR, badName, baseName, fmtSize, fmtTime, joinPath, parentOf, withCtrl, withEol } from "./model";

/**
 * Files, the editor and the terminal on the agent's machine (issue #3). One view for every platform: inline on web
 * and desktop, inside a WebView on Android (Expo DOM component). It talks to the connector only through the
 * functions the screen hands it (`call`, `term`), which go through the hub.
 *
 * Wide screens: the explorer on the left, editor tabs on the right, terminals in a panel below (like VS Code).
 * Phones: one pane at a time (Files, Editor, Terminal) and a key bar under the terminal.
 */

type Props = {
  init: WorkspaceInit;
  call: (op: string, args: Record<string, unknown>) => Promise<Reply>;
  term: (action: TermAction, args: Record<string, unknown>) => Promise<Reply<{ termId?: string; shell?: string; cwd?: string }>>;
  copyText: (text: string) => Promise<void>;
  onDirty: (count: number) => Promise<void>;
  onClose: () => Promise<void>;
  /** Desktop: shown in a panel beside the chat (true) rather than on its own screen. */
  docked?: boolean;
  /** Docked and taking the whole window (the chat is hidden). */
  expanded?: boolean;
  /** Docked: toggles between beside the chat and the whole window. */
  onExpand?: () => Promise<void>;
  ref?: Ref<WorkspaceHandle>;
  dom?: DOMProps;
};

type Tab = {
  path: string;
  name: string;
  lang: EditorLanguage;
  eol: "\n" | "\r\n";
  bom: boolean;
  hash: string | null;
  readOnly: boolean;
  secret: string | null;
  dirty: boolean;
  tabs: boolean;
  indentSize: number;
  /** Shown instead of the editor: binary, too large. */
  note: string | null;
  disk: null | "changed" | "deleted";
};

type TermTab = { key: string; termId: string | null; title: string; cwd: string | null; status: "starting" | "open" | "exited" | "failed"; note?: string };

type Button = { label: string; value: string; kind?: "primary" | "danger" | "plain" };
type DialogSpec = { title: string; body?: string; input?: { value: string; select?: [number, number] }; buttons: Button[] };
type MenuItem = { label: string; run: () => void; danger?: boolean; disabled?: boolean } | "sep";

const C = {
  bg: "#000000", surface: "#0E0E0E", surface2: "#161616", surface3: "#1F1F1F", border: "#262626", borderStrong: "#3A3A3A",
  text: "#FAFAFA", dim: "#A3A3A3", muted: "#6B6B6B", warn: "#E0A33A", danger: "#F0484E",
};

class CallError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export default function WorkspaceView(props: Props) {
  const { init } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1024));
  const wide = width >= 640 && !init.phone;
  const dockedRef = useRef(!!props.docked);
  dockedRef.current = !!props.docked;
  const [pane, setPane] = useState<"files" | "editor" | "terminal">(init.openTerminal ? "terminal" : "files");
  const [roots, setRoots] = useState<FileRoots | null>(null);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [terms, setTerms] = useState<TermTab[]>([]);
  const [activeTerm, setActiveTerm] = useState<string | null>(null);
  const [panel, setPanel] = useState(init.openTerminal);
  const [dialog, setDialog] = useState<{ spec: DialogSpec; resolve: (r: { button: string; input: string }) => void } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [status, setStatus] = useState<{ text: string; tone?: "error" | "ok" } | null>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [ctrl, setCtrl] = useState(false);

  // ---------------------------------------------------------------- plumbing

  const call = useCallback(async <T,>(op: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await props.call(op, args);
    if (!r.ok) throw new CallError(r.error.code, r.error.message);
    return r.result as T;
  }, [props.call]);

  const flash = useCallback((text: string, tone?: "error" | "ok") => {
    setStatus({ text, tone });
    const at = Date.now();
    setTimeout(() => setStatus((s) => (s && Date.now() - at >= 4000 ? null : s)), 4200);
  }, []);

  const ask = useCallback((spec: DialogSpec) => new Promise<{ button: string; input: string }>((resolve) => setDialog({ spec, resolve })), []);

  // The layout follows the view's own width (a panel beside the chat, or the whole window).
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      const onResize = () => setWidth(window.innerWidth);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || window.innerWidth));
    ro.observe(el);
    setWidth(el.clientWidth || window.innerWidth);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- explorer

  const cwd = listing?.path ?? null;
  const listingRef = useRef<FileListing | null>(null);
  listingRef.current = listing;
  const sep = roots?.sep ?? "/";

  const load = useCallback(async (path: string | null, opts: { hidden?: boolean; keepFilter?: boolean } = {}) => {
    setLoading(true);
    try {
      const l = await call<FileListing>("list", { path: path ?? "", hidden: opts.hidden ?? hidden });
      setListing(l);
      setListError(null);
      if (!opts.keepFilter) setFilter("");
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [call, hidden]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await call<FileRoots>("roots");
        setRoots(r);
        if (!r.files) {
          setListError("The file browser is turned off on this connector.");
          return;
        }
      } catch (e) {
        setListError((e as Error).message);
        return;
      }
      // A session's folder that is gone (moved, or on another machine): start at home and say so.
      try {
        if (init.start) {
          setListing(await call<FileListing>("list", { path: init.start, hidden: false }));
          return;
        }
      } catch (e) {
        flash(`${(e as Error).message} Showing your home folder.`, "error");
      }
      await load(null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (listing?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [listing, filter]);

  const isDir = (e: FileEntry) => e.kind === "dir" || (e.kind === "link" && e.target === "dir");

  // ---------------------------------------------------------------- editor

  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const saved = useRef(new Map<string, Text>());
  const tabsRef = useRef<Tab[]>([]);
  tabsRef.current = tabs;
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;

  const patchTab = useCallback((path: string, patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, ...patch } : t))), []);

  const dirtyCount = tabs.filter((t) => t.dirty).length;
  useEffect(() => {
    void props.onDirty(dirtyCount);
    // A browser tab closing with unsaved edits asks first.
    const guard = (e: BeforeUnloadEvent) => {
      if (dirtyCount) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyCount]);

  const stateOf = (path: string) => (activeRef.current === path && view.current ? view.current.state : states.current.get(path));

  const ensureView = useCallback(() => {
    if (view.current || !host.current) return view.current;
    view.current = new EditorView({
      parent: host.current,
      dispatchTransactions: (trs, v) => {
        v.update(trs);
        const path = activeRef.current;
        if (!path) return;
        states.current.set(path, v.state);
        if (trs.some((tr) => tr.docChanged)) {
          const base = saved.current.get(path);
          const dirty = !base || !v.state.doc.eq(base);
          if (tabsRef.current.find((t) => t.path === path)?.dirty !== dirty) patchTab(path, { dirty });
        }
        if (trs.some((tr) => tr.selection || tr.docChanged)) {
          const head = v.state.selection.main.head;
          const line = v.state.doc.lineAt(head);
          setCursor({ line: line.number, col: head - line.from + 1 });
        }
      },
    });
    return view.current;
  }, [patchTab]);

  // Show the active tab's state in the one editor view.
  useEffect(() => {
    const st = active ? states.current.get(active) : null;
    if (!st) return;
    const v = ensureView();
    if (!v) return;
    if (v.state !== st) v.setState(st);
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    setCursor({ line: line.number, col: head - line.from + 1 });
    if (wide || pane === "editor") requestAnimationFrame(() => v.focus());
  }, [active, ensureView, wide, pane]);

  useEffect(() => () => view.current?.destroy(), []);

  const buildState = (r: FileRead, lang: EditorLanguage, indent: { tabs: boolean; size: number }) =>
    createState({
      doc: r.content ?? "", lang, tabs: indent.tabs, indentSize: indent.size, readOnly: r.readOnly,
      extra: init.phone || !wide ? EditorView.lineWrapping : [],
    });

  const openFile = useCallback(async (path: string, confirm = false) => {
    if (tabsRef.current.some((t) => t.path === path)) {
      setActive(path);
      setPane("editor");
      return;
    }
    let r: FileRead;
    try {
      r = await call<FileRead>("read", { path, confirm });
    } catch (e) {
      if (e instanceof CallError && e.code === "secret") {
        const a = await ask({ title: "Open a secret file?", body: e.message, buttons: [{ label: "Cancel", value: "no", kind: "plain" }, { label: "Open", value: "yes", kind: "danger" }] });
        if (a.button === "yes") return openFile(path, true);
        return;
      }
      flash((e as Error).message, "error");
      return;
    }
    const lang = languageFor(r.name, r.content?.slice(0, 200).split("\n")[0] ?? "");
    const indent = detectIndent(r.content ?? "");
    const st = buildState(r, lang, indent);
    states.current.set(path, st);
    saved.current.set(path, st.doc);
    const note = r.content == null ? (r.binary ? `${r.name} is a binary file (${fmtSize(r.size)}), so it cannot be edited here.` : `${r.name} is ${fmtSize(r.size)}: too large for the editor.`) : null;
    setTabs((ts) => [...ts, {
      path, name: r.name, lang, eol: r.eol, bom: r.bom, hash: r.hash, readOnly: r.readOnly, secret: r.secret, dirty: false, tabs: indent.tabs, indentSize: indent.size, note, disk: null,
    }]);
    setActive(path);
    setPane("editor");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, ask, flash, wide]);

  /** Replaces a tab's text with what is on disk now. */
  const reload = useCallback(async (path: string) => {
    let r: FileRead;
    try {
      r = await call<FileRead>("read", { path, confirm: true });
    } catch (e) {
      flash((e as Error).message, "error");
      return;
    }
    const t = tabsRef.current.find((x) => x.path === path);
    if (!t) return;
    const st = buildState(r, t.lang, { tabs: t.tabs, size: t.indentSize });
    states.current.set(path, st);
    saved.current.set(path, st.doc);
    if (activeRef.current === path && view.current) view.current.setState(st);
    patchTab(path, { hash: r.hash, eol: r.eol, bom: r.bom, dirty: false, disk: null, readOnly: r.readOnly });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, flash, patchTab, wide]);

  const save = useCallback(async (path: string, force = false): Promise<boolean> => {
    const t = tabsRef.current.find((x) => x.path === path);
    const st = stateOf(path);
    if (!t || !st || t.note) return false;
    if (t.readOnly) {
      flash("This file is read-only here.", "error");
      return false;
    }
    try {
      const r = await call<FileStat>("write", { path, content: withEol(st.doc.toJSON(), t.eol), baseHash: t.hash, bom: t.bom, force });
      saved.current.set(path, st.doc);
      const cur = stateOf(path);
      patchTab(path, { hash: r.hash, dirty: !!cur && !cur.doc.eq(st.doc), disk: null });
      flash(`Saved ${t.name}`, "ok");
      if (parentOf(path) === listingRef.current?.path) void load(listingRef.current.path, { keepFilter: true });
      return true;
    } catch (e) {
      if (e instanceof CallError && e.code === "conflict") {
        const a = await ask({
          title: "File changed on disk",
          body: `${e.message} Probably an agent edited it. Reload to take the version on disk (your edits are dropped), or overwrite it with yours.`,
          buttons: [{ label: "Cancel", value: "cancel", kind: "plain" }, { label: "Reload", value: "reload" }, { label: "Overwrite", value: "overwrite", kind: "danger" }],
        });
        if (a.button === "reload") await reload(path);
        if (a.button === "overwrite") return save(path, true);
        return false;
      }
      flash((e as Error).message, "error");
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, ask, flash, patchTab, reload, load]);

  const dropTab = useCallback((path: string) => {
    states.current.delete(path);
    saved.current.delete(path);
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.path === path);
      const next = ts.filter((t) => t.path !== path);
      if (activeRef.current === path) setActive(next[Math.min(i, next.length - 1)]?.path ?? null);
      return next;
    });
  }, []);

  const closeTab = useCallback(async (path: string) => {
    const t = tabsRef.current.find((x) => x.path === path);
    if (!t) return;
    if (t.dirty) {
      const a = await ask({
        title: `Save changes to ${t.name}?`, body: "Your changes are lost if you don't save them.",
        buttons: [{ label: "Cancel", value: "cancel", kind: "plain" }, { label: "Don't save", value: "drop", kind: "danger" }, { label: "Save", value: "save", kind: "primary" }],
      });
      if (a.button === "cancel") return;
      if (a.button === "save" && !(await save(path))) return;
    }
    dropTab(path);
  }, [ask, save, dropTab]);

  // Files change under the editor (an agent works in the same folder): checked when the view comes back and every few seconds.
  useEffect(() => {
    const check = async () => {
      if (document.hidden) return;
      const path = activeRef.current;
      const t = tabsRef.current.find((x) => x.path === path);
      if (!path || !t || t.note) return;
      let s: FileStat;
      try {
        s = await call<FileStat>("stat", { path });
      } catch {
        return;
      }
      const now = tabsRef.current.find((x) => x.path === path);
      if (!now || now.hash !== t.hash) return; // saved meanwhile
      if (!s.exists) {
        if (now.disk !== "deleted") patchTab(path, { disk: "deleted" });
      } else if (s.hash && s.hash !== now.hash) {
        if (!now.dirty) {
          await reload(path);
          flash(`${now.name} changed on disk and was reloaded.`);
        } else if (now.disk !== "changed") patchTab(path, { disk: "changed" });
      }
    };
    const timer = setInterval(() => void check(), 5000);
    const onVis = () => void check();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [call, patchTab, reload, flash]);

  // Ctrl/Cmd+S saves, Ctrl+W closes the tab, Ctrl+` toggles the terminal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Beside the chat, the shortcuts are the workspace's only while focus is inside it (Ctrl+S in the chat box is not a save).
      if (dockedRef.current && rootRef.current && !rootRef.current.contains(e.target as Node)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeRef.current) void save(activeRef.current);
      } else if (mod && e.altKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (activeRef.current) void closeTab(activeRef.current);
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setPanel((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, closeTab]);

  const setIndent = (path: string, tabsOn: boolean, size: number) => {
    patchTab(path, { tabs: tabsOn, indentSize: size });
    const effects = indentConf.reconfigure(indentExtension(tabsOn, size));
    if (activeRef.current === path && view.current) view.current.dispatch({ effects });
    else {
      const st = states.current.get(path);
      if (st) states.current.set(path, st.update({ effects }).state);
    }
  };

  const requestClose = useCallback(async () => {
    const dirty = tabsRef.current.filter((t) => t.dirty);
    if (dirty.length) {
      const a = await ask({
        title: dirty.length === 1 ? `Save changes to ${dirty[0].name}?` : `${dirty.length} files have unsaved changes`,
        body: dirty.length === 1 ? undefined : dirty.map((t) => t.name).join(", "),
        buttons: [{ label: "Cancel", value: "cancel", kind: "plain" }, { label: "Don't save", value: "drop", kind: "danger" }, { label: dirty.length === 1 ? "Save" : "Save all", value: "save", kind: "primary" }],
      });
      if (a.button === "cancel") return;
      if (a.button === "save") for (const t of dirty) if (!(await save(t.path))) return;
    }
    void props.onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, save, props.onClose]);

  // ---------------------------------------------------------------- terminal

  const xterms = useRef(new Map<string, { term: Terminal; fit: FitAddon; el: HTMLDivElement; size: string }>());
  const byTermId = useRef(new Map<string, string>());
  const early = useRef(new Map<string, PushEvent[]>());
  const termsRef = useRef<TermTab[]>([]);
  termsRef.current = terms;
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;
  const seq = useRef(0);

  const applyEvent = useCallback((key: string, ev: PushEvent) => {
    const x = xterms.current.get(key);
    if (ev.type === "output" && ev.data) x?.term.write(ev.data);
    else if (ev.type === "reattached") x?.term.reset();
    else if (ev.type === "exit") {
      byTermId.current.delete(ev.termId);
      const why = ev.reason === "offline" ? "the connector went offline" : ev.reason === "lost" ? "it ended while this device was away" : ev.reason === "closed" ? "closed" : `exit code ${ev.code ?? "?"}`;
      x?.term.write(`\r\n\x1b[2m[process ended: ${why}]\x1b[0m\r\n`);
      setTerms((ts) => ts.map((t) => (t.key === key ? { ...t, status: "exited", termId: null } : t)));
    }
  }, []);

  useDOMImperativeHandle(props.ref as Ref<WorkspaceHandle>, () => ({
    push: (events: PushEvent[]) => {
      for (const ev of events) {
        const key = byTermId.current.get(ev.termId);
        if (key) applyEvent(key, ev);
        else early.current.set(ev.termId, [...(early.current.get(ev.termId) ?? []), ev]);
      }
    },
    requestClose: () => void requestClose(),
    showTerminal: () => {
      const t = termsRef.current;
      if (t.length) {
        setPanel(true);
        setPane("terminal");
      } else openTerminalRef.current(listingRef.current?.path ?? init.start);
    },
    showFiles: () => setPane("files"),
  }) as any, [applyEvent, requestClose]);

  const fitTerm = useCallback((key: string) => {
    const x = xterms.current.get(key);
    const t = termsRef.current.find((tt) => tt.key === key);
    if (!x || !x.el.offsetParent) return;
    try {
      x.fit.fit();
    } catch {
      return;
    }
    const size = `${x.term.cols}x${x.term.rows}`;
    if (size !== x.size && t?.termId) void props.term("resize", { termId: t.termId, cols: x.term.cols, rows: x.term.rows });
    x.size = size;
  }, [props.term]);

  const mountTerm = useCallback((key: string, el: HTMLDivElement | null) => {
    if (!el || xterms.current.has(key)) return;
    const term = new Terminal({
      cursorBlink: true, fontSize: init.phone ? 12 : 13, scrollback: 5000, allowProposedApi: false, convertEol: false,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
      theme: { background: "#000000", foreground: "#E5E5E5", cursor: "#FFFFFF", selectionBackground: "#3A3A3A" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    xterms.current.set(key, { term, fit, el, size: "" });
    term.onData((d) => {
      const t = termsRef.current.find((tt) => tt.key === key);
      if (!t?.termId) return;
      let data = d;
      if (ctrlRef.current) {
        data = withCtrl(d);
        setCtrl(false);
      }
      void props.term("input", { termId: t.termId, data });
    });
    // Ctrl+Shift+C / Ctrl+Shift+V copy and paste, as in desktop terminals.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) void props.copyText(sel);
        return false;
      }
      return true;
    });
    try {
      fit.fit();
    } catch {
      // not laid out yet
    }
    const t = termsRef.current.find((tt) => tt.key === key);
    if (!t) return;
    void (async () => {
      const r = await props.term("open", { cwd: t.cwd, cols: term.cols || 80, rows: term.rows || 24 });
      if (!r.ok || !r.result.termId) {
        const msg = r.ok ? "The terminal did not start." : r.error.message;
        term.write(`\x1b[31m${msg}\x1b[0m\r\n`);
        setTerms((ts) => ts.map((x) => (x.key === key ? { ...x, status: "failed", note: msg } : x)));
        return;
      }
      const termId = r.result.termId;
      byTermId.current.set(termId, key);
      xterms.current.get(key)!.size = `${term.cols}x${term.rows}`;
      setTerms((ts) => ts.map((x) => (x.key === key ? { ...x, termId, status: "open", cwd: r.result.cwd ?? x.cwd } : x)));
      for (const ev of early.current.get(termId) ?? []) applyEvent(key, ev);
      early.current.delete(termId);
      requestAnimationFrame(() => fitTerm(key));
      term.focus();
    })();
  }, [init.phone, props.term, props.copyText, applyEvent, fitTerm]);

  const openTerminal = useCallback((dir: string | null) => {
    if (!init.terminal || roots?.terminal === false) {
      flash("The terminal is not available on this connector.", "error");
      return;
    }
    const key = `t${++seq.current}`;
    const title = dir ? baseName(dir) || dir : "~";
    setTerms((ts) => [...ts, { key, termId: null, title, cwd: dir, status: "starting" }]);
    setActiveTerm(key);
    setPanel(true);
    setPane("terminal");
  }, [init.terminal, roots, flash]);
  const openTerminalRef = useRef(openTerminal);
  openTerminalRef.current = openTerminal;

  const closeTerm = useCallback((key: string) => {
    const t = termsRef.current.find((x) => x.key === key);
    if (t?.termId) void props.term("close", { termId: t.termId });
    const x = xterms.current.get(key);
    x?.term.dispose();
    xterms.current.delete(key);
    setTerms((ts) => {
      const i = ts.findIndex((tt) => tt.key === key);
      const next = ts.filter((tt) => tt.key !== key);
      setActiveTerm((cur) => (cur === key ? next[Math.min(i, next.length - 1)]?.key ?? null : cur));
      if (!next.length) setPanel(false);
      return next;
    });
  }, [props.term]);

  // The first terminal, when the screen was opened for one.
  const autoTerm = useRef(false);
  useEffect(() => {
    if (!init.openTerminal || autoTerm.current || !roots) return;
    autoTerm.current = true;
    openTerminal(init.start);
  }, [roots, init.openTerminal, init.start, openTerminal]);

  // Fit the visible terminal to its box whenever the layout changes.
  useEffect(() => {
    if (!activeTerm) return;
    const x = xterms.current.get(activeTerm);
    if (!x) return;
    const ro = new ResizeObserver(() => fitTerm(activeTerm));
    ro.observe(x.el);
    requestAnimationFrame(() => {
      fitTerm(activeTerm);
      x.term.focus();
    });
    return () => ro.disconnect();
  }, [activeTerm, panel, pane, wide, fitTerm]);

  useEffect(() => () => {
    for (const x of xterms.current.values()) x.term.dispose();
  }, []);

  const sendKey = (k: (typeof KEY_BAR)[number]) => {
    if (k.ctrl) {
      setCtrl((c) => !c);
      xterms.current.get(activeTerm ?? "")?.term.focus();
      return;
    }
    const t = terms.find((x) => x.key === activeTerm);
    if (!t?.termId || !k.send) return;
    const data = ctrl && k.send.length === 1 ? withCtrl(k.send) : k.send;
    setCtrl(false);
    void props.term("input", { termId: t.termId, data });
    xterms.current.get(t.key)?.term.focus();
  };

  // ---------------------------------------------------------------- file actions

  const readOnlyHere = (p: string) => (roots?.readOnly ?? []).some((r) => p === r || p.startsWith(r + sep) || p.startsWith(r + "/"));

  const newItem = async (dir: string, kind: "file" | "dir") => {
    const a = await ask({
      title: kind === "file" ? "New file" : "New folder", body: `In ${dir}`, input: { value: "" },
      buttons: [{ label: "Cancel", value: "cancel", kind: "plain" }, { label: "Create", value: "ok", kind: "primary" }],
    });
    if (a.button !== "ok") return;
    const bad = badName(a.input);
    if (bad) return flash(bad, "error");
    const path = joinPath(dir, a.input.trim(), sep);
    try {
      await call("create", { path, kind });
      if (cwd === dir) await load(dir, { keepFilter: true });
      if (kind === "file") await openFile(path);
    } catch (e) {
      flash((e as Error).message, "error");
    }
  };

  const rename = async (e: FileEntry) => {
    const dot = e.name.lastIndexOf(".");
    const a = await ask({
      title: `Rename ${e.name}`, input: { value: e.name, select: [0, !isDir(e) && dot > 0 ? dot : e.name.length] },
      buttons: [{ label: "Cancel", value: "cancel", kind: "plain" }, { label: "Rename", value: "ok", kind: "primary" }],
    });
    if (a.button !== "ok" || a.input.trim() === e.name) return;
    const bad = badName(a.input);
    if (bad) return flash(bad, "error");
    const to = joinPath(parentOf(e.path) ?? "/", a.input.trim(), sep);
    try {
      await call("rename", { from: e.path, to });
      // An open file follows its new name.
      const t = tabsRef.current.find((x) => x.path === e.path);
      if (t) {
        const st = states.current.get(e.path);
        const sv = saved.current.get(e.path);
        if (st) states.current.set(to, st);
        if (sv) saved.current.set(to, sv);
        states.current.delete(e.path);
        saved.current.delete(e.path);
        setTabs((ts) => ts.map((x) => (x.path === e.path ? { ...x, path: to, name: baseName(to), lang: languageFor(to) } : x)));
        if (activeRef.current === e.path) setActive(to);
      }
      await load(cwd, { keepFilter: true });
    } catch (err) {
      flash((err as Error).message, "error");
    }
  };

  const remove = async (e: FileEntry) => {
    const a = await ask({
      title: `Delete ${e.name}?`,
      body: isDir(e) ? `The folder and everything in it is deleted from ${roots?.host ?? "the server"}. This cannot be undone.` : `The file is deleted from ${roots?.host ?? "the server"}. This cannot be undone.`,
      buttons: [{ label: "Cancel", value: "cancel", kind: "plain" }, { label: "Delete", value: "ok", kind: "danger" }],
    });
    if (a.button !== "ok") return;
    try {
      await call("delete", { path: e.path });
      for (const t of tabsRef.current) if (t.path === e.path || t.path.startsWith(e.path + sep)) dropTab(t.path);
      await load(cwd, { keepFilter: true });
    } catch (err) {
      flash((err as Error).message, "error");
    }
  };

  const copyPath = (p: string) => {
    void props.copyText(p).then(() => flash("Path copied", "ok"));
  };

  const entryMenu = (e: FileEntry, x: number, y: number) => {
    const ro = readOnlyHere(e.path) || !!listing?.readOnly;
    const dir = isDir(e);
    const here = dir ? e.path : cwd ?? parentOf(e.path) ?? "/";
    setSelected(e.path);
    setMenu({
      x, y, items: [
        { label: dir ? "Open folder" : "Open", run: () => (dir ? void load(e.path) : void openFile(e.path)) },
        { label: "Open terminal here", run: () => openTerminal(here), disabled: !init.terminal },
        { label: "Copy path", run: () => copyPath(e.path) },
        "sep",
        { label: "New file…", run: () => void newItem(here, "file"), disabled: ro },
        { label: "New folder…", run: () => void newItem(here, "dir"), disabled: ro },
        "sep",
        { label: "Rename…", run: () => void rename(e), disabled: ro },
        { label: "Delete…", run: () => void remove(e), danger: true, disabled: ro },
      ],
    });
  };

  const folderMenu = (x: number, y: number) => {
    if (!cwd) return;
    const ro = !!listing?.readOnly;
    setMenu({
      x, y, items: [
        { label: "New file…", run: () => void newItem(cwd, "file"), disabled: ro },
        { label: "New folder…", run: () => void newItem(cwd, "dir"), disabled: ro },
        { label: "Open terminal here", run: () => openTerminal(cwd), disabled: !init.terminal },
        { label: "Copy path", run: () => copyPath(cwd) },
        "sep",
        { label: hidden ? "Hide hidden files" : "Show hidden files", run: () => toggleHidden() },
        { label: "Refresh", run: () => void load(cwd, { keepFilter: true }) },
      ],
    });
  };

  const toggleHidden = () => {
    const next = !hidden;
    setHidden(next);
    void load(cwd, { hidden: next, keepFilter: true });
  };

  // Right-click opens an entry's menu on desktop. On a phone a tap only opens (a file) or goes in (a folder): the menu
  // is the ⋯ button, so a tap never brings it up by mistake.
  const touchHandlers = (open: (x: number, y: number) => void) => (init.phone ? {} : {
    onContextMenu: (ev: React.MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      open(ev.clientX, ev.clientY);
    },
  });

  // ---------------------------------------------------------------- render

  const activeTab = tabs.find((t) => t.path === active) ?? null;
  const showFiles = wide || pane === "files";
  const showEditor = wide || pane === "editor";
  const showTerm = wide ? panel && terms.length > 0 : pane === "terminal";

  const explorer = (
    <div className="hb-explorer" style={{ display: showFiles ? "flex" : "none", width: wide ? (width < 900 ? 220 : 280) : "100%" }}>
      <div className="hb-row hb-tools">
        <select className="hb-select" value="" aria-label="Go to" onChange={(e) => e.target.value && void load(e.target.value)}>
          <option value="">Go to…</option>
          {init.start ? <option value={init.start}>Session folder</option> : null}
          {(roots?.jumps ?? []).map((j) => <option key={j.path} value={j.path}>{j.label}</option>)}
        </select>
        <button className={`hb-icon ${hidden ? "on" : ""}`} title={hidden ? "Hide hidden files" : "Show hidden files"} onClick={toggleHidden}>.*</button>
        <button className="hb-icon" title="New file" disabled={!cwd || !!listing?.readOnly} onClick={() => cwd && void newItem(cwd, "file")}>+</button>
        <button className="hb-icon" title="New folder" disabled={!cwd || !!listing?.readOnly} onClick={() => cwd && void newItem(cwd, "dir")}>⊞</button>
        <button className="hb-icon" title="Refresh" onClick={() => void load(cwd, { keepFilter: true })}>↻</button>
        {init.terminal ? <button className="hb-icon" title="Open terminal here" onClick={() => openTerminal(cwd)}>&gt;_</button> : null}
      </div>
      <div className="hb-crumbs">
        {listing?.parent ? <button className="hb-crumb up" title="Up one folder" onClick={() => void load(listing.parent)}>↑</button> : null}
        {(listing?.crumbs ?? []).map((c, i, all) => (
          <span key={c.path} className="hb-crumbwrap">
            <button className={`hb-crumb ${i === all.length - 1 ? "cur" : ""}`} onClick={() => void load(c.path)}>{c.label}</button>
            {i < all.length - 1 ? <span className="hb-crumbsep">{sep === "\\" ? "\\" : "/"}</span> : null}
          </span>
        ))}
      </div>
      <input className="hb-filter" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} autoCapitalize="off" />
      {listing?.readOnly ? <div className="hb-note">Read-only here: notes are never changed from the file browser.</div> : null}
      <div className="hb-list" {...touchHandlers(folderMenu)}>
        {listError ? <div className="hb-note error">{listError}</div> : null}
        {loading && !listing ? <div className="hb-note">Loading…</div> : null}
        {shown.map((e) => (
          <div
            key={e.path}
            className={`hb-entry ${selected === e.path ? "sel" : ""} ${tabs.some((t) => t.path === e.path) ? "open" : ""}`}
            onClick={() => {
              setSelected(e.path);
              if (isDir(e)) void load(e.path);
              else void openFile(e.path);
            }}
            {...touchHandlers((x, y) => entryMenu(e, x, y))}
            title={e.path}
          >
            <span className="hb-glyph">{isDir(e) ? "▸" : e.kind === "link" ? "↪" : "·"}</span>
            <span className={`hb-name ${isDir(e) ? "dir" : ""} ${e.hidden ? "hidden" : ""}`}>{e.name}</span>
            <span className="hb-meta">{isDir(e) ? "" : fmtSize(e.size)}</span>
            {wide ? <span className="hb-meta time">{fmtTime(e.mtime)}</span> : null}
            <button className="hb-more" title="More" onClick={(ev) => {
              ev.stopPropagation();
              const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
              entryMenu(e, r.left, r.bottom);
            }}>⋯</button>
          </div>
        ))}
        {listing && !shown.length && !listError ? <div className="hb-note">{filter ? "Nothing matches." : "Empty folder."}</div> : null}
        {listing?.truncated ? <div className="hb-note">Only the first 2000 entries are shown.</div> : null}
      </div>
    </div>
  );

  const editor = (
    <div className="hb-editor" style={{ display: showEditor ? "flex" : "none" }}>
      <div className="hb-tabs">
        {tabs.map((t) => (
          <div key={t.path} className={`hb-tab ${t.path === active ? "cur" : ""}`} onClick={() => setActive(t.path)} title={t.path}
            onAuxClick={(e) => e.button === 1 && void closeTab(t.path)}>
            <span>{t.name}</span>
            <button className="hb-x" title={t.dirty ? "Unsaved. Close" : "Close"} onClick={(e) => {
              e.stopPropagation();
              void closeTab(t.path);
            }}>{t.dirty ? "●" : "×"}</button>
          </div>
        ))}
        {!tabs.length ? <div className="hb-tab empty">No file open</div> : null}
      </div>
      {activeTab ? (
        <div className="hb-row hb-edtools">
          <button className="hb-btn" disabled={!activeTab.dirty || activeTab.readOnly} onClick={() => void save(activeTab.path)} title="Save (Ctrl+S)">Save</button>
          <button className="hb-icon" title="Undo (Ctrl+Z)" onClick={() => view.current && undo(view.current)}>↶</button>
          <button className="hb-icon" title="Redo (Ctrl+Shift+Z)" onClick={() => view.current && redo(view.current)}>↷</button>
          <button className="hb-icon" title="Find and replace (Ctrl+F)" onClick={() => view.current && openSearchPanel(view.current)}>⌕</button>
          <span className="hb-path" title={activeTab.path}>{activeTab.path}</span>
        </div>
      ) : null}
      {activeTab?.disk ? (
        <div className="hb-banner">
          <span>{activeTab.disk === "deleted" ? "This file was deleted or moved on disk." : "This file changed on disk while you were editing."}</span>
          {activeTab.disk === "changed" ? <button className="hb-btn" onClick={() => void reload(activeTab.path)}>Reload (drop mine)</button> : null}
          <button className="hb-btn" onClick={() => patchTab(activeTab.path, { disk: null })}>Keep mine</button>
        </div>
      ) : null}
      {activeTab?.readOnly ? <div className="hb-banner quiet">Read-only: the notes vault is never changed from here.</div> : null}
      {activeTab?.secret ? <div className="hb-banner">May hold secrets. {activeTab.secret}</div> : null}
      <div className="hb-cm" ref={host} style={{ display: activeTab && !activeTab.note ? "block" : "none" }} />
      {activeTab?.note ? <div className="hb-empty">{activeTab.note}</div> : null}
      {!activeTab ? (
        <div className="hb-empty">
          <div>Open a file from the list{wide ? " on the left" : ""}.</div>
          <div className="hb-hint">Ctrl+S save · Ctrl+F find and replace · Ctrl+Z undo · Ctrl+` terminal</div>
        </div>
      ) : null}
      {activeTab && !activeTab.note ? (
        <div className="hb-status">
          <span>Ln {cursor.line}, Col {cursor.col}</span>
          <button className="hb-statusbtn" title="Change indentation" onClick={() => {
            const opts = [["Tabs", true, 4], ["2 spaces", false, 2], ["4 spaces", false, 4], ["8 spaces", false, 8]] as const;
            const r = document.querySelector(".hb-status")?.getBoundingClientRect();
            setMenu({
              x: (r?.left ?? 0) + 80, y: (r?.top ?? 0) - 150,
              items: opts.map(([label, tb, n]) => ({ label: `${label}${activeTab.tabs === tb && (tb || activeTab.indentSize === n) ? "  ✓" : ""}`, run: () => setIndent(activeTab.path, tb, n) })),
            });
          }}>{activeTab.tabs ? "Tabs" : `Spaces: ${activeTab.indentSize}`}</button>
          <span>{activeTab.eol === "\r\n" ? "CRLF" : "LF"}</span>
          <span>{LANGUAGE_LABEL[activeTab.lang]}</span>
        </div>
      ) : null}
    </div>
  );

  const terminal = (
    <div className={`hb-termpanel ${wide ? "docked" : "full"}`} style={{ display: showTerm ? "flex" : "none" }}>
      <div className="hb-tabs term">
        {terms.map((t) => (
          <div key={t.key} className={`hb-tab ${t.key === activeTerm ? "cur" : ""}`} onClick={() => setActiveTerm(t.key)} title={t.cwd ?? "~"}>
            <span>{t.status === "exited" || t.status === "failed" ? "◌ " : ">_ "}{t.title}</span>
            <button className="hb-x" title="Close terminal" onClick={(e) => {
              e.stopPropagation();
              closeTerm(t.key);
            }}>×</button>
          </div>
        ))}
        {init.terminal ? <button className="hb-icon" title="New terminal" onClick={() => openTerminal(cwd ?? init.start)}>+</button> : null}
        {wide ? <button className="hb-icon right" title="Hide panel (Ctrl+`)" onClick={() => setPanel(false)}>⌄</button> : null}
      </div>
      <div className="hb-terms">
        {terms.map((t) => (
          <div key={t.key} className="hb-xterm" style={{ display: t.key === activeTerm ? "block" : "none" }} ref={(el) => mountTerm(t.key, el)} />
        ))}
        {!terms.length ? (
          <div className="hb-empty">
            {init.terminal ? <button className="hb-btn" onClick={() => openTerminal(cwd ?? init.start)}>Open a terminal{cwd ? ` in ${baseName(cwd)}` : ""}</button> : <div>The terminal is not available on this connector.</div>}
          </div>
        ) : null}
      </div>
      {!wide && terms.length ? (
        <div className="hb-keybar">
          {KEY_BAR.map((k) => (
            <button key={k.label} className={`hb-key ${k.ctrl && ctrl ? "on" : ""}`} title={k.title} onMouseDown={(e) => e.preventDefault()} onClick={() => sendKey(k)}>{k.label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div className={`hb-root ${init.phone ? "phone" : ""}`} ref={rootRef} onClick={() => menu && setMenu(null)}>
      <style>{CSS}</style>
      <div className="hb-top">
        {props.docked ? null : <button className="hb-icon back" title="Back" onClick={() => void requestClose()}>←</button>}
        <div className="hb-title">
          <div className="hb-h">{roots?.host ?? "Files"}</div>
          <div className="hb-sub">{init.agentName}{dirtyCount ? ` · ${dirtyCount} unsaved` : ""}</div>
        </div>
        {!wide ? (
          <div className="hb-seg">
            {(["files", "editor", "terminal"] as const).map((p) => (
              <button key={p} className={pane === p ? "on" : ""} onClick={() => {
                setPane(p);
                if (p === "terminal" && !terms.length && init.terminal) openTerminal(cwd ?? init.start);
              }}>
                {p === "files" ? "Files" : p === "editor" ? `Editor${tabs.length ? ` ${tabs.length}` : ""}` : "Terminal"}
              </button>
            ))}
          </div>
        ) : (
          <div className="hb-row">
            {init.terminal ? <button className={`hb-btn ${panel ? "on" : ""}`} onClick={() => (terms.length ? setPanel(!panel) : openTerminal(cwd ?? init.start))}>&gt;_ Terminal</button> : null}
          </div>
        )}
        {props.onExpand ? (
          <button className="hb-icon" title={props.expanded ? "Back beside the chat" : "Full window"} aria-label={props.expanded ? "Back beside the chat" : "Full window"} onClick={() => void props.onExpand?.()}>
            {props.expanded ? "⇲" : "⛶"}
          </button>
        ) : null}
        {props.docked ? <button className="hb-icon" title="Close" aria-label="Close the workspace" onClick={() => void requestClose()}>×</button> : null}
      </div>
      <div className="hb-body">
        {explorer}
        <div className="hb-main" style={{ display: wide || pane !== "files" ? "flex" : "none" }}>
          {editor}
          {terminal}
        </div>
      </div>
      {status ? <div className={`hb-toast ${status.tone ?? ""}`} onClick={() => setStatus(null)}>{status.text}</div> : null}
      {menu ? (
        <div className="hb-menu" style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 230)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 320)) }} onClick={(e) => e.stopPropagation()}>
          {menu.items.map((it, i) => it === "sep" ? <div key={i} className="hb-menusep" /> : (
            <button key={i} className={`hb-menuitem ${it.danger ? "danger" : ""}`} disabled={it.disabled} onClick={() => {
              setMenu(null);
              it.run();
            }}>{it.label}</button>
          ))}
        </div>
      ) : null}
      {dialog ? <Dialog spec={dialog.spec} onDone={(r) => {
        setDialog(null);
        dialog.resolve(r);
      }} /> : null}
    </div>
  );
}

function Dialog({ spec, onDone }: { spec: DialogSpec; onDone: (r: { button: string; input: string }) => void }) {
  const [value, setValue] = useState(spec.input?.value ?? "");
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    if (spec.input?.select) el.setSelectionRange(spec.input.select[0], spec.input.select[1]);
  }, [spec]);
  const primary = spec.buttons.find((b) => b.kind === "primary") ?? spec.buttons.at(-1)!;
  const cancel = spec.buttons.find((b) => b.value === "cancel" || b.value === "no") ?? spec.buttons[0];
  return (
    <div className="hb-scrim" onClick={() => onDone({ button: cancel.value, input: value })}>
      <div className="hb-dialog" role="dialog" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
        if (e.key === "Escape") onDone({ button: cancel.value, input: value });
        if (e.key === "Enter" && spec.input) onDone({ button: primary.value, input: value });
      }}>
        <div className="hb-dtitle">{spec.title}</div>
        {spec.body ? <div className="hb-dbody">{spec.body}</div> : null}
        {spec.input ? <input ref={input} className="hb-filter" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" /> : null}
        <div className="hb-dbtns">
          {spec.buttons.map((b) => <button key={b.value} className={`hb-btn ${b.kind ?? ""}`} autoFocus={!spec.input && b === primary} onClick={() => onDone({ button: b.value, input: value })}>{b.label}</button>)}
        </div>
      </div>
    </div>
  );
}

const CSS = `
html, body, #root { height: 100%; margin: 0; background: ${C.bg}; }
.hb-root { position: relative; display: flex; flex-direction: column; height: 100%; width: 100%; background: ${C.bg}; color: ${C.text};
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; -webkit-tap-highlight-color: transparent; }
.hb-root button { font: inherit; color: inherit; cursor: pointer; }
.hb-root button:disabled { opacity: .35; cursor: default; }
.hb-row { display: flex; align-items: center; gap: 6px; }
.hb-top { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid ${C.border}; min-height: 44px; }
.hb-title { flex: 1; min-width: 0; }
.hb-h { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hb-sub { color: ${C.muted}; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hb-seg { display: flex; background: ${C.surface2}; border: 1px solid ${C.border}; border-radius: 999px; padding: 2px; }
.hb-seg button { background: none; border: 0; padding: 6px 10px; border-radius: 999px; color: ${C.dim}; font-size: 13px; }
.hb-seg button.on { background: ${C.text}; color: #000; }
.hb-icon { background: none; border: 1px solid transparent; border-radius: 8px; min-width: 32px; height: 32px; padding: 0 6px; color: ${C.dim}; font-size: 15px; }
.hb-icon:hover:not(:disabled) { background: ${C.surface3}; color: ${C.text}; }
.hb-icon.on { background: ${C.surface3}; color: ${C.text}; border-color: ${C.borderStrong}; }
.hb-icon.back { font-size: 18px; }
.hb-icon.right { margin-left: auto; }
.hb-btn { background: ${C.surface3}; border: 1px solid ${C.borderStrong}; border-radius: 8px; padding: 5px 12px; font-size: 13px; }
.hb-btn:hover:not(:disabled) { border-color: ${C.dim}; }
.hb-btn.on { background: ${C.text}; color: #000 !important; }
.hb-btn.primary { background: ${C.text}; color: #000 !important; border-color: ${C.text}; }
.hb-btn.danger { border-color: ${C.danger}; color: ${C.danger} !important; }
.hb-btn.plain { background: none; }
.hb-body { flex: 1; display: flex; min-height: 0; }
.hb-explorer { flex-direction: column; border-right: 1px solid ${C.border}; min-height: 0; flex-shrink: 0; }
.hb-tools { padding: 6px 8px; border-bottom: 1px solid ${C.border}; }
.hb-select { flex: 1; min-width: 0; background: ${C.surface2}; color: ${C.text}; border: 1px solid ${C.border}; border-radius: 8px; height: 32px; padding: 0 6px; font: inherit; font-size: 13px; }
.hb-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 1px; padding: 6px 8px 2px; font-size: 12.5px; }
.hb-crumbwrap { display: inline-flex; align-items: center; }
.hb-crumb { background: none; border: 0; padding: 2px 4px; border-radius: 6px; color: ${C.dim}; }
.hb-crumb:hover { background: ${C.surface3}; color: ${C.text}; }
.hb-crumb.cur { color: ${C.text}; font-weight: 600; }
.hb-crumb.up { color: ${C.text}; margin-right: 4px; border: 1px solid ${C.border}; }
.hb-crumbsep { color: ${C.muted}; }
.hb-filter { margin: 6px 8px; background: ${C.surface}; color: ${C.text}; border: 1px solid ${C.border}; border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; outline: none; }
.hb-filter:focus { border-color: ${C.dim}; }
.hb-list { flex: 1; overflow: auto; padding: 2px 4px 24px; }
.hb-entry { display: flex; align-items: center; gap: 8px; padding: 0 6px 0 8px; height: 34px; border-radius: 8px; cursor: pointer; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.hb-entry:hover { background: ${C.surface2}; }
.hb-entry.sel { background: ${C.surface3}; }
.hb-glyph { width: 12px; color: ${C.muted}; text-align: center; }
.hb-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13.5px; }
.hb-name.dir { font-weight: 600; }
.hb-name.hidden { color: ${C.dim}; }
.hb-entry.open .hb-name { text-decoration: underline; text-decoration-color: ${C.muted}; }
.hb-meta { color: ${C.muted}; font-size: 11.5px; white-space: nowrap; }
.hb-meta.time { width: 52px; text-align: right; }
.hb-more { background: none; border: 0; color: ${C.muted}; width: 26px; height: 26px; border-radius: 6px; visibility: hidden; }
.hb-entry:hover .hb-more, .hb-entry.sel .hb-more { visibility: visible; }
@media (hover: none) { .hb-more { visibility: visible; } }
.hb-root.phone .hb-more { visibility: visible; width: 36px; height: 34px; font-size: 18px; }
.hb-note { color: ${C.muted}; font-size: 12.5px; padding: 8px 10px; }
.hb-note.error { color: ${C.danger}; }
.hb-main { flex: 1; min-width: 0; flex-direction: column; }
.hb-editor { flex: 1; min-height: 0; flex-direction: column; }
.hb-tabs { display: flex; align-items: stretch; overflow-x: auto; border-bottom: 1px solid ${C.border}; background: ${C.surface}; min-height: 36px; scrollbar-width: none; }
.hb-tab { display: flex; align-items: center; gap: 6px; padding: 0 6px 0 12px; border-right: 1px solid ${C.border}; color: ${C.dim}; font-size: 13px; white-space: nowrap; cursor: pointer; }
.hb-tab.cur { background: ${C.bg}; color: ${C.text}; box-shadow: inset 0 -2px 0 ${C.text}; }
.hb-tab.empty { color: ${C.muted}; cursor: default; }
.hb-x { background: none; border: 0; width: 22px; height: 22px; border-radius: 6px; color: ${C.muted}; }
.hb-x:hover { background: ${C.surface3}; color: ${C.text}; }
.hb-edtools { padding: 4px 8px; border-bottom: 1px solid ${C.border}; }
.hb-path { flex: 1; min-width: 0; color: ${C.muted}; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; margin-left: 6px; }
.hb-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 12px; background: rgba(224,163,58,.12); border-bottom: 1px solid rgba(224,163,58,.35); color: ${C.warn}; font-size: 12.5px; }
.hb-banner.quiet { background: ${C.surface}; color: ${C.dim}; border-color: ${C.border}; }
.hb-cm { flex: 1; min-height: 0; overflow: hidden; }
.hb-cm .cm-editor { height: 100%; }
.hb-cm .cm-editor.cm-focused { outline: none; }
.hb-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: ${C.muted}; padding: 24px; text-align: center; }
.hb-hint { font-size: 12px; }
.hb-status { display: flex; gap: 14px; align-items: center; justify-content: flex-end; padding: 3px 12px; border-top: 1px solid ${C.border}; color: ${C.muted}; font-size: 12px; }
.hb-statusbtn { background: none; border: 0; padding: 0; color: ${C.dim}; font-size: 12px; }
.hb-statusbtn:hover { color: ${C.text}; text-decoration: underline; }
.hb-termpanel { flex-direction: column; min-height: 0; background: ${C.bg}; }
.hb-termpanel.docked { height: 38%; min-height: 160px; border-top: 1px solid ${C.borderStrong}; }
.hb-termpanel.full { flex: 1; }
.hb-tabs.term { align-items: center; }
.hb-terms { flex: 1; min-height: 0; position: relative; display: flex; }
.hb-xterm { flex: 1; min-width: 0; height: 100%; padding: 4px 0 0 8px; box-sizing: border-box; }
.hb-xterm .xterm { height: 100%; }
.hb-keybar { display: flex; gap: 4px; padding: 6px; overflow-x: auto; border-top: 1px solid ${C.border}; background: ${C.surface}; scrollbar-width: none; }
.hb-key { flex: 0 0 auto; min-width: 42px; height: 36px; background: ${C.surface3}; border: 1px solid ${C.borderStrong}; border-radius: 8px; font-size: 13px; font-family: ui-monospace, monospace; }
.hb-key.on { background: ${C.text}; color: #000 !important; }
.hb-toast { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); max-width: 86%; background: ${C.surface3}; border: 1px solid ${C.borderStrong}; border-radius: 10px; padding: 8px 14px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.6); z-index: 30; }
.hb-toast.error { border-color: ${C.danger}; color: #FFD2D4; }
.hb-menu { position: fixed; z-index: 40; min-width: 210px; background: ${C.surface2}; border: 1px solid ${C.borderStrong}; border-radius: 10px; padding: 4px; box-shadow: 0 12px 32px rgba(0,0,0,.7); }
.hb-menuitem { display: block; width: 100%; text-align: left; background: none; border: 0; padding: 8px 12px; border-radius: 7px; font-size: 13.5px; }
.hb-menuitem:hover:not(:disabled) { background: ${C.surface3}; }
.hb-menuitem.danger { color: ${C.danger}; }
.hb-menusep { height: 1px; background: ${C.border}; margin: 4px 6px; }
.hb-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; }
.hb-dialog { width: 100%; max-width: 420px; background: ${C.surface}; border: 1px solid ${C.borderStrong}; border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.hb-dialog .hb-filter { margin: 0; }
.hb-dtitle { font-weight: 600; font-size: 16px; }
.hb-dbody { color: ${C.dim}; font-size: 13.5px; word-break: break-word; }
.hb-dbtns { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
`;
