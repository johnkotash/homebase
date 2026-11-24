import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BROWSER_APPROVAL, BROWSER_CAPABILITY, DEFAULT_BROWSER_BUDGET, type BrowserToDevice } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { createMockAdapter } from "../src/adapters/mock";
import { BrowserService, mergeExtraMcp } from "../src/browser/service";
import { MOCK_AGENTS } from "../src/config";
import { HubLink } from "../src/HubLink";
import { FakeDriver, el, makeRun } from "./browser-fake";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

/** The whole path with real sockets: browser service -> connector link -> hub -> a paired device, and back. */

const PAGES = {
  "https://example.com/": { title: "Example Domain", text: "This domain is for use in examples.", elements: [el({ ref: "e1", tag: "button", name: "Subscribe to updates" })] },
  "https://example.org/": { title: "Example Org", text: "Another page." },
};

let cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function boot() {
  const app: HubApp = await bootHub();
  const { token } = pairToken(app, "connector", "browser-connector");
  const driver = new FakeDriver(PAGES);
  let saved: any = { settings: { budget: { ...DEFAULT_BROWSER_BUDGET, minGapSec: 0, hours: null }, actSites: [], blockedSites: [] }, signedIn: {}, ledger: {} };
  const uploads: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "hb-browser-test-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const service = new BrowserService({
    dataDir, driver, env: {}, log: () => {},
    store: { load: () => saved, save: (s) => void (saved = s) },
    hub: () => ({ url: app.url, token }),
  });
  const link = new HubLink({
    hubUrl: app.url, token, name: "browser-connector", log: () => {},
    agents: MOCK_AGENTS.slice(0, 1).map((a) => ({ ...a, capabilities: [...(a.capabilities ?? []), ...service.capabilities], adapter: createMockAdapter({ speed: 0.01 }) })),
    onReady: () => service.onReady(),
    onBrowser: (f) => service.onHubFrame(f),
  });
  service.attach((f) => link.sendBrowser(f));
  link.start();
  await link.whenReady();
  const device = await connectDevice(app, "Phone");
  cleanup.push(() => device.client.stop(), () => link.stop(), () => service.stop(), () => app.close());
  const got: BrowserToDevice[] = [];
  const stop = device.client.watchBrowser(link.connectorId!, (m) => void got.push(m));
  cleanup.push(stop);
  const states = () => got.filter((m): m is Extract<BrowserToDevice, { t: "browser.state" }> => m.t === "browser.state");
  const frames = () => got.filter((m): m is Extract<BrowserToDevice, { t: "browser.frame" }> => m.t === "browser.frame");
  return { app, service, driver, link, device, got, states, frames, uploads, connectorId: link.connectorId! };
}

describe("the browser, through the hub", () => {
  it("an agent with the browser says so in its registration", async () => {
    const { device } = await boot();
    const agent = await waitFor(() => device.list("agents").find((a) => (a.capabilities ?? []).includes(BROWSER_CAPABILITY)), "an agent with the browser");
    expect(agent.connectorId).toBeTruthy();
  });

  it("the phone sees what the agent's browser is doing, live: state and pictures", async () => {
    const { service, driver, states, frames, app } = await boot();
    // Opening the view is answered with where things stand: a browser that is closed until somebody needs it.
    await waitFor(() => states().find((s) => s.state && !s.state.running), "the first state");
    const r = makeRun();
    const out = await service.node.open(r.run, "https://example.com/");
    expect(out.isError).toBeFalsy();
    await waitFor(() => states().find((s) => s.state?.running && s.state.site === "example.com" && s.state.viewers === 1), "the page in the app");
    // The node heard it has an audience and switched the picture on.
    await waitFor(() => driver.live, "the live picture");
    driver.emitFrame("ZnJhbWUx");
    const f = await waitFor(() => frames()[0], "a picture on the phone");
    expect(f.frame).toMatchObject({ data: "ZnJhbWUx", width: 1000, height: 500 });
    // The step's small picture went to the artifact store the image work uses, and the timeline row points at it.
    const shotId = r.events.find((e) => e.data.browser?.action === "Opened")?.data.browser.shotId;
    expect(shotId).toMatch(/^art_/);
    expect(app.hub.store.get<{ mime: string }>("SELECT mime FROM artifacts WHERE id = ?", shotId)).toEqual({ mime: "image/jpeg" });
  });

  it("the owner takes over from the phone, drives, and hands back; the agent waits in between", async () => {
    const { service, driver, device, states, connectorId, app } = await boot();
    const r = makeRun();
    await service.node.open(r.run, "https://example.com/");
    expect(device.client.browserControl(connectorId, { action: "take" })).toBe(true);
    await waitFor(() => states().at(-1)?.state?.seat === "owner", "the seat with the owner");

    let done = false;
    const waiting = service.node.snapshot(r.run).then((x) => ((done = true), x));
    device.client.browserInput(connectorId, { kind: "mouse", type: "click", x: 0.1, y: 0.2 });
    device.client.browserInput(connectorId, { kind: "text", text: "typed by hand" });
    device.client.browserControl(connectorId, { action: "goto", url: "example.org" });
    await waitFor(() => driver.url === "https://example.org/", "the owner's page");
    const inputs = driver.calls.filter((c) => c.startsWith("input")).map((c) => JSON.parse(c.slice(6)));
    expect(inputs.filter((i) => i.kind === "mouse").map((i) => [i.type, i.x, i.y])).toEqual([["move", 100, 100], ["down", 100, 100], ["up", 100, 100]]);
    expect(inputs.at(-1)).toEqual({ kind: "text", text: "typed by hand" });
    expect(done).toBe(false);

    device.client.browserControl(connectorId, { action: "release" });
    const out = await waiting;
    expect(out.text).toContain("Page: Example Org");
    await waitFor(() => states().at(-1)?.state?.seat === "agent", "the seat back with the agent");
    // The hub wrote down the two seat changes and nothing the owner typed or opened.
    const rows = app.hub.store.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'browser.%' ORDER BY rowid").map((x) => x.action);
    expect(rows).toEqual(["browser.take", "browser.release"]);
    expect(JSON.stringify(app.hub.store.all("SELECT * FROM audit_log"))).not.toContain("typed by hand");
  });

  it("a refusal comes back to the device that asked", async () => {
    const { device, got, connectorId } = await boot();
    device.client.browserControl(connectorId, { action: "goto", url: "https://example.org/" });
    const notice = await waitFor(() => got.find((m) => m.t === "browser.notice"), "the notice");
    expect(notice).toMatchObject({ message: expect.stringMatching(/Take over first/) });
  });

  it("the browser tools reach an agent through the same hook as the other tools, with their own token", async () => {
    const { service } = await boot();
    const r = makeRun();
    const ctx: any = { run: { id: "run_x", threadId: "thr_x", prompt: "", options: {} }, signal: r.abort.signal, emit: r.run.emit, requestApproval: r.run.ask, status() {} };
    const other = async () => ({ servers: { images: { type: "http", url: "http://127.0.0.1:1/images" } }, release() {} });
    const binding = await mergeExtraMcp(other, service.extraMcp)(ctx, { cwd: process.cwd(), mode: () => "manual" });
    expect(Object.keys(binding.servers).sort()).toEqual(["browser", "images"]);
    const server = binding.servers.browser as { url: string; headers: { Authorization: string } };
    const call = (auth: string | null, body: unknown) => fetch(server.url, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
    });
    expect((await call(null, {})).status).toBe(401);
    expect((await call("Bearer deadbeef", {})).status).toBe(401);
    const res = await call(server.headers.Authorization, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_open", arguments: { url: "https://example.com/" } } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("Page: Example Domain");
    // An acting step asked through this server reaches the run's own approval flow.
    const click = call(server.headers.Authorization, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_click", arguments: { ref: "e1" } } });
    const ask = await waitFor(() => r.asks[0], "the approval");
    expect(ask.draft).toMatchObject({ tool: BROWSER_APPROVAL.act, risk: "high" }); // "Subscribe" is money
    ask.answer({ decision: "deny" });
    expect(await (await click).text()).toContain("denied");
    // The permission prompt lets browser tools through; everything else keeps its own verdict.
    const decide = service.decideWith(() => ({ tier: "ask", risk: "medium", reason: "inner" }));
    expect(decide("mcp__browser__browser_click", {}, { cwd: ".", profile: "strict" })).toMatchObject({ tier: "auto", silent: true });
    expect(decide("Bash", {}, { cwd: ".", profile: "strict" })).toMatchObject({ tier: "ask" });
    // On the run timeline, the tool's result holds no page text.
    const result = JSON.parse(text.split(String.fromCharCode(10)).find((l) => l.startsWith("data: "))!.slice(6)).result.content[0].text as string;
    expect(result).toContain("This domain is for use in examples");
    expect(service.redact("mcp__browser__browser_open", result)).not.toContain("This domain is for use in examples");
    expect(service.redact("Bash", result)).toBe(result);
    binding.release();
    expect((await call(server.headers.Authorization, {})).status).toBe(401);
  });
});
