import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHub, type HubApp } from "../src/app";
import { loadConfig } from "../src/config";
import { cacheControlFor, isApiPath, openWebDir } from "../src/web";

/** A stand-in for the Expo web export: index.html, a hashed bundle, an asset, and a secret next to the folder. */
function fakeExport() {
  const parent = mkdtempSync(join(tmpdir(), "hb-web-"));
  const dir = join(parent, "dist");
  mkdirSync(join(dir, "_expo", "static", "js", "web"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>HomeBase</title><div id=root></div>");
  writeFileSync(join(dir, "_expo", "static", "js", "web", "entry-abc123.js"), "console.log('hb')");
  writeFileSync(join(dir, "favicon.ico"), Buffer.from([0, 0, 1, 0]));
  writeFileSync(join(dir, "assets", "font.ttf"), "ttf");
  writeFileSync(join(parent, "secret.txt"), "do not serve");
  return { parent, dir };
}

describe("hub serves the web client", () => {
  let hub: HubApp;
  let base: string;
  let fx: ReturnType<typeof fakeExport>;

  beforeAll(async () => {
    fx = fakeExport();
    hub = await startHub({ dbPath: ":memory:", port: 0, seed: { demo: false }, quiet: true, webDir: fx.dir });
    base = hub.url;
  });
  afterAll(async () => {
    await hub.close();
    rmSync(fx.parent, { recursive: true, force: true });
  });

  it("answers / with index.html, never cached", async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(await r.text()).toContain("<title>HomeBase</title>");
  });

  it("serves files with their type; hashed bundles are cached for a year", async () => {
    const js = await fetch(`${base}/_expo/static/js/web/entry-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const ico = await fetch(`${base}/favicon.ico`);
    expect(ico.headers.get("content-type")).toBe("image/x-icon");
    expect(ico.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("answers a repeat with 304 when the ETag matches", async () => {
    const first = await fetch(`${base}/_expo/static/js/web/entry-abc123.js`);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await fetch(`${base}/_expo/static/js/web/entry-abc123.js`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("falls back to index.html for client routes (SPA), deep links included", async () => {
    for (const p of ["/pair", "/settings", "/chats/thr_123", "/connection?x=1"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(200);
      expect(await r.text(), p).toContain("<div id=root>");
    }
  });

  it("does not turn a missing file into the app", async () => {
    const r = await fetch(`${base}/_expo/static/js/web/missing-999.js`);
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
  });

  it("never swallows the API: /v1 routes, unknown /v1 paths and the health check stay JSON", async () => {
    const h = await fetch(`${base}/v1/health`);
    expect(h.status).toBe(200);
    expect((await h.json()).ok).toBe(true);
    for (const p of ["/v1/nope", "/v1", "/v1/runs/x/events"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.headers.get("content-type"), p).toMatch(/application\/json/);
      expect([401, 404], p).toContain(r.status);
    }
    const pair = await fetch(`${base}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(pair.status).toBe(400); // the API's own answer, not index.html
  });

  it("keeps the WebSocket on /v1/ws working beside the web client", async () => {
    const ws = new WebSocket(`${hub.wsUrl}`, { headers: { Origin: "app://homebase" } });
    const frame = await new Promise<any>((resolve, reject) => {
      ws.once("open", () => ws.send(JSON.stringify({ t: "hello", token: "nope", role: "device" })));
      ws.once("message", (m) => resolve(JSON.parse(m.toString())));
      ws.once("error", reject);
    });
    ws.close();
    expect(frame.t).toBe("error"); // reached the hub's hello handling, not a 404
  });

  it("never serves a file outside the export", async () => {
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt"]) {
      const r = await fetch(`${base}${p}`);
      const text = await r.text();
      expect(text, p).not.toContain("do not serve");
    }
  });

  it("only answers GET and HEAD", async () => {
    const head = await fetch(`${base}/pair`, { method: "HEAD" });
    expect(head.status).toBe(200);
    const post = await fetch(`${base}/pair`, { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("lets the desktop app's app:// page call the API (CORS)", async () => {
    const pre = await fetch(`${base}/v1/pair`, {
      method: "OPTIONS", headers: { Origin: "app://homebase", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(pre.status).toBeLessThan(300);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    const h = await fetch(`${base}/v1/health`, { headers: { Origin: "app://homebase" } });
    expect(h.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("web client settings", () => {
  it("is off without an export, and / keeps the hub's JSON", async () => {
    const empty = mkdtempSync(join(tmpdir(), "hb-web-empty-"));
    try {
      expect(openWebDir(empty)).toBeNull();
      expect(openWebDir(null)).toBeNull();
      const hub = await startHub({ dbPath: ":memory:", port: 0, seed: { demo: false }, quiet: true, webDir: empty });
      try {
        const r = await fetch(`${hub.url}/`);
        expect((await r.json()).service).toBe("homebase-hub");
        expect((await fetch(`${hub.url}/pair`)).status).toBe(404);
      } finally {
        await hub.close();
      }
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("reads HOMEBASE_WEB_DIR, defaults to the repo's export and can be turned off", () => {
    expect(loadConfig({}).webDir).toMatch(/apps[\\/]client[\\/]dist$/);
    expect(loadConfig({ HOMEBASE_WEB_DIR: "/srv/hb-web" }).webDir).toMatch(/hb-web$/);
    expect(loadConfig({ HOMEBASE_WEB_DIR: "off" }).webDir).toBeNull();
  });

  it("classifies paths and caching", () => {
    expect(isApiPath("/v1/ws")).toBe(true);
    expect(isApiPath("/v1")).toBe(true);
    expect(isApiPath("/v10")).toBe(false);
    expect(cacheControlFor("/index.html")).toBe("no-cache");
    expect(cacheControlFor("/_expo/static/css/x-1.css")).toMatch(/immutable/);
  });
});
