import { describe, expect, it } from "vitest";
import { BrowserControlFrame, BrowserInputFrame, BrowserState, DEFAULT_BROWSER_SETTINGS, InboundFrame, browserTopic, type BrowserFrame } from "@homebase/protocol";
import { connectConnector, connectDevice, makeHub, peer } from "./helpers";

const state = (over: Partial<BrowserState> = {}): BrowserState => ({
  running: true, unavailable: null, seat: "agent", needs: null, url: "https://example.com/", title: "Example Domain", site: "example.com", tabs: 1,
  viewport: { width: 1280, height: 800 }, layout: "desktop", browser: "Chrome/159.0.0.0", headless: false, note: null, budget: { site: "example.com", usedHour: 1, usedDay: 1, nextAt: null },
  settings: DEFAULT_BROWSER_SETTINGS, signedIn: [], runId: null, last: null, viewers: 0, updatedAt: 1, ...over,
});
const picture = (seq: number, data = "AAAA"): BrowserFrame => ({ seq, at: seq, data, width: 1280, height: 800 });
const audit = (hub: ReturnType<typeof makeHub>["hub"]) => hub.store.all<{ action: string; detail: string | null; actor_id: string }>("SELECT action, detail, actor_id FROM audit_log WHERE action LIKE 'browser.%' ORDER BY rowid");

describe("the browser relay in the hub", () => {
  it("carries state and pictures from a connector to the devices watching it, and only to them", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const watching = connectDevice(hub, directory);
    const elsewhere = connectDevice(hub, directory);
    const topic = browserTopic(con.id);

    hub.onFrame(con, { t: "browser.state", state: state() });
    expect(watching.of("browser.state")).toHaveLength(0); // nobody asked yet

    hub.onFrame(watching, { t: "sub", topic });
    // A device that opens the view gets where things stand at once.
    expect(watching.of("browser.state").at(-1)).toMatchObject({ connectorId: con.id, state: { site: "example.com", seat: "agent" } });
    // The connector was told nobody is watching when it first reported, and hears of its audience once.
    expect(con.of("browser.viewers")).toEqual([{ t: "browser.viewers", count: 0 }, { t: "browser.viewers", count: 1 }]);

    hub.onFrame(con, { t: "browser.frame", frame: picture(1) });
    hub.onFrame(con, { t: "browser.frame", frame: picture(2, "BBBB") });
    expect(watching.of("browser.frame").map((f) => f.frame.seq)).toEqual([1, 2]);
    expect(elsewhere.of("browser.frame")).toHaveLength(0);
    expect(elsewhere.of("browser.state")).toHaveLength(0);

    // A second device joining late sees the last picture without waiting for the page to change.
    hub.onFrame(elsewhere, { t: "sub", topic });
    expect(elsewhere.of("browser.frame").map((f) => f.frame.data)).toEqual(["BBBB"]);
    expect(con.of("browser.viewers").at(-1)).toEqual({ t: "browser.viewers", count: 2 });

    hub.onFrame(watching, { t: "unsub", topic });
    hub.detach(elsewhere);
    expect(con.of("browser.viewers").at(-1)).toEqual({ t: "browser.viewers", count: 0 });
  });

  it("passes a watching device's 'picture arrived' to the connector, so it can pace its pictures; nothing is stored", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const watching = connectDevice(hub, directory);
    const stranger = connectDevice(hub, directory);
    hub.onFrame(watching, { t: "sub", topic: browserTopic(con.id) });
    const seq = hub.currentSeq();
    hub.onFrame(con, { t: "browser.frame", frame: { ...picture(7), rtt: 180, level: 1 } });
    // The round trip and the level travel with the picture.
    expect(watching.of("browser.frame").at(-1).frame).toMatchObject({ seq: 7, rtt: 180, level: 1 });
    hub.onFrame(watching, { t: "browser.ack", connectorId: con.id, seq: 7 });
    // A device that is not watching has nothing to acknowledge.
    hub.onFrame(stranger, { t: "browser.ack", connectorId: con.id, seq: 8 });
    expect(con.of("browser.ack")).toEqual([{ t: "browser.ack", seq: 7, deviceId: watching.id }]);
    expect(hub.currentSeq()).toBe(seq);
    expect(audit(hub)).toHaveLength(0);
    expect(InboundFrame.safeParse({ t: "browser.ack", connectorId: con.id, seq: -1 }).success).toBe(false);
  });

  it("stores nothing: no row and no change for a state or a picture", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const dev = connectDevice(hub, directory);
    hub.onFrame(dev, { t: "sub", topic: browserTopic(con.id) });
    const seq = hub.currentSeq();
    const changes = dev.of("changes").length;
    hub.onFrame(con, { t: "browser.state", state: state() });
    hub.onFrame(con, { t: "browser.frame", frame: picture(1) });
    expect(hub.currentSeq()).toBe(seq);
    expect(dev.of("changes")).toHaveLength(changes);
    expect(audit(hub)).toHaveLength(0);
  });

  it("pictures taken during a private sign-in are passed on and never held", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const dev = connectDevice(hub, directory);
    const late = connectDevice(hub, directory);
    const topic = browserTopic(con.id);
    hub.onFrame(dev, { t: "sub", topic });
    hub.onFrame(con, { t: "browser.frame", frame: picture(1, "BEFORE") });
    hub.onFrame(con, { t: "browser.state", state: state({ seat: "signin" }) });
    hub.onFrame(con, { t: "browser.frame", frame: picture(2, "SIGNINPAGE") });
    // The owner, watching, sees the page they are typing into.
    expect(dev.of("browser.frame").at(-1).frame.data).toBe("SIGNINPAGE");
    // A device that opens the view now gets the state, and no picture from before or during the sign-in.
    hub.onFrame(late, { t: "sub", topic });
    expect(late.of("browser.state").at(-1).state.seat).toBe("signin");
    expect(late.of("browser.frame")).toHaveLength(0);
  });

  it("passes a person's hands to the connector and writes down who took the wheel, never what they did", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const dev = connectDevice(hub, directory);
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "take" } });
    hub.onFrame(dev, { t: "browser.input", connectorId: con.id, input: { kind: "mouse", type: "click", x: 0.25, y: 0.5 } });
    hub.onFrame(dev, { t: "browser.input", connectorId: con.id, input: { kind: "text", text: "my secret password" } });
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "goto", url: "https://example.com/private-errand" } });
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "allow_site", site: "example.com" } });
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "release" } });

    expect(con.of("browser.control").map((f) => f.control.action)).toEqual(["take", "goto", "allow_site", "release"]);
    expect(con.of("browser.control")[0]).toMatchObject({ deviceId: dev.id });
    expect(con.of("browser.input")).toEqual([
      { t: "browser.input", deviceId: dev.id, input: { kind: "mouse", type: "click", x: 0.25, y: 0.5 } },
      { t: "browser.input", deviceId: dev.id, input: { kind: "text", text: "my secret password" } },
    ]);
    const rows = audit(hub);
    expect(rows.map((r) => r.action)).toEqual(["browser.take", "browser.allow_site", "browser.release"]);
    expect(rows.every((r) => r.actor_id === dev.id)).toBe(true);
    expect(JSON.parse(rows[1].detail!)).toEqual({ site: "example.com" });
    // Keystrokes and where the owner went are in no table at all.
    const everything = JSON.stringify([hub.store.all("SELECT * FROM audit_log"), hub.store.all("SELECT * FROM changes"), hub.store.all("SELECT * FROM mutations")]);
    expect(everything).not.toContain("my secret password");
    expect(everything).not.toContain("private-errand");
  });

  it("a phone's take-over at its own size, its taps and its streamed keyboard pass through; only the seat is written down", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const dev = connectDevice(hub, directory);
    const size = { width: 411, height: 732, scale: 2 };
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "take", layout: "phone", size } });
    hub.onFrame(dev, { t: "browser.input", connectorId: con.id, input: { kind: "tap", x: 0.5, y: 0.25 } });
    hub.onFrame(dev, { t: "browser.input", connectorId: con.id, input: { kind: "text", text: "hunter2-typed-on-a-phone" } });
    hub.onFrame(dev, { t: "browser.input", connectorId: con.id, input: { kind: "key", type: "press", key: "Backspace", repeat: 3 } });
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "layout", layout: "phone", size: { ...size, height: 420 } } });
    // A connector reports the focused field's kind while the owner drives, and the app hears of it.
    hub.onFrame(dev, { t: "sub", topic: browserTopic(con.id) });
    hub.onFrame(con, { t: "browser.state", state: state({ seat: "signin", layout: "phone", focus: { seq: 2, inputType: "password", secret: true, multiline: false } }) });
    expect(dev.of("browser.state").at(-1).state.focus).toEqual({ seq: 2, inputType: "password", secret: true, multiline: false });
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "done" } });

    expect(con.of("browser.control").map((f) => f.control)).toEqual([
      { action: "take", layout: "phone", size }, { action: "layout", layout: "phone", size: { ...size, height: 420 } }, { action: "done" },
    ]);
    expect(con.of("browser.input").map((f) => f.input.kind)).toEqual(["tap", "text", "key"]);
    expect(audit(hub).map((r) => r.action)).toEqual(["browser.take", "browser.done"]);
    const everything = JSON.stringify([hub.store.all("SELECT * FROM audit_log"), hub.store.all("SELECT * FROM changes"), hub.store.all("SELECT * FROM mutations")]);
    expect(everything).not.toContain("hunter2-typed-on-a-phone");
  });

  it("a device that may not approve may watch and not drive", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const viewer = peer("dev_viewer", "device", false);
    hub.attachDevice(viewer, {});
    hub.onFrame(viewer, { t: "sub", topic: browserTopic(con.id) });
    hub.onFrame(con, { t: "browser.state", state: state() });
    expect(viewer.of("browser.state").at(-1).state.running).toBe(true);
    hub.onFrame(viewer, { t: "browser.control", connectorId: con.id, control: { action: "take" } });
    hub.onFrame(viewer, { t: "browser.input", connectorId: con.id, input: { kind: "text", text: "x" } });
    expect(con.of("browser.control")).toHaveLength(0);
    expect(con.of("browser.input")).toHaveLength(0);
    expect(viewer.of("browser.notice").at(-1).message).toMatch(/may watch the browser but not drive/);
    expect(audit(hub)).toHaveLength(0);
  });

  it("says so when the machine with the browser is gone, and forgets its picture", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const dev = connectDevice(hub, directory);
    const topic = browserTopic(con.id);
    hub.onFrame(dev, { t: "sub", topic });
    hub.onFrame(con, { t: "browser.state", state: state() });
    hub.onFrame(con, { t: "browser.frame", frame: picture(1) });
    hub.detach(con);
    expect(dev.of("browser.state").at(-1)).toEqual({ t: "browser.state", connectorId: con.id, state: null });
    hub.onFrame(dev, { t: "browser.control", connectorId: con.id, control: { action: "take" } });
    expect(dev.of("browser.notice").at(-1).message).toMatch(/offline/);
    const again = connectDevice(hub, directory);
    hub.onFrame(again, { t: "sub", topic });
    expect(again.of("browser.state").at(-1).state).toBeNull();
    expect(again.of("browser.frame")).toHaveLength(0);
  });

  it("a browser notice goes to the device it is for", () => {
    const { hub, directory } = makeHub();
    const con = connectConnector(hub, directory);
    const a = connectDevice(hub, directory);
    const b = connectDevice(hub, directory);
    for (const d of [a, b]) hub.onFrame(d, { t: "sub", topic: browserTopic(con.id) });
    hub.onFrame(con, { t: "browser.notice", deviceId: a.id, message: "Take over first." });
    hub.onFrame(con, { t: "browser.notice", deviceId: null, message: "The browser window was closed." });
    expect(a.of("browser.notice").map((f) => f.message)).toEqual(["Take over first.", "The browser window was closed."]);
    expect(b.of("browser.notice").map((f) => f.message)).toEqual(["The browser window was closed."]);
  });
});

describe("browser frames on the wire", () => {
  it("accepts what the app sends and refuses what it should not", () => {
    expect(InboundFrame.safeParse({ t: "browser.input", connectorId: "con_1", input: { kind: "mouse", type: "click", x: 0.5, y: 0.5 } }).success).toBe(true);
    expect(BrowserInputFrame.safeParse({ t: "browser.input", connectorId: "con_1", input: { kind: "mouse", type: "click", x: 1.5, y: 0.5 } }).success).toBe(false);
    expect(BrowserInputFrame.safeParse({ t: "browser.input", connectorId: "con_1", input: { kind: "script", code: "alert(1)" } }).success).toBe(false);
    expect(BrowserControlFrame.safeParse({ t: "browser.control", connectorId: "con_1", control: { action: "evaluate" } }).success).toBe(false);
    expect(BrowserControlFrame.safeParse({ t: "browser.control", connectorId: "con_1", control: { action: "settings", settings: { budget: { pagesPerHour: 0, minGapSec: 8, pagesPerDay: 200, hours: null } } } }).success).toBe(false);
    expect(BrowserState.safeParse(state()).success).toBe(true);
    // A state has no place for a cookie, a password or page text.
    expect(Object.keys(BrowserState.shape).some((k) => /cookie|password|token|text|html/i.test(k))).toBe(false);
    // The focused field is described by its kind only: there is no place for what is in it.
    expect(BrowserState.safeParse({ ...state(), focus: { seq: 1, inputType: "email", secret: false, multiline: false, value: "me@example.com" } }).data?.focus).toEqual({ seq: 1, inputType: "email", secret: false, multiline: false });
    // An older node sends no focus at all.
    expect(BrowserState.safeParse(state()).data?.focus).toBeUndefined();
    expect(BrowserInputFrame.safeParse({ t: "browser.input", connectorId: "con_1", input: { kind: "tap", x: 0.5, y: 1.2 } }).success).toBe(false);
    expect(BrowserInputFrame.safeParse({ t: "browser.input", connectorId: "con_1", input: { kind: "key", type: "press", key: "Backspace", repeat: 501 } }).success).toBe(false);
    expect(BrowserControlFrame.safeParse({ t: "browser.control", connectorId: "con_1", control: { action: "take", layout: "phone", size: { width: 10, height: 732, scale: 2 } } }).success).toBe(false);
  });
});
