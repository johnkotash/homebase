import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGE_CHECK_SETTING, newId, previewIdOf, type Agent, type AgentImagesStatus, type Message, type Project, type Thread } from "@homebase/protocol";
import { openStore } from "../src/app";
import { createHttpApp } from "../src/http";
import { NodeSqlStore } from "../src/hub/SqlStore";
import { readEntity } from "../src/hub/tables";
import { assertValid, connectConnector, connectDevice, makeHub, mid, pairDevice } from "./helpers";

const dev = (p: { id: string }) => ({ id: p.id, canApprove: true });
const IMAGES: AgentImagesStatus = {
  openai: { ready: true, cliVersion: "0.144.5", signedIn: true, method: "chatgpt", note: null, plan: "plus", usedPercent: 4, windowMins: 10080, resetsAt: 1795716883000, imagesLastHour: 0, capPerHour: 20, capPerRun: 4, checkedAt: 1 },
  claude: { canRender: true }, saveDir: "assets/generated", brandDir: "brand",
};
const CLAUDE = { key: "claude", name: "Claude agent", kind: "claude" as const, modes: ["manual", "auto"] as Array<"manual" | "auto">, workspaces: [{ label: "sandbox", cwd: "/srv/sandbox" }], images: IMAGES };
const PLAIN = { key: "comms", name: "Comms agent", kind: "claude" as const, modes: ["manual"] as Array<"manual"> };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const ctx = makeHub();
  const { hub, directory, store } = ctx;
  const device = connectDevice(hub, directory);
  const con = connectConnector(hub, directory, [CLAUDE, PLAIN] as any);
  const idOf = (key: string) => store.get<{ id: string }>("SELECT id FROM agents WHERE key = ? AND connector_id IS NOT NULL", key)!.id;
  const ack = (name: string, args: unknown) => hub.mutate(dev(device), mid(), name, args);
  const ok = (name: string, args: unknown) => {
    const a = ack(name, args);
    if (!a.ok) throw new Error(`${name} failed: ${JSON.stringify((a as any).error)}`);
  };
  const newThread = (agentKey = "claude", projectId: string | null = null) => {
    const threadId = newId("thr");
    ok("thread.create", { threadId, title: "Social", agentId: idOf(agentKey), projectId });
    return threadId;
  };
  const starts = () => con.of("cmd").filter((c) => c.name === "run.start").map((c) => c.run);
  const say = (threadId: string, text = "make a spring sale graphic") => {
    ctx.clock.now += 1000;
    ok("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    return starts().at(-1)!;
  };
  const messages = (threadId: string) =>
    store.all<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id", threadId).map((r) => readEntity<Message>(store, "messages", r.id)!);
  const audit = (action: string) => store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = ? ORDER BY at, id", action).map((a) => JSON.parse(a.detail));
  return { ...ctx, device, con, idOf, ack, ok, newThread, starts, say, messages, audit };
}

describe("what a connector says about images", () => {
  it("the facts are kept on the agent and satisfy the shared schema; an agent without image tools has none", () => {
    const s = setup();
    const a = readEntity<Agent>(s.store, "agents", s.idOf("claude"))!;
    expect(a.images).toEqual(IMAGES);
    assertValid("agents", a);
    expect(readEntity<Agent>(s.store, "agents", s.idOf("comms"))!.images).toBeNull();
  });

  it("a signed-out Codex shows as a note with the command to run, and clears when the connector says it is ready again", () => {
    const s = setup();
    const out = { ...IMAGES, openai: { ...IMAGES.openai, ready: false, signedIn: false, method: null, note: "Codex is not signed in on homebase-server. Run `codex login` there." } };
    s.hub.onFrame(s.con, { t: "register", host: { name: "c", os: "test" }, agents: [{ description: "", capabilities: [], ...CLAUDE, images: out }, { description: "", capabilities: [], workspaces: [], ...PLAIN }] });
    expect(readEntity<Agent>(s.store, "agents", s.idOf("claude"))!.images!.openai).toMatchObject({ ready: false, note: "Codex is not signed in on homebase-server. Run `codex login` there." });
    s.hub.onFrame(s.con, { t: "register", host: { name: "c", os: "test" }, agents: [{ description: "", capabilities: [], ...CLAUDE }, { description: "", capabilities: [], workspaces: [], ...PLAIN }] });
    expect(readEntity<Agent>(s.store, "agents", s.idOf("claude"))!.images!.openai.ready).toBe(true);
  });
});

describe("who makes images in a session", () => {
  it("a run is told Auto by default, the session's own choice when it has one, else its project's", () => {
    const s = setup();
    const projectId = newId("prj");
    s.ok("project.create", { projectId, name: "Social Media" });
    const t1 = s.newThread("claude", projectId);
    expect(s.say(t1).options.images).toEqual({ route: "auto", check: false });

    s.ok("images.set", { scope: "project", id: projectId, route: "openai" });
    expect(readEntity<Project>(s.store, "projects", projectId)!.imageRoute).toBe("openai");
    const t2 = s.newThread("claude", projectId);
    expect(s.say(t2).options.images).toEqual({ route: "openai", check: false });

    s.ok("images.set", { scope: "thread", id: t2, route: "ask" });
    expect(readEntity<Thread>(s.store, "threads", t2)!.imageRoute).toBe("ask");
    const t3 = s.newThread("claude", projectId);
    s.ok("images.set", { scope: "thread", id: t3, route: "ask" });
    expect(s.say(t3).options.images).toEqual({ route: "ask", check: false });

    // Null goes back to following the project.
    s.ok("images.set", { scope: "thread", id: t3, route: null });
    const t4 = s.newThread("claude", projectId);
    expect(s.say(t4).options.images.route).toBe("openai");
    // A session outside any project follows Auto.
    expect(s.say(s.newThread()).options.images.route).toBe("auto");
    assertValid("threads", readEntity<Thread>(s.store, "threads", t2));
    assertValid("projects", readEntity<Project>(s.store, "projects", projectId));
    expect(s.audit("images.set").map((a) => [a.scope, a.from, a.to])).toEqual([["project", null, "openai"], ["thread", null, "ask"], ["thread", null, "ask"], ["thread", "ask", null]]);
  });

  it("Off reaches the connector, and the check setting rides along", () => {
    const s = setup();
    const t = s.newThread();
    s.ok("images.set", { scope: "thread", id: t, route: "off" });
    s.ok("settings.update", { key: IMAGE_CHECK_SETTING, value: true });
    expect(s.say(t).options.images).toEqual({ route: "off", check: true });
  });

  it("an agent whose connector offers no image tools gets no image options", () => {
    const s = setup();
    expect(s.say(s.newThread("comms")).options.images).toBeUndefined();
  });

  it("refuses a route that does not exist and a session or project that does not exist", () => {
    const s = setup();
    expect(s.ack("images.set", { scope: "thread", id: s.newThread(), route: "gemini" })).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    expect(s.ack("images.set", { scope: "thread", id: newId("thr"), route: "ask" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(s.ack("images.set", { scope: "project", id: newId("prj"), route: "ask" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("images in the conversation", () => {
  const card = (over: Record<string, unknown> = {}) => ({
    type: "generated_image", artifactId: newId("art"), previewId: null, maker: "openai", via: "ChatGPT plan · via Codex CLI", model: null, name: "Spring sale post",
    prompt: "Square post, headline 'Spring sale'", mime: "image/png", width: 1254, height: 1254, bytes: 1160621, seconds: 31.2, savedPath: "assets/generated/2026-11-22-spring-sale-post.png",
    references: ["brand/logo.png"], routedWhy: "Nothing in your message said otherwise, so it is a rendered picture.", base: null, stored: true, ...over,
  });

  it("an image the connector reports becomes its own card in the session, marked with its maker, and is audited", () => {
    const s = setup();
    const t = s.newThread();
    const run = s.say(t);
    const c = card();
    s.hub.onFrame(s.con, { t: "run.status", runId: run.id, status: "running", at: s.clock.now });
    s.hub.onFrame(s.con, { t: "run.event", runId: run.id, idx: 0, at: s.clock.now, kind: "system", data: { message: "OpenAI made “Spring sale post” in 31 s", imageCard: c } });
    const m = s.messages(t).find((x) => x.card)!;
    expect(m).toMatchObject({ role: "assistant", source: "agent", runId: run.id });
    expect(m.card).toEqual(c);
    expect(m.text).toBe("Image by OpenAI: Spring sale post\nSquare post, headline 'Spring sale'\nSaved to assets/generated/2026-11-22-spring-sale-post.png");
    assertValid("messages", m);
    expect(s.audit("image.made")).toEqual([expect.objectContaining({ maker: "openai", via: "ChatGPT plan · via Codex CLI", name: "Spring sale post", artifactId: c.artifactId, references: ["brand/logo.png"], savedPath: c.savedPath })]);
    // The session counts as having something new from the agent.
    expect(readEntity<Thread>(s.store, "threads", t)!.lastAgentAt).toBe(s.clock.now);
  });

  it("a Claude overlay on an OpenAI picture says both names", () => {
    const s = setup();
    const t = s.newThread();
    const run = s.say(t);
    const c = card({ maker: "claude", via: "Claude plan · SVG overlay", model: "Opus 5.5", name: "Shop front with offer", prompt: "20% off over the photo", base: { maker: "openai", name: "Shop front" }, seconds: null });
    s.hub.onFrame(s.con, { t: "run.event", runId: run.id, idx: 0, at: s.clock.now, kind: "system", data: { message: "Claude drew it", imageCard: c } });
    expect(s.messages(t).find((x) => x.card)!.text.split("\n")[0]).toBe("Image by Claude, on an image by OpenAI: Shop front with offer");
    expect(s.audit("image.made")[0]).toMatchObject({ maker: "claude", base: { maker: "openai", name: "Shop front" } });
  });

  it("a card the connector did not shape properly is not shown: the maker cannot be invented", () => {
    const s = setup();
    const t = s.newThread();
    const run = s.say(t);
    s.hub.onFrame(s.con, { t: "run.event", runId: run.id, idx: 0, at: s.clock.now, kind: "system", data: { message: "x", imageCard: card({ maker: "midjourney" }) } });
    s.hub.onFrame(s.con, { t: "run.event", runId: run.id, idx: 1, at: s.clock.now, kind: "system", data: { message: "x", imageCard: card({ artifactId: "art_../../secrets" }) } });
    // A text event that merely talks about an image is not a card either.
    s.hub.onFrame(s.con, { t: "run.event", runId: run.id, idx: 2, at: s.clock.now, kind: "text", data: { text: "I made it with OpenAI.", imageCard: card() } });
    expect(s.messages(t).filter((x) => x.card)).toEqual([]);
    expect(s.audit("image.made")).toEqual([]);
  });

  it("an image that was not made shows why, under the provider's name", () => {
    const s = setup();
    const t = s.newThread();
    const run = s.say(t);
    const issue = { type: "image_issue", maker: "openai", reason: "not_ready", title: "not connected", message: "Codex is not signed in on homebase-server. Run `codex login` there.", hint: null };
    s.hub.onFrame(s.con, { t: "run.event", runId: run.id, idx: 0, at: s.clock.now, kind: "system", data: { message: "OpenAI: not connected", imageIssue: issue } });
    const m = s.messages(t).find((x) => x.card)!;
    expect(m.card).toEqual(issue);
    expect(m.text).toBe("OpenAI: not connected\nCodex is not signed in on homebase-server. Run `codex login` there.");
    expect(s.audit("image.failed")).toEqual([{ runId: run.id, maker: "openai", reason: "not_ready", title: "not connected", message: issue.message }]);
  });

  it("a card from a connector that does not own the run is ignored", () => {
    const s = setup();
    const t = s.newThread();
    const run = s.say(t);
    const stranger = connectConnector(s.hub, s.directory, [{ key: "other", name: "Other", kind: "mock" as const }]);
    s.hub.onFrame(stranger, { t: "run.event", runId: run.id, idx: 0, at: s.clock.now, kind: "system", data: { message: "x", imageCard: card() } });
    expect(s.messages(t).filter((x) => x.card)).toEqual([]);
  });
});

describe("image bytes over HTTP", () => {
  function http() {
    const ctx = makeHub();
    const dir = mkdtempSync(join(tmpdir(), "hb-art-"));
    dirs.push(dir);
    const app = createHttpApp(ctx.hub, ctx.directory, { artifactsDir: dir });
    const connector = pairDevice(ctx.directory, "connector", "c1");
    const device = pairDevice(ctx.directory, "device", "phone");
    const put = (id: string, token: string | null, body: Buffer | string = PNG, mime = "image/png") =>
      app.request(`/v1/artifacts/${id}`, { method: "PUT", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": mime }, body: typeof body === "string" ? body : new Uint8Array(body) });
    const get = (id: string, token: string | null) => app.request(`/v1/artifacts/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { ...ctx, dir, app, connector, device, put, get };
  }

  it("a connector stores an image once and a paired device reads it back, with headers that keep it a picture", async () => {
    const h = http();
    const id = newId("art");
    const res = await h.put(id, h.connector.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id, bytes: PNG.length });
    expect(readFileSync(join(h.dir, id)).equals(PNG)).toBe(true);
    const got = await h.get(id, h.device.token);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(got.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(got.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    // A retry with the same bytes is fine; different bytes under the same id are refused.
    expect((await h.put(id, h.connector.token)).status).toBe(200);
    expect((await h.put(id, h.connector.token, Buffer.concat([PNG, Buffer.from("x")]))).status).toBe(409);
  });

  it("an SVG and its PNG preview are two artifacts", async () => {
    const h = http();
    const id = newId("art");
    expect((await h.put(id, h.connector.token, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>', "image/svg+xml")).status).toBe(200);
    expect((await h.put(previewIdOf(id), h.connector.token)).status).toBe(200);
    expect((await h.get(id, h.device.token)).headers.get("Content-Type")).toBe("image/svg+xml");
    expect((await h.get(previewIdOf(id), h.device.token)).headers.get("Content-Type")).toBe("image/png");
  });

  it("only a connector writes and only a device reads; no token, no image", async () => {
    const h = http();
    const id = newId("art");
    expect((await h.put(id, null)).status).toBe(401);
    expect((await h.put(id, h.device.token)).status).toBe(401);
    expect((await h.put(id, "hb_con_made_up_token")).status).toBe(401);
    expect(existsSync(join(h.dir, id))).toBe(false);
    await h.put(id, h.connector.token);
    expect((await h.get(id, null)).status).toBe(401);
    expect((await h.get(id, h.connector.token)).status).toBe(401);
    expect((await h.get(newId("art"), h.device.token)).status).toBe(404);
  });

  it("refuses ids that are not artifact ids, types that are not images, and empty bodies", async () => {
    const h = http();
    expect((await h.put("art_..%2F..%2Fhomebase.db", h.connector.token)).status).toBe(400);
    expect((await h.put(newId("msg"), h.connector.token)).status).toBe(400);
    expect((await h.put(newId("art"), h.connector.token, "<html><script>alert(1)</script></html>", "text/html")).status).toBe(400);
    expect((await h.put(newId("art"), h.connector.token, Buffer.alloc(0))).status).toBe(400);
    expect((await h.get("art_..%2F..%2Fhomebase.db", h.device.token)).status).toBe(404);
  });
});

describe("an existing database", () => {
  it("gets the new columns and the artifacts table, and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-old-"));
    dirs.push(dir);
    const path = join(dir, "old.db");
    // A database from before images: the three tables without the new columns, with a row each.
    const old = new NodeSqlStore(path);
    old.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT, last_message_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, default_agent_id TEXT, default_cwd TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, connector_id TEXT, key TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', capabilities TEXT NOT NULL DEFAULT '[]', workspaces TEXT NOT NULL DEFAULT '[]', permission_profile TEXT NOT NULL DEFAULT 'standard', status TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO threads (id, title, created_at, updated_at) VALUES ('thr_old', 'Old session', 1, 1);
      INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_old', 'Old project', 1, 1);
      INSERT INTO agents (id, key, name, kind, status, updated_at) VALUES ('agt_old', 'claude', 'Claude agent', 'claude', 'offline', 1);
    `);
    old.close();
    const store = openStore(path);
    expect(readEntity<Thread>(store, "threads", "thr_old")).toMatchObject({ title: "Old session", imageRoute: null });
    expect(readEntity<Project>(store, "projects", "prj_old")).toMatchObject({ name: "Old project", imageRoute: null });
    expect(readEntity<Agent>(store, "agents", "agt_old")).toMatchObject({ name: "Claude agent", images: null });
    expect(store.all("SELECT * FROM artifacts")).toEqual([]);
    store.close();
  });
});
