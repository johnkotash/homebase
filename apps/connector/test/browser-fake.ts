import type { PermissionMode } from "@homebase/protocol";
import type { ApprovalDecision, ApprovalDraft } from "../src/adapters/types";
import type { BrowserDriver, ElementInfo, LiveFrame, PageFacts, PageInfo, RawInput, Shot, Snapshot, TabInfo } from "../src/browser/driver";
import type { RunBrowser } from "../src/browser/node";

/** A scripted browser for the rules' tests: a few pages, each with the elements a snapshot would list. */

export function el(p: Partial<ElementInfo> & { ref: string }): ElementInfo {
  return {
    tag: "button", type: "", role: p.tag === "a" ? "link" : p.tag === "input" ? "textbox" : "button", name: "", href: "", download: false, target: "",
    autocomplete: "", inputName: "", id: "", placeholder: "", ariaLabel: "", label: "", editable: p.tag === "input" || p.tag === "textarea",
    inForm: false, formAction: "", formMethod: "", submit: false, expander: false, disabled: false, x: 100, y: 100, w: 80, h: 20, ...p,
  };
}

export interface FakePage {
  title: string;
  text?: string;
  elements?: ElementInfo[];
  facts?: Partial<PageFacts>;
  /** Opening this address lands on another one. */
  redirect?: string;
}

const FACTS: PageFacts = { passwordFields: 0, otpFields: 0, captcha: false, controls: 0, textChars: 5000, scrollY: 0, pageHeight: 500, viewportHeight: 500 };

export class FakeDriver implements BrowserDriver {
  running = false;
  version: string | null = "Fake/1.0";
  headless = true;
  note: string | null = null;
  viewport = { width: 1000, height: 500 };
  layout: "desktop" | "phone" = "desktop";
  async setLayout(layout: "desktop" | "phone", size?: { width: number; height: number; scale: number }) {
    this.layout = layout;
    this.viewport = layout === "phone" ? (size ? { width: size.width, height: size.height } : { width: 400, height: 800 }) : { width: 1000, height: 500 };
    this.calls.push(`layout ${layout}${layout === "phone" && size ? ` ${size.width}x${size.height}` : ""}`);
  }
  calls: string[] = [];
  live = false;
  url = "about:blank";
  history: string[] = [];
  focusedRef: string | null = null;
  /** What a click does besides following a link: change the page under test. */
  onClick: Record<string, () => void> = {};
  private frameCb: (f: LiveFrame) => void = () => {};
  private pageCb: (p: PageInfo) => void = () => {};
  private exitCb: () => void = () => {};

  constructor(public pages: Record<string, FakePage>) {}

  private get cur(): FakePage {
    return this.pages[this.url] ?? { title: "" };
  }
  private elem(ref: string): ElementInfo | null {
    return this.cur.elements?.find((e) => e.ref === ref) ?? null;
  }
  private go(url: string) {
    const target = this.pages[url]?.redirect ?? url;
    if (!this.pages[target] && target !== "about:blank") throw new Error("The page did not load (ERR_NAME_NOT_RESOLVED).");
    this.url = target;
    this.pageCb({ url: this.url, title: this.cur.title });
  }

  onFrame(cb: (f: LiveFrame) => void) { this.frameCb = cb; }
  onPage(cb: (p: PageInfo) => void) { this.pageCb = cb; }
  onExit(cb: () => void) { this.exitCb = cb; }
  /** A picture from the browser, as the real driver would deliver one. */
  emitFrame(data: string) { if (this.live) this.frameCb({ data, width: 1000, height: 500 }); }
  crash() { this.running = false; this.exitCb(); }

  async start() { this.calls.push("start"); this.running = true; }
  async stop() { this.calls.push("stop"); this.running = false; this.url = "about:blank"; }
  async page(): Promise<PageInfo> { return { url: this.url, title: this.cur.title }; }
  async navigate(url: string): Promise<PageInfo> { this.calls.push(`navigate ${url}`); this.history.push(this.url); this.go(url); return this.page(); }
  async back(): Promise<PageInfo> { this.calls.push("back"); const prev = this.history.pop(); if (!prev) throw new Error("There is no earlier page in this tab."); this.go(prev); return this.page(); }
  async forward(): Promise<PageInfo> { this.calls.push("forward"); return this.page(); }
  async reload(): Promise<PageInfo> { this.calls.push("reload"); return this.page(); }
  async snapshot(opts: { scope?: "page" | "viewport" } = {}): Promise<Snapshot> {
    this.calls.push(`snapshot ${opts.scope ?? "page"}`);
    const p = this.cur;
    const lines = (p.elements ?? []).map((e) => `[${e.ref}] ${e.role} "${e.name}"${e.href ? ` -> ${e.href}` : ""}`);
    return { url: this.url, title: p.title, text: [...lines, p.text ?? ""].filter(Boolean).join("\n"), truncated: false, facts: { ...FACTS, controls: p.elements?.length ?? 0, ...(p.facts ?? {}) } };
  }
  async describe(ref: string): Promise<ElementInfo | null> { return this.elem(ref); }
  async focused(): Promise<ElementInfo | null> { return this.focusedRef ? this.elem(this.focusedRef) : null; }
  async revealFocused() { this.calls.push("reveal focused"); }
  async click(ref: string): Promise<{ navigated: boolean }> {
    this.calls.push(`click ${ref}`);
    const e = this.elem(ref);
    if (!e) throw new Error("stale");
    const before = this.url;
    if (e.tag === "a" && e.href) { this.history.push(this.url); this.go(e.href); }
    this.onClick[ref]?.();
    if (e.editable) this.focusedRef = ref;
    return { navigated: this.url !== before };
  }
  async type(ref: string, text: string) { this.calls.push(`type ${ref} ${text}`); this.focusedRef = ref; }
  async pressKey(key: string): Promise<{ navigated: boolean }> { this.calls.push(`key ${key}`); return { navigated: false }; }
  async select(ref: string, values: string[]): Promise<string[] | null> { this.calls.push(`select ${ref} ${values.join(",")}`); return values; }
  async scroll(direction: string) { this.calls.push(`scroll ${direction}`); }
  async find(text: string) { const t = this.cur.text ?? ""; return t.includes(text) ? { count: 1, hits: [t] } : { count: 0, hits: [] }; }
  async screenshot(): Promise<Shot> { this.calls.push("screenshot"); return { data: Buffer.from("jpeg"), mime: "image/jpeg", width: 480, height: 240 }; }
  async tabs(): Promise<TabInfo[]> { return this.running ? [{ index: 0, url: this.url, title: this.cur.title, active: true }] : []; }
  async selectTab(): Promise<PageInfo> { return this.page(); }
  async closeTab() {}
  async input(ev: RawInput) { this.calls.push(`input ${JSON.stringify(ev)}`); }
  async setLive(on: boolean) { this.live = on; this.calls.push(`live ${on ? "on" : "off"}`); }
  level = 1;
  async setPictureLevel(level: number) { this.level = level; this.calls.push(`level ${level}`); }
  /** The layout the page in front was loaded in (set by a test). */
  loadedAs: "desktop" | "phone" | null = null;
  pageLayout() { return this.running ? this.loadedAs : null; }
}

export interface TestRun {
  run: RunBrowser;
  events: Array<{ kind: string; data: Record<string, any> }>;
  /** Approvals the node asked for, in order. Answer one with `answer`. */
  asks: Array<{ draft: ApprovalDraft; answer(d: Partial<ApprovalDecision> & { decision: "approve" | "deny" }): void; cancel(): void }>;
  abort: AbortController;
  mode: { value: PermissionMode };
}

/** One run's view of the browser. `auto` answers every approval at once; left out, each waits for the test. */
export function makeRun(opts: { mode?: PermissionMode; auto?: "approve" | "deny"; runId?: string } = {}): TestRun {
  const events: TestRun["events"] = [];
  const asks: TestRun["asks"] = [];
  const abort = new AbortController();
  const mode = { value: opts.mode ?? "manual" as PermissionMode };
  const full = (d: Partial<ApprovalDecision> & { decision: "approve" | "deny" }): ApprovalDecision => ({ message: null, answers: null, remember: false, ...d });
  const run: RunBrowser = {
    runId: opts.runId ?? "run_test", threadId: "thr_test", mode: () => mode.value, signal: abort.signal,
    emit: (kind, data) => void events.push({ kind, data }),
    ask: (draft) => new Promise<ApprovalDecision>((resolve, reject) => {
      asks.push({ draft, answer: (d) => resolve(full(d)), cancel: () => reject(new Error("cancelled")) });
      if (opts.auto) resolve(full({ decision: opts.auto }));
    }),
  };
  return { run, events, asks, abort, mode };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(fn: () => T | undefined | null | false, what = "condition", timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}
