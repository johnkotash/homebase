import { describe, expect, it } from "vitest";
// @ts-ignore plain ESM, shared with the Electron main process
import { isAppLink, registerNotifications } from "../notifyCore.mjs";

/** Stand-ins for Electron's ipcMain, Notification and BrowserWindow: only what the shell uses. */
function harness(opts: { supported?: boolean } = {}) {
  const handlers = new Map<string, (...a: any[]) => any>();
  const listeners = new Map<string, (...a: any[]) => any>();
  const ipcMain = {
    handle: (ch: string, fn: any) => void handlers.set(ch, fn),
    on: (ch: string, fn: any) => void listeners.set(ch, fn),
    removeHandler: (ch: string) => void handlers.delete(ch),
    removeListener: (ch: string) => void listeners.delete(ch),
  };
  const shown: FakeNotification[] = [];
  class FakeNotification {
    static isSupported = () => opts.supported ?? true;
    events = new Map<string, (...a: any[]) => void>();
    visible = false;
    closed = false;
    constructor(public options: { title: string; body: string; silent: boolean }) {}
    on(ev: string, fn: (...a: any[]) => void) {
      this.events.set(ev, fn);
    }
    show() {
      this.visible = true;
      shown.push(this);
    }
    close() {
      this.closed = true;
      this.visible = false;
      this.events.get("close")?.();
    }
    click() {
      this.events.get("click")?.();
    }
  }
  const calls: string[] = [];
  const sent: Array<[string, unknown]> = [];
  const win = {
    minimized: false, destroyed: false,
    webContents: { send: (ch: string, payload: unknown) => void sent.push([ch, payload]) },
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    restore: () => {
      calls.push("restore");
      win.minimized = false;
    },
    show: () => void calls.push("show"),
    focus: () => void calls.push("focus"),
  };
  const logs: unknown[][] = [];
  const reg = registerNotifications({
    ipcMain, Notification: FakeNotification, windowFor: (sender: unknown) => (sender === win.webContents ? win : null), log: (...a: unknown[]) => void logs.push(a),
  });
  const ours = { sender: win.webContents };
  const notify = (payload: unknown, event: unknown = ours) => handlers.get("hb:notify")!(event, payload);
  const dismiss = (key: unknown, event: unknown = ours) => listeners.get("hb:notify-dismiss")!(event, key);
  return { reg, shown, win, calls, sent, logs, notify, dismiss, handlers, listeners };
}

describe("native notifications in the desktop shell", () => {
  it("shows what the web app asks for", () => {
    const h = harness();
    expect(h.notify({ key: "run_1", title: "Claude agent finished", body: "Test 2 received", link: "/chats/thr_1", silent: true })).toBe(true);
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].options).toEqual({ title: "Claude agent finished", body: "Test 2 received", silent: true });
    expect(h.shown[0].visible).toBe(true);
    expect(h.reg.live.size).toBe(1);
  });

  it("a click brings the window forward, restores it if minimized, and tells the web app which session to open", () => {
    const h = harness();
    h.notify({ key: "run_1", title: "Claude agent finished", body: "done", link: "/chats/thr_1" });
    h.win.minimized = true;
    h.shown[0].click();
    expect(h.calls).toEqual(["restore", "show", "focus"]);
    expect(h.sent).toEqual([["hb:open", "/chats/thr_1"]]);
    expect(h.reg.live.size).toBe(0);
  });

  it("a click with no link still focuses the window, and opens nothing", () => {
    const h = harness();
    h.notify({ key: "k", title: "Heads up", body: "" });
    h.shown[0].click();
    expect(h.calls).toEqual(["show", "focus"]);
    expect(h.sent).toEqual([]);
  });

  it("never opens anything but a route inside the app", () => {
    for (const link of ["https://evil.example/", "//evil.example", "/\\evil", "javascript:alert(1)", 42, { href: "/x" }]) {
      const h = harness();
      h.notify({ key: "k", title: "t", body: "b", link });
      h.shown[0].click();
      expect(h.sent).toEqual([]);
    }
    expect(isAppLink("/approvals/apr_1")).toBe(true);
    expect(isAppLink("/")).toBe(true);
  });

  it("one notification per subject: a newer one replaces the old one", () => {
    const h = harness();
    h.notify({ key: "apr_1", title: "Approval needed", body: "first" });
    h.notify({ key: "apr_1", title: "Approval needed", body: "second" });
    expect(h.shown).toHaveLength(2);
    expect(h.shown[0].closed).toBe(true);
    expect(h.shown[1].visible).toBe(true);
    expect(h.reg.live.size).toBe(1);
    expect(h.reg.live.get("apr_1")).toBe(h.shown[1]);
  });

  it("is taken down when the web app says its subject was handled or read", () => {
    const h = harness();
    h.notify({ key: "run_1", title: "a", body: "b" });
    h.notify({ key: "run_2", title: "c", body: "d" });
    h.dismiss("run_1");
    expect(h.shown[0].closed).toBe(true);
    expect(h.shown[1].closed).toBe(false);
    expect([...h.reg.live.keys()]).toEqual(["run_2"]);
    h.dismiss("run_unknown");
    h.dismiss(undefined);
    expect(h.reg.live.size).toBe(1);
  });

  it("forgets a notification the owner closed", () => {
    const h = harness();
    h.notify({ key: "run_1", title: "a", body: "b" });
    h.shown[0].close();
    expect(h.reg.live.size).toBe(0);
  });

  it("ignores requests that do not come from an app window", () => {
    const h = harness();
    expect(h.notify({ key: "k", title: "t", body: "b" }, { sender: {} })).toBe(false);
    expect(h.notify({ key: "k", title: "t", body: "b" }, {})).toBe(false);
    expect(h.shown).toHaveLength(0);
    h.win.destroyed = true;
    expect(h.notify({ key: "k", title: "t", body: "b" })).toBe(false);
  });

  it("reports false when the system cannot show notifications, so the web app falls back to a toast", () => {
    const h = harness({ supported: false });
    expect(h.notify({ key: "k", title: "t", body: "b" })).toBe(false);
    expect(h.shown).toHaveLength(0);
  });

  it("copes with junk: missing fields, wrong types, very long text", () => {
    const h = harness();
    expect(h.notify(undefined)).toBe(true);
    expect(h.notify({ title: 5, body: { a: 1 }, key: null })).toBe(true);
    expect(h.shown[0].options).toEqual({ title: "HomeBase", body: "", silent: false });
    h.notify({ key: "long", title: "T".repeat(500), body: `line one\n\n  line two ${"x".repeat(900)}` });
    const o = h.shown.at(-1)!.options;
    expect(o.title).toHaveLength(120);
    expect(o.body.length).toBeLessThanOrEqual(400);
    expect(o.body.startsWith("line one line two")).toBe(true);
  });

  it("dispose closes what is showing and unregisters", () => {
    const h = harness();
    h.notify({ key: "a", title: "t", body: "b" });
    h.reg.dispose();
    expect(h.shown[0].closed).toBe(true);
    expect(h.reg.live.size).toBe(0);
    expect(h.handlers.size).toBe(0);
    expect(h.listeners.size).toBe(0);
  });
});
