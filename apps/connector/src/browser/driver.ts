import { BROWSER_PICTURE_LEVELS } from "@homebase/protocol";
import { Cdp, launchChrome, type ChromeProcess } from "./cdp";
import { PAGE_SCRIPT } from "./pageScript";

/**
 * What HomeBase can do with one browser, in its own words: go somewhere, read the page as an outline,
 * say what an element really is, click, type, scroll, take a picture, and pass on a person's mouse and
 * keys. Everything above this file (the gate, the seat, the tools) talks to this interface, so the rules
 * are tested against a scripted driver and the real one is only the DevTools plumbing.
 */

export interface PageInfo {
  url: string;
  title: string;
}

export interface PageFacts {
  passwordFields: number;
  otpFields: number;
  captcha: boolean;
  controls: number;
  textChars: number;
  scrollY: number;
  pageHeight: number;
  viewportHeight: number;
}

export interface Snapshot extends PageInfo {
  /** The outline: one line per control ("[e3] button "Search"") and the visible text between them. */
  text: string;
  truncated: boolean;
  facts: PageFacts;
}

/** What a reference really points at, read from the page at the moment of asking. */
export interface ElementInfo {
  ref: string;
  tag: string;
  type: string;
  role: string;
  name: string;
  href: string;
  download: boolean;
  target: string;
  autocomplete: string;
  inputName: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  editable: boolean;
  inForm: boolean;
  formAction: string;
  formMethod: string;
  submit: boolean;
  expander: boolean;
  disabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Shot {
  data: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
}

export interface LiveFrame {
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

/** Mouse, wheel and keys from a person. Positions are in viewport pixels. */
export type RawInput =
  | { kind: "mouse"; type: "down" | "up" | "move"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
  /** A finger's tap: a touch when the page is laid out as on a phone (touch is on there), a left click otherwise. */
  | { kind: "tap"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; dx: number; dy: number }
  | { kind: "key"; type: "down" | "up"; key: string; code?: string; text?: string; modifiers?: number }
  | { kind: "text"; text: string };

export interface BrowserDriver {
  readonly running: boolean;
  /** "Chrome/159.0.0.0", once started. */
  readonly version: string | null;
  readonly headless: boolean;
  readonly note: string | null;
  readonly viewport: { width: number; height: number };
  /**
   * The page as a phone would lay it out (narrow, tall, touch-sized), or as a desktop. Applies to every tab.
   * `size` (phone only): the phone's own screen in CSS pixels and its sharpness; without it 412 × 820.
   */
  setLayout(layout: "desktop" | "phone", size?: { width: number; height: number; scale: number }): Promise<void>;
  readonly layout: "desktop" | "phone";
  start(): Promise<void>;
  stop(): Promise<void>;
  page(): Promise<PageInfo>;
  navigate(url: string): Promise<PageInfo>;
  back(): Promise<PageInfo>;
  forward(): Promise<PageInfo>;
  reload(): Promise<PageInfo>;
  snapshot(opts?: { scope?: "page" | "viewport"; maxChars?: number }): Promise<Snapshot>;
  describe(ref: string, scroll?: boolean): Promise<ElementInfo | null>;
  focused(): Promise<ElementInfo | null>;
  /** Scrolls the field that has the focus into the middle of the page, as a phone's browser does when its keyboard opens. */
  revealFocused(): Promise<void>;
  /** A real mouse click on the element. Resolves once the page has settled; `navigated` says whether the address changed. */
  click(ref: string): Promise<{ navigated: boolean }>;
  type(ref: string, text: string, opts?: { clear?: boolean }): Promise<void>;
  pressKey(key: string): Promise<{ navigated: boolean }>;
  select(ref: string, values: string[]): Promise<string[] | null>;
  scroll(direction: "down" | "up" | "top" | "bottom"): Promise<void>;
  find(text: string): Promise<{ count: number; hits: string[] }>;
  screenshot(opts?: { maxWidth?: number; quality?: number }): Promise<Shot>;
  tabs(): Promise<TabInfo[]>;
  selectTab(index: number): Promise<PageInfo>;
  closeTab(index: number): Promise<void>;
  input(ev: RawInput): Promise<void>;
  /** Turns the live picture on or off. Frames go to `onFrame`. */
  setLive(on: boolean): Promise<void>;
  /** How sharp the live picture is drawn: an index into BROWSER_PICTURE_LEVELS. Optional: a driver without it has one level. */
  setPictureLevel?(level: number): Promise<void>;
  /** The layout the page in front was loaded in (sites send a phone or a computer page by it); null for a blank page. */
  pageLayout?(): "desktop" | "phone" | null;
  onFrame(cb: (f: LiveFrame) => void): void;
  /** Called when the page in front changes address or title, whoever caused it. */
  onPage(cb: (p: PageInfo) => void): void;
  /** Called when the browser goes away without being asked to (the owner closed the window, or it crashed). */
  onExit(cb: () => void): void;
}

export interface CdpDriverOptions {
  exe: string;
  profileDir: string;
  headless?: boolean;
  width?: number;
  height?: number;
  env?: NodeJS.ProcessEnv;
  /** Every request the browser is about to make. False blocks it. Used to keep pages away from private addresses. */
  allowRequest?: (url: string) => boolean;
  /** Device pixels per CSS pixel for a window nobody sees here (see LaunchOptions.scale). */
  scale?: number;
  log?: (...a: unknown[]) => void;
}

interface Tab {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  world: number | null;
  frameId: string | null;
  loading: boolean;
  /** The layout the page in this tab was loaded in (sites pick their phone or desktop page by it). */
  loadedAs?: "desktop" | "phone";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NAV_TIMEOUT = 30_000;

/** Keys the tools and the app may name, with what Chrome wants to hear about each. */
export const KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Space: { key: " ", code: "Space", vk: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
  PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
};

/** The phone layout's page size: the phone's own screen when it says so (within sane bounds), else a common phone's. */
export function phoneViewport(size?: { width: number; height: number } | null): { width: number; height: number } {
  if (!size) return { width: 412, height: 820 };
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
  return { width: clamp(size.width, 320, 1024), height: clamp(size.height, 400, 1600) };
}

/** Most device pixels a phone page may be drawn with: a Fold's cover screen at its own 2.625 fits; its large screen gets about 2. */
export const PHONE_MAX_PIXELS = 2_400_000;

/**
 * The phone layout's device pixel ratio: the phone's own, at most 3, and less on a large screen. Eighth steps (2.625 is common).
 * The live picture has this many pixels per CSS pixel only up to the window's own scale (CdpDriverOptions.scale):
 * Chrome takes it from the window. Measured on a Linux server (Chrome 158, Xvfb, window scale 3): a 411 × 734 page at
 * 2.625 is a 1079 × 1927 picture, 60 to 150 KB at quality 55 to 60 depending on the page.
 */
export function phoneSharpness(viewport: { width: number; height: number }, wanted = 2): number {
  const cap = Math.sqrt(PHONE_MAX_PIXELS / Math.max(1, viewport.width * viewport.height));
  return Math.max(1, Math.floor(Math.min(wanted, 3, cap) * 8 + 1e-9) / 8);
}

/**
 * The user agent of the phone layout: the browser's own, as Chrome on Android writes it, so sites send the page
 * they send a phone (Google's phone page, not its desktop page squeezed into a phone's width). Only the
 * platform words change; the version is the browser's own.
 */
export function mobileUserAgent(ua: string): string {
  const version = /Chrome\/([\d.]+)/.exec(ua)?.[1]?.split(".")[0] ?? "158";
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;
}

/** The client hints that go with mobileUserAgent. */
export function mobileUserAgentMetadata(ua: string) {
  const major = /Chrome\/(\d+)/.exec(ua)?.[1] ?? "158";
  return {
    brands: [{ brand: "Google Chrome", version: major }, { brand: "Chromium", version: major }, { brand: "Not_A Brand", version: "24" }],
    fullVersion: `${major}.0.0.0`, platform: "Android", platformVersion: "10.0.0", architecture: "", model: "K", mobile: true,
  };
}

/** The live picture's JPEG quality and size limit for a layout, a picture level and the window's own scale. */
export function castParams(o: { layout: "desktop" | "phone"; viewport: { width: number; height: number }; pageScale: number; windowScale: number; level: number }): { quality: number; maxWidth: number; maxHeight: number } {
  const lv = BROWSER_PICTURE_LEVELS[Math.max(0, Math.min(BROWSER_PICTURE_LEVELS.length - 1, Math.round(o.level)))];
  // A desktop page is drawn one to one; a phone page as sharp as the page is rendered and the window can show.
  const px = o.layout === "phone" ? Math.max(1, Math.min(o.pageScale, o.windowScale)) : 1;
  const k = Math.max(1, px * lv.scale);
  return { quality: lv.quality, maxWidth: Math.round(o.viewport.width * k), maxHeight: Math.round(o.viewport.height * k) };
}

export class CdpDriver implements BrowserDriver {
  private chrome: ChromeProcess | null = null;
  private cdp: Cdp | null = null;
  private tabList: Tab[] = [];
  private active: Tab | null = null;
  private live = false;
  private frameCb: (f: LiveFrame) => void = () => {};
  private pageCb: (p: PageInfo) => void = () => {};
  private exitCb: () => void = () => {};
  private stopping = false;
  private starting: Promise<void> | null = null;
  viewport: { width: number; height: number };
  layout: "desktop" | "phone" = "desktop";
  private desktop: { width: number; height: number };
  private log: (...a: unknown[]) => void;

  constructor(private o: CdpDriverOptions) {
    this.viewport = this.desktop = { width: o.width ?? 1280, height: o.height ?? 800 };
    this.log = o.log ?? (() => {});
  }

  get running() {
    return !!this.chrome && !this.cdp?.closed;
  }
  get version() {
    return this.chrome?.version ?? null;
  }
  get headless() {
    return this.chrome?.headless ?? !!this.o.headless;
  }
  get note() {
    return this.chrome?.note ?? null;
  }

  onFrame(cb: (f: LiveFrame) => void) {
    this.frameCb = cb;
  }
  onPage(cb: (p: PageInfo) => void) {
    this.pageCb = cb;
  }
  onExit(cb: () => void) {
    this.exitCb = cb;
  }

  // ---------------------------------------------------------------- life cycle

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.starting ??= this.boot().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async boot() {
    this.stopping = false;
    this.tabList = [];
    this.active = null;
    const chrome = await launchChrome({ exe: this.o.exe, profileDir: this.o.profileDir, headless: this.o.headless, env: this.o.env, scale: this.o.scale, ...this.desktop });
    this.chrome = chrome;
    const cdp = (this.cdp = chrome.cdp);
    cdp.on((method, params, sessionId) => this.onEvent(method, params, sessionId));
    void chrome.exited.then(() => {
      const unexpected = !this.stopping && this.chrome === chrome;
      if (this.chrome === chrome) {
        this.chrome = null;
        this.cdp = null;
        this.tabList = [];
        this.active = null;
      }
      if (unexpected) this.exitCb();
    });
    // Nothing is downloaded by this browser.
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const until = Date.now() + 10_000;
    while (!this.active && Date.now() < until) await sleep(50);
    if (!this.active) {
      const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      await this.attach(targetId);
    }
  }

  async stop() {
    this.stopping = true;
    this.live = false;
    const c = this.chrome;
    this.chrome = null;
    this.cdp = null;
    this.tabList = [];
    this.active = null;
    await c?.close();
  }

  private need(): { cdp: Cdp; tab: Tab } {
    if (!this.cdp || this.cdp.closed || !this.active) throw new Error("The browser is not running.");
    return { cdp: this.cdp, tab: this.active };
  }

  private async attach(targetId: string) {
    const cdp = this.cdp;
    if (!cdp || this.tabList.some((t) => t.targetId === targetId)) return;
    const tab: Tab = { targetId, sessionId: "", url: "about:blank", title: "", world: null, frameId: null, loading: false };
    this.tabList.push(tab);
    try {
      const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      tab.sessionId = sessionId;
      await cdp.send("Page.enable", {}, sessionId);
      // One page size whatever the window is, so positions mean the same on every machine.
      await this.applyMetrics(sessionId);
      if (this.o.allowRequest) await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId).catch(() => {});
      const tree = await cdp.send<{ frameTree: { frame: { id: string; url: string } } }>("Page.getFrameTree", {}, sessionId).catch(() => null);
      if (tree) {
        tab.frameId = tree.frameTree.frame.id;
        tab.url = tree.frameTree.frame.url;
      }
      // The newest tab is the one in front: a link that opens a new tab is followed.
      await this.setActive(tab);
    } catch {
      this.tabList = this.tabList.filter((t) => t !== tab);
    }
  }

  private async setActive(tab: Tab) {
    const cdp = this.cdp;
    if (!cdp) return;
    const before = this.active;
    this.active = tab;
    if (before && before !== tab && this.live) await cdp.send("Page.stopScreencast", {}, before.sessionId).catch(() => {});
    await cdp.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
    if (this.live) await this.startCast(tab);
    this.pageCb({ url: tab.url, title: tab.title });
  }

  /** Sharper pixels for the phone layout, which is looked at on a dense screen. */
  private phoneScale = 2;
  private get scale() {
    return this.layout === "phone" ? this.phoneScale : 1;
  }
  /** How sharp the live picture is sent (BROWSER_PICTURE_LEVELS); the node lowers it on a slow link. */
  private level = 1;

  private async applyMetrics(sessionId: string) {
    const phone = this.layout === "phone";
    await this.cdp?.send("Emulation.setDeviceMetricsOverride", { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: this.scale, mobile: phone }, sessionId).catch(() => {});
    await this.cdp?.send("Emulation.setTouchEmulationEnabled", { enabled: phone, ...(phone ? { maxTouchPoints: 5 } : {}) }, sessionId).catch(() => {});
    // A phone's page, from the next page on: sites decide by the user agent. An empty one puts the browser's own back.
    const ua = this.chrome?.userAgent ?? "";
    if (phone && ua) await this.cdp?.send("Emulation.setUserAgentOverride", { userAgent: mobileUserAgent(ua), platform: "Linux armv8l", userAgentMetadata: mobileUserAgentMetadata(ua) }, sessionId).catch(() => {});
    else await this.cdp?.send("Emulation.setUserAgentOverride", { userAgent: "" }, sessionId).catch(() => {});
  }

  async setLayout(layout: "desktop" | "phone", size?: { width: number; height: number; scale: number }) {
    const viewport = layout === "phone" ? phoneViewport(size) : this.desktop;
    const scale = layout === "phone" ? phoneSharpness(viewport, size?.scale) : 1;
    if (layout === this.layout && viewport.width === this.viewport.width && viewport.height === this.viewport.height && scale === this.scale) return;
    this.layout = layout;
    this.viewport = viewport;
    this.phoneScale = layout === "phone" ? scale : this.phoneScale;
    for (const tab of this.tabList) await this.applyMetrics(tab.sessionId);
    const tab = this.active;
    if (this.live && tab && this.cdp) {
      await this.cdp.send("Page.stopScreencast", {}, tab.sessionId).catch(() => {});
      await this.startCast(tab);
    }
  }

  private startCast(tab: Tab) {
    const p = castParams({ layout: this.layout, viewport: this.viewport, pageScale: this.scale, windowScale: this.chrome?.scale ?? 1, level: this.level });
    return this.cdp?.send("Page.startScreencast", { format: "jpeg", ...p, everyNthFrame: 1 }, tab.sessionId).catch(() => {});
  }

  pageLayout(): "desktop" | "phone" | null {
    const tab = this.active;
    return tab?.loadedAs && /^https?:/i.test(tab.url) ? tab.loadedAs : null;
  }

  async setPictureLevel(level: number) {
    const next = Math.max(0, Math.min(BROWSER_PICTURE_LEVELS.length - 1, Math.round(level)));
    if (next === this.level) return;
    this.level = next;
    const tab = this.active;
    if (this.live && tab && this.cdp) {
      await this.cdp.send("Page.stopScreencast", {}, tab.sessionId).catch(() => {});
      await this.startCast(tab);
    }
  }

  private onEvent(method: string, params: any, sessionId: string | undefined) {
    const cdp = this.cdp;
    if (!cdp) return;
    if (method === "Target.targetCreated") {
      if (params.targetInfo?.type === "page") void this.attach(params.targetInfo.targetId);
      return;
    }
    if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
      const gone = this.tabList.find((t) => t.targetId === params.targetId);
      if (!gone) return;
      this.tabList = this.tabList.filter((t) => t !== gone);
      if (this.active === gone) {
        this.active = null;
        const next = this.tabList.at(-1);
        if (next) void this.setActive(next);
      }
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const tab = this.tabList.find((t) => t.targetId === params.targetInfo?.targetId);
      if (tab && typeof params.targetInfo.title === "string" && params.targetInfo.title !== tab.title) {
        tab.title = params.targetInfo.title;
        if (tab === this.active) this.pageCb({ url: tab.url, title: tab.title });
      }
      return;
    }
    const tab = sessionId ? this.tabList.find((t) => t.sessionId === sessionId) : undefined;
    if (!tab) return;
    switch (method) {
      case "Fetch.requestPaused": {
        const url = String(params.request?.url ?? "");
        const ok = !this.o.allowRequest || /^(data|blob|about|chrome-extension):/i.test(url) || this.o.allowRequest(url);
        void cdp.send(ok ? "Fetch.continueRequest" : "Fetch.failRequest", ok ? { requestId: params.requestId } : { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
        return;
      }
      case "Page.frameStartedLoading":
        if (params.frameId === tab.frameId) tab.loading = true;
        return;
      case "Page.frameNavigated":
        if (!params.frame?.parentId) {
          tab.frameId = params.frame.id;
          tab.url = String(params.frame.url ?? "");
          tab.world = null;
          tab.loadedAs = this.layout;
          if (tab === this.active) this.pageCb({ url: tab.url, title: tab.title });
        }
        return;
      case "Page.navigatedWithinDocument":
        if (params.frameId === tab.frameId) {
          tab.url = String(params.url ?? tab.url);
          if (tab === this.active) this.pageCb({ url: tab.url, title: tab.title });
        }
        return;
      case "Page.loadEventFired":
      case "Page.frameStoppedLoading":
        if (method === "Page.loadEventFired" || params.frameId === tab.frameId) tab.loading = false;
        // The page has its real title now, whoever sent it here (a click of the owner's included).
        if (method === "Page.loadEventFired") void this.readTitle(tab);
        return;
      case "Page.javascriptDialogOpening":
        // An alert would stop the page and everything waiting on it. Leaving a page is allowed; anything else is declined.
        void cdp.send("Page.handleJavaScriptDialog", { accept: params.type === "beforeunload" }, sessionId).catch(() => {});
        return;
      case "Page.screencastFrame":
        void cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, sessionId).catch(() => {});
        if (tab === this.active && this.live) {
          this.frameCb({ data: params.data, width: Math.round(params.metadata?.deviceWidth ?? this.viewport.width), height: Math.round(params.metadata?.deviceHeight ?? this.viewport.height) });
        }
        return;
    }
  }

  // ---------------------------------------------------------------- the page's own view of itself

  /** Runs an expression in HomeBase's isolated world of the page in front. The page's scripts cannot reach it. */
  private async evaluate<T>(expression: string): Promise<T> {
    const { cdp, tab } = this.need();
    for (let attempt = 0; ; attempt++) {
      try {
        if (tab.world == null) {
          if (!tab.frameId) {
            const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, tab.sessionId);
            tab.frameId = tree.frameTree.frame.id;
          }
          const w = await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: tab.frameId, worldName: "homebase" }, tab.sessionId);
          await cdp.send("Runtime.evaluate", { expression: PAGE_SCRIPT, contextId: w.executionContextId, returnByValue: true }, tab.sessionId);
          tab.world = w.executionContextId;
        }
        const r = await cdp.send<{ result: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
          "Runtime.evaluate", { expression, contextId: tab.world, returnByValue: true, awaitPromise: true }, tab.sessionId,
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "The page script failed.");
        return r.result.value as T;
      } catch (err) {
        // The page moved on and took its world with it: make a new one, once.
        tab.world = null;
        if (attempt >= 1 || !/context|world|frame/i.test((err as Error).message)) throw err;
      }
    }
  }

  private async settle(tab: Tab, maxMs = NAV_TIMEOUT) {
    const until = Date.now() + maxMs;
    await sleep(120);
    while (tab.loading && Date.now() < until && this.running) await sleep(80);
    await sleep(250);
  }

  private async readTitle(tab: Tab) {
    const r = await this.cdp?.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.title", returnByValue: true }, tab.sessionId).catch(() => null);
    if (!r || typeof r.result.value !== "string" || r.result.value === tab.title) return;
    tab.title = r.result.value;
    if (tab === this.active) this.pageCb({ url: tab.url, title: tab.title });
  }

  async page(): Promise<PageInfo> {
    const { cdp, tab } = this.need();
    const r = await cdp.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.title", returnByValue: true }, tab.sessionId).catch(() => null);
    if (r && typeof r.result.value === "string") tab.title = r.result.value;
    return { url: tab.url, title: tab.title };
  }

  async navigate(url: string): Promise<PageInfo> {
    const { cdp, tab } = this.need();
    tab.loading = true;
    const r = await cdp.send<{ errorText?: string }>("Page.navigate", { url }, tab.sessionId);
    if (r.errorText && r.errorText !== "net::ERR_ABORTED") {
      tab.loading = false;
      throw new Error(r.errorText === "net::ERR_BLOCKED_BY_CLIENT" ? "That address is blocked by HomeBase." : `The page did not load (${r.errorText.replace(/^net::/, "")}).`);
    }
    await this.settle(tab);
    return this.page();
  }

  private async history(delta: number): Promise<PageInfo> {
    const { cdp, tab } = this.need();
    const h = await cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory", {}, tab.sessionId);
    const entry = h.entries[h.currentIndex + delta];
    if (!entry) throw new Error(delta < 0 ? "There is no earlier page in this tab." : "There is no later page in this tab.");
    tab.loading = true;
    await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, tab.sessionId);
    await this.settle(tab);
    return this.page();
  }
  back() {
    return this.history(-1);
  }
  forward() {
    return this.history(1);
  }

  async reload(): Promise<PageInfo> {
    const { cdp, tab } = this.need();
    tab.loading = true;
    await cdp.send("Page.reload", {}, tab.sessionId);
    await this.settle(tab);
    return this.page();
  }

  async snapshot(opts: { scope?: "page" | "viewport"; maxChars?: number } = {}): Promise<Snapshot> {
    const s = await this.evaluate<Snapshot>(`__hb.snapshot(${JSON.stringify(opts)})`);
    const { tab } = this.need();
    tab.title = s.title;
    return s;
  }

  describe(ref: string, scroll = false): Promise<ElementInfo | null> {
    return this.evaluate<ElementInfo | null>(`__hb.describe(${JSON.stringify(ref)}, ${scroll ? "true" : "false"})`);
  }

  focused(): Promise<ElementInfo | null> {
    return this.evaluate<ElementInfo | null>("__hb.focused()");
  }

  async revealFocused(): Promise<void> {
    await this.evaluate<boolean>(
      "(() => { const a = document.activeElement; if (!a || a === document.body || !a.scrollIntoView) return false; a.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); return true; })()",
    );
  }

  private async mouseClick(x: number, y: number) {
    const { cdp, tab } = this.need();
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, tab.sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, tab.sessionId);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, tab.sessionId);
  }

  /** Runs something that may move the page, waits for it to settle, and says whether the address changed. */
  private async acting(fn: () => Promise<void>): Promise<{ navigated: boolean }> {
    const before = this.need().tab;
    const url = before.url;
    await fn();
    await sleep(350);
    // A click may have opened a new tab, which is then the one in front.
    const now = this.active ?? before;
    if (now.loading) await this.settle(now);
    return { navigated: now !== before || now.url !== url };
  }

  async click(ref: string): Promise<{ navigated: boolean }> {
    const el = await this.describe(ref, true);
    if (!el) throw new Error(`Nothing on the page has the reference ${ref} any more. Take a new snapshot.`);
    if (!el.w && !el.h) throw new Error(`"${el.name}" is not visible on the page.`);
    return this.acting(() => this.mouseClick(el.x, el.y));
  }

  async type(ref: string, text: string, opts: { clear?: boolean } = {}) {
    const { cdp, tab } = this.need();
    const ok = await this.evaluate<boolean>(`__hb.focus(${JSON.stringify(ref)}, ${opts.clear === false ? "false" : "true"})`);
    if (!ok) throw new Error(`Nothing on the page has the reference ${ref} any more. Take a new snapshot.`);
    if (text) await cdp.send("Input.insertText", { text }, tab.sessionId);
    else await this.rawKey("Backspace");
    await sleep(120);
  }

  private async rawKey(name: string) {
    const { cdp, tab } = this.need();
    const k = KEYS[name];
    if (!k) throw new Error(`Unknown key "${name}". Known keys: ${Object.keys(KEYS).join(", ")}.`);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await cdp.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) }, tab.sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, tab.sessionId);
  }

  pressKey(key: string): Promise<{ navigated: boolean }> {
    return this.acting(() => this.rawKey(key));
  }

  select(ref: string, values: string[]): Promise<string[] | null> {
    return this.evaluate<string[] | null>(`__hb.select(${JSON.stringify(ref)}, ${JSON.stringify(values)})`);
  }

  async scroll(direction: "down" | "up" | "top" | "bottom") {
    const { cdp, tab } = this.need();
    if (direction === "top" || direction === "bottom") {
      await cdp.send("Runtime.evaluate", { expression: `window.scrollTo({ top: ${direction === "top" ? 0 : "document.documentElement.scrollHeight"}, behavior: "instant" })` }, tab.sessionId);
    } else {
      const dy = Math.round(this.viewport.height * 0.8) * (direction === "down" ? 1 : -1);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: this.viewport.width / 2, y: this.viewport.height / 2, deltaX: 0, deltaY: dy }, tab.sessionId);
    }
    await sleep(450);
  }

  find(text: string): Promise<{ count: number; hits: string[] }> {
    return this.evaluate(`__hb.find(${JSON.stringify(text)})`);
  }

  async screenshot(opts: { maxWidth?: number; quality?: number } = {}): Promise<Shot> {
    const { cdp, tab } = this.need();
    const scale = Math.min(this.scale, (opts.maxWidth ?? this.viewport.width) / this.viewport.width);
    const r = await cdp.send<{ data: string }>("Page.captureScreenshot", {
      format: "jpeg", quality: opts.quality ?? 60, clip: { x: 0, y: 0, width: this.viewport.width, height: this.viewport.height, scale },
    }, tab.sessionId);
    return { data: Buffer.from(r.data, "base64"), mime: "image/jpeg", width: Math.round(this.viewport.width * scale), height: Math.round(this.viewport.height * scale) };
  }

  async tabs(): Promise<TabInfo[]> {
    return this.tabList.map((t, index) => ({ index, url: t.url, title: t.title, active: t === this.active }));
  }

  async selectTab(index: number): Promise<PageInfo> {
    const tab = this.tabList[index];
    if (!tab) throw new Error(`There is no tab ${index}.`);
    await this.setActive(tab);
    return this.page();
  }

  async closeTab(index: number) {
    const tab = this.tabList[index];
    if (!tab) throw new Error(`There is no tab ${index}.`);
    if (this.tabList.length === 1) throw new Error("The last tab stays open.");
    await this.cdp?.send("Target.closeTarget", { targetId: tab.targetId });
    await sleep(200);
  }

  async input(ev: RawInput) {
    const { cdp, tab } = this.need();
    const s = tab.sessionId;
    switch (ev.kind) {
      case "mouse": {
        const type = ev.type === "down" ? "mousePressed" : ev.type === "up" ? "mouseReleased" : "mouseMoved";
        const button = ev.type === "move" ? "none" : ev.button ?? "left";
        await cdp.send("Input.dispatchMouseEvent", { type, x: ev.x, y: ev.y, button, clickCount: ev.type === "move" ? 0 : ev.clicks ?? 1 }, s);
        return;
      }
      case "tap":
        if (this.layout === "phone") {
          // A real touch: the page sees touchstart/touchend and Chrome makes the click from them, as on a phone.
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: ev.x, y: ev.y, radiusX: 4, radiusY: 4, force: 1, id: 1 }] }, s);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
        } else {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ev.x, y: ev.y, button: "none", clickCount: 0 }, s);
          await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: ev.x, y: ev.y, button: "left", clickCount: 1 }, s);
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ev.x, y: ev.y, button: "left", clickCount: 1 }, s);
        }
        return;
      case "wheel":
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy }, s);
        return;
      case "text":
        if (ev.text) await cdp.send("Input.insertText", { text: ev.text }, s);
        return;
      case "key": {
        const k = KEYS[ev.key] ?? (ev.key === " " ? KEYS.Space : undefined);
        const printable = !k && ev.key.length === 1 && !(ev.modifiers && ev.modifiers & 6);
        const text = ev.type === "down" ? (k?.text ?? (printable ? ev.text ?? ev.key : undefined)) : undefined;
        const vk = k?.vk ?? (ev.key.length === 1 ? ev.key.toUpperCase().charCodeAt(0) : 0);
        await cdp.send("Input.dispatchKeyEvent", {
          type: ev.type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown", key: k?.key ?? ev.key, code: k?.code ?? ev.code ?? "",
          windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: ev.modifiers ?? 0, ...(text ? { text } : {}),
        }, s);
        return;
      }
    }
  }

  async setLive(on: boolean) {
    if (this.live === on) return;
    this.live = on;
    const tab = this.active;
    if (!this.cdp || !tab) return;
    if (on) await this.startCast(tab);
    else await this.cdp.send("Page.stopScreencast", {}, tab.sessionId).catch(() => {});
  }
}
