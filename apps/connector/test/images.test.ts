import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGE_TOOL, MAKER_QUESTION, type GeneratedImageCard, type ImageIssueCard, type ImageRoute } from "@homebase/protocol";
import type { ApprovalDecision, ApprovalDraft } from "../src/adapters/types";
import { CodexCli, classifyFailure, codexBrief, codexEnv, parseLoginStatus, resolveCodex, type CodexClient, type CodexImageResult } from "../src/images/codex";
import { ImageStore, nameFromPrompt, shownPath, slugify } from "../src/images/store";
import { ImageStudio, openaiNote } from "../src/images/studio";
import { checkSvg, imageSize, loadRenderer } from "../src/images/svg";
import { StudioRun, type StudioDeps, type StudioRunContext } from "../src/images/tools";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080"><rect width="1080" height="1080" fill="#111"/><text x="540" y="560" font-family="sans-serif" font-size="96" fill="#fff" text-anchor="middle">20% off</text></svg>';

const dirs: string[] = [];
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `hb-img-${name}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Codex

describe("the Codex CLI wrapper", () => {
  it("reads sign-in status down to a flag and a method", () => {
    expect(parseLoginStatus("Logged in using ChatGPT\n")).toEqual({ signedIn: true, method: "chatgpt" });
    expect(parseLoginStatus("Logged in using an API key - sk-proj-***abc")).toEqual({ signedIn: true, method: "api_key" });
    expect(parseLoginStatus("Not logged in")).toEqual({ signedIn: false, method: null });
    expect(parseLoginStatus("")).toEqual({ signedIn: false, method: null });
  });

  it("removes every OpenAI key and endpoint from the child's environment", () => {
    const { env, stripped } = codexEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "sk-y", OPENAI_BASE_URL: "http://elsewhere", OPENAI_ORG_ID: "org", CODEX_HOME: "/h", HOME: "/home/o" });
    expect(env).toEqual({ PATH: "/bin", CODEX_HOME: "/h", HOME: "/home/o" });
    expect(stripped).toBe(4);
  });

  it("tells a plan limit and a refusal from an ordinary failure", () => {
    expect(classifyFailure("You've hit your usage limit. Try again at 6:14 PM.")).toBe("limit");
    expect(classifyFailure("I can't create that image because it violates the content policy.")).toBe("refused");
    expect(classifyFailure("stream disconnected before completion")).toBe("failed");
  });

  it("asks Codex for exactly one image from its own tool", () => {
    const b = codexBrief("A red kite on white", 0);
    expect(b).toContain("exactly ONE image");
    expect(b).toContain("do not retry");
    expect(b).toContain("Image brief:\nA red kite on white");
    expect(b).not.toContain("reference asset");
    expect(codexBrief("x".repeat(20), 1)).toContain("The attached image is a reference asset");
  });

  it("finds Codex from HB_CODEX_COMMAND: a script is run with this Node, a missing file is not found", () => {
    expect(resolveCodex({ HB_CODEX_COMMAND: FAKE_CODEX })).toEqual({ cmd: process.execPath, pre: [FAKE_CODEX] });
    expect(resolveCodex({ HB_CODEX_COMMAND: join(tmpdir(), "no-such-codex.mjs") })).toBeNull();
    expect(resolveCodex({ PATH: tmp("empty") }, "linux")).toBeNull();
  });

  const cli = (mode: string, extra: NodeJS.ProcessEnv = {}) => {
    const home = tmp("codexhome");
    const log = join(home, "calls.jsonl");
    const env = { ...process.env, HB_CODEX_COMMAND: FAKE_CODEX, CODEX_HOME: home, FAKE_CODEX_MODE: mode, FAKE_CODEX_LOG: log, OPENAI_API_KEY: "sk-must-not-leak", ...extra };
    return { codex: new CodexCli({ env }), home, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
  };

  it("reports installed, version and the ChatGPT sign-in; a signed-out or API-key login is told apart", async () => {
    expect(await cli("ok").codex.status()).toMatchObject({ installed: true, version: "9.9.9", signedIn: true, method: "chatgpt" });
    expect(await cli("logged_out").codex.status()).toMatchObject({ installed: true, signedIn: false, method: null });
    expect(await cli("api_key").codex.status()).toMatchObject({ signedIn: true, method: "api_key" });
    expect(await new CodexCli({ env: { HB_CODEX_COMMAND: join(tmpdir(), "nope.mjs") } }).status()).toMatchObject({ installed: false, signedIn: null });
  });

  it("reads the plan and its usage window without a model call", async () => {
    expect(await cli("ok").codex.limits()).toEqual({ plan: "plus", usedPercent: 12, windowMins: 10080, resetsAt: 1795716883000, limitReached: false });
  });

  it("makes one image: read-only sandbox, own config left out, brief on stdin, the file taken from Codex's own folder, no key passed on", async () => {
    const c = cli("ok");
    const cwd = tmp("cwd");
    const r = await c.codex.image({ prompt: "A red kite on white, square", references: [], cwd });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.startsWith(join(c.home, "generated_images"))).toBe(true);
    expect(readFileSync(r.file).equals(PNG)).toBe(true);
    expect(r.note).toBe("Created one square graphic.");
    const call = c.calls()[0];
    expect(call.args).toEqual(["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-C", cwd, "-s", "read-only", "--json", "-"]);
    expect(call.brief).toContain("A red kite on white, square");
    expect(call.keys).toEqual([]);
    // The working directory was not written to.
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("passes reference images last with -i", async () => {
    const c = cli("ok");
    const cwd = tmp("cwd");
    const logo = join(cwd, "logo.png");
    writeFileSync(logo, PNG);
    await c.codex.image({ prompt: "Use this logo in the corner", references: [logo], cwd });
    expect(c.calls()[0].args.slice(-2)).toEqual(["-i", logo]);
    expect(c.calls()[0].brief).toContain("reference asset");
  });

  it("no image file means no image, whatever Codex says; limits and refusals are named", async () => {
    const cwd = tmp("cwd");
    expect(await cli("no_image").codex.image({ prompt: "A red kite on white", references: [], cwd })).toMatchObject({ ok: false, reason: "failed", message: "Done." });
    expect(await cli("limit").codex.image({ prompt: "A red kite on white", references: [], cwd })).toMatchObject({ ok: false, reason: "limit" });
    expect(await cli("refuse").codex.image({ prompt: "A red kite on white", references: [], cwd })).toMatchObject({ ok: false, reason: "refused" });
  });

  it("stops Codex on a timeout and on cancel", async () => {
    const cwd = tmp("cwd");
    expect(await cli("hang").codex.image({ prompt: "A red kite on white", references: [], cwd, timeoutMs: 400 })).toMatchObject({ ok: false, reason: "timeout" });
    const ctl = new AbortController();
    const p = cli("hang").codex.image({ prompt: "A red kite on white", references: [], cwd, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 300);
    expect(await p).toMatchObject({ ok: false, reason: "cancelled" });
  });
});

// ---------------------------------------------------------------- SVG

describe("graphics Claude draws", () => {
  it("accepts a plain SVG and reads its size; a missing xmlns is added", () => {
    const ok = checkSvg(SVG);
    expect(ok).toMatchObject({ ok: true, width: 1080, height: 1080 });
    const bare = checkSvg('```svg\n<?xml version="1.0"?><svg viewBox="0 0 400 200"><circle cx="5" cy="5" r="4"/></svg>\n```');
    expect(bare).toMatchObject({ ok: true, width: 400, height: 200 });
    expect(bare.ok && bare.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it("refuses anything that runs, loads from elsewhere or has no size", () => {
    const bad = (svg: string) => {
      const r = checkSvg(svg);
      expect(r.ok, svg).toBe(false);
      return r.ok ? "" : r.reason;
    };
    const wrap = (inner: string, attrs = 'viewBox="0 0 10 10"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
    expect(bad(wrap("<script>alert(1)</script>"))).toContain("<script>");
    expect(bad(wrap('<rect onload="x()" width="1" height="1"/>'))).toContain("event handler");
    expect(bad(wrap('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>'))).toContain("javascript:");
    expect(bad(wrap('<image href="https://example.com/x.png" width="10" height="10"/>'))).toContain("outside the file");
    expect(bad(wrap('<image xlink:href="file:///etc/passwd" width="10" height="10"/>'))).toContain("outside the file");
    expect(bad(wrap('<rect width="1" height="1" style="fill:url(https://example.com/a.svg#p)"/>'))).toContain("url(...)");
    expect(bad(wrap("<style>@import url(https://fonts.example/x.css);</style>"))).toContain("@import");
    expect(bad(wrap("<foreignObject><div>hi</div></foreignObject>"))).toContain("foreignObject");
    expect(bad('<!DOCTYPE svg [<!ENTITY x "y">]>' + wrap("<text>&x;</text>"))).toBeTruthy();
    expect(bad(wrap("<rect/>", ""))).toContain("viewBox");
    expect(bad("<div>not an svg</div>")).toContain("<svg>");
    expect(bad(wrap(`<text>${"x".repeat(500_000)}</text>`))).toContain("larger than");
    expect(bad(42 as any)).toContain("text");
  });

  it("allows links inside the file and embedded raster data", () => {
    expect(checkSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><use href="#g"/></svg>').ok).toBe(true);
    expect(checkSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image href="data:image/png;base64,${PNG.toString("base64")}" width="10" height="10"/></svg>`).ok).toBe(true);
  });

  it("reads the size of a PNG from its header", () => {
    expect(imageSize(PNG)).toEqual({ width: 1, height: 1, mime: "image/png" });
    expect(imageSize(Buffer.from("not an image at all, just some text"))).toBeNull();
  });

  it("renders a PNG preview and puts an overlay on a picture, when the image library is on this machine", async () => {
    const r = await loadRenderer();
    if (!r) return; // sharp is optional: without it the SVG is stored and the browser draws it
    const png = await r.png(SVG, { width: 1080, height: 1080 });
    expect(imageSize(png)).toMatchObject({ width: 1080, height: 1080, mime: "image/png" });
    const small = await r.png('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100" height="50"><rect width="100" height="50" fill="red"/></svg>', { width: 100, height: 50 });
    expect(imageSize(small)).toMatchObject({ width: 1080, height: 540 });
    const base = await r.png('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" width="300" height="200"><rect width="300" height="200" fill="blue"/></svg>', { width: 300, height: 200 }, 300);
    const over = await r.overlay(base, SVG);
    expect(over).toMatchObject({ width: 300, height: 200 });
    expect(imageSize(over.png)).toMatchObject({ width: 300, height: 200 });
  });
});

// ---------------------------------------------------------------- storing

describe("where images are kept", () => {
  it("names files from titles", () => {
    expect(slugify("Spring sale post!")).toBe("spring-sale-post");
    expect(slugify("Café / Menu — Été")).toBe("cafe-menu-ete");
    expect(slugify("???")).toBe("image");
    expect(nameFromPrompt('A minimalist square graphic that says "HomeBase test" on dark')).toBe("A minimalist square graphic that says");
  });

  it("saves the connector's copy with a sidecar, a dated copy in the working directory with an index line, and sends the bytes to the hub", async () => {
    const data = tmp("data");
    const cwd = tmp("cwd");
    const puts: Array<{ url: string; mime: string; auth: string; bytes: number }> = [];
    const store = new ImageStore({
      dataDir: data, hub: () => ({ url: "http://hub.test/", token: "hb_con_test" }), now: () => Date.UTC(2026, 10, 22, 12),
      fetchFn: (async (url: any, init: any) => {
        puts.push({ url: String(url), mime: init.headers["Content-Type"], auth: init.headers.Authorization, bytes: init.body.length });
        return new Response("{}", { status: 200 });
      }) as any,
    });
    const a = await store.save({ threadId: "thr_1", cwd, name: "Spring sale post", ext: ".png", bytes: PNG, meta: { maker: "openai", prompt: "p" } });
    expect(a.id).toMatch(/^art_/);
    expect(a.stored).toBe(true);
    expect(readFileSync(a.artifactPath).equals(PNG)).toBe(true);
    expect(JSON.parse(readFileSync(a.artifactPath.replace(/\.png$/, ".json"), "utf8"))).toMatchObject({ id: a.id, maker: "openai", prompt: "p", savedPath: a.savedPath });
    expect(a.savedPath).toBe(join(cwd, "assets", "generated", "2026-11-22-spring-sale-post.png"));
    expect(JSON.parse(readFileSync(join(cwd, "assets", "generated", "index.jsonl"), "utf8").trim())).toMatchObject({ file: "2026-11-22-spring-sale-post.png", maker: "openai" });
    expect(puts).toEqual([{ url: `http://hub.test/v1/artifacts/${a.id}`, mime: "image/png", auth: "Bearer hb_con_test", bytes: PNG.length }]);
    // The same name again does not overwrite.
    const b = await store.save({ threadId: "thr_1", cwd, name: "Spring sale post", ext: ".png", bytes: PNG, meta: {} });
    expect(b.savedPath).toBe(join(cwd, "assets", "generated", "2026-11-22-spring-sale-post-2.png"));
    // An SVG goes up with its PNG preview under the preview id.
    const c = await store.save({ threadId: "thr_1", cwd, name: "Badge", ext: ".svg", bytes: Buffer.from(SVG), preview: PNG, meta: {} });
    expect(c.previewId).toBe(`${c.id}p`);
    expect(puts.slice(-2).map((p) => [p.url.split("/").pop(), p.mime])).toEqual([[c.id, "image/svg+xml"], [`${c.id}p`, "image/png"]]);
    expect(shownPath(c.savedPath!, cwd)).toBe("assets/generated/2026-11-22-badge.svg");
  });

  it("keeps the file when the hub cannot be reached, and says so", async () => {
    const store = new ImageStore({ dataDir: tmp("data"), hub: () => null });
    const a = await store.save({ threadId: null, cwd: tmp("cwd"), name: "x", ext: ".png", bytes: PNG, meta: {} });
    expect(a.stored).toBe(false);
    expect(existsSync(a.artifactPath) && existsSync(a.savedPath!)).toBe(true);
  });

  it("takes reference images only from the working directory or the session's own images", () => {
    const cwd = tmp("cwd");
    const store = new ImageStore({ dataDir: tmp("data"), hub: () => null });
    mkdirSync(join(cwd, "brand"), { recursive: true });
    writeFileSync(join(cwd, "brand", "logo.png"), PNG);
    writeFileSync(join(cwd, ".env"), "SECRET=1");
    writeFileSync(join(cwd, "notes.txt"), "hello");
    const outside = join(tmp("other"), "x.png");
    writeFileSync(outside, PNG);
    expect(store.resolveReference("brand/logo.png", cwd, "thr_1")).toEqual({ ok: true, path: join(cwd, "brand", "logo.png") });
    expect(store.resolveReference("logo.png", cwd, "thr_1")).toEqual({ ok: true, path: join(cwd, "brand", "logo.png") });
    expect(store.resolveReference(join(cwd, "brand", "logo.png"), cwd, "thr_1").ok).toBe(true);
    expect(store.resolveReference(outside, cwd, "thr_1").ok).toBe(false);
    expect(store.resolveReference("../../etc/passwd", cwd, "thr_1").ok).toBe(false);
    expect(store.resolveReference("notes.txt", cwd, "thr_1").ok).toBe(false);
    expect(store.resolveReference(".env", cwd, "thr_1").ok).toBe(false);
    expect(store.resolveReference("missing.png", cwd, "thr_1").ok).toBe(false);
    expect(store.resolveReference(42, cwd, "thr_1").ok).toBe(false);
  });

  it("counts an hour of attempts per maker, and not the ones HomeBase stopped itself", () => {
    let now = Date.UTC(2026, 10, 22, 12);
    const store = new ImageStore({ dataDir: tmp("data"), hub: () => null, now: () => now });
    const line = { runId: "run_1", threadId: null };
    store.record({ ...line, at: now - 2 * 3_600_000, maker: "openai", ok: true });
    store.record({ ...line, at: now - 10 * 60_000, maker: "openai", ok: true });
    store.record({ ...line, at: now - 5 * 60_000, maker: "openai", ok: false, reason: "failed" });
    store.record({ ...line, at: now - 4 * 60_000, maker: "openai", ok: false, reason: "cap" });
    store.record({ ...line, at: now - 3 * 60_000, maker: "openai", ok: false, reason: "not_ready" });
    store.record({ ...line, at: now - 60_000, maker: "claude", ok: true });
    expect(store.countLastHour("openai")).toBe(2);
    expect(store.countLastHour("claude")).toBe(1);
    now += 3_600_000;
    expect(store.countLastHour("openai")).toBe(0);
  });

  it("copies an image into the brand folder under its plain name", async () => {
    const cwd = tmp("cwd");
    const store = new ImageStore({ dataDir: tmp("data"), hub: () => null, now: () => Date.UTC(2026, 10, 22) });
    const a = await store.save({ threadId: "t", cwd, name: "Wordmark", ext: ".png", bytes: PNG, meta: {} });
    expect(store.toBrand(a.savedPath!, cwd)).toBe(join(cwd, "brand", "wordmark.png"));
    expect(store.toBrand(a.savedPath!, cwd)).toBe(join(cwd, "brand", "wordmark-2.png"));
  });
});

// ---------------------------------------------------------------- the tools

class FakeCodex implements CodexClient {
  calls: Array<{ prompt: string; references: string[] }> = [];
  ready = { installed: true, version: "9.9.9", signedIn: true as boolean | null, method: "chatgpt" as string | null };
  next: CodexImageResult | null = null;
  constructor(private dir: string) {}
  async status() {
    return { ...this.ready, checkedAt: Date.now() };
  }
  async limits() {
    return { plan: "plus", usedPercent: 12, windowMins: 10080, resetsAt: 1795716883000, limitReached: false };
  }
  async image(req: { prompt: string; references: string[] }): Promise<CodexImageResult> {
    this.calls.push({ prompt: req.prompt, references: req.references });
    if (this.next) return this.next;
    const file = join(this.dir, `gen-${this.calls.length}.png`);
    writeFileSync(file, PNG);
    return { ok: true, file, threadId: "0199fake", note: "Created one image.", seconds: 26.1, usage: null };
  }
}

function harness(over: { route?: ImageRoute; check?: boolean; ownerText?: string; answer?: string | null; perRun?: number; perHour?: number; ready?: boolean; note?: string; renderer?: boolean; tell?: boolean } = {}) {
  const cwd = tmp("cwd");
  const data = tmp("data");
  const codex = new FakeCodex(tmp("codexout"));
  const store = new ImageStore({ dataDir: data, hub: () => null, now: () => Date.UTC(2026, 10, 22, 12) });
  const events: Array<Record<string, any>> = [];
  const asked: ApprovalDraft[] = [];
  /** What was put into the run as the owner's next message. */
  const told: string[] = [];
  const state = { ownerText: over.ownerText ?? "generate a social media graphic for the spring sale", answer: over.answer as string | null | undefined, last: null as any };
  const made = new Map<string, any>();
  const ctx: StudioRunContext = {
    runId: "run_1", threadId: "thr_1", cwd, route: over.route ?? "auto", check: !!over.check, ownerText: () => state.ownerText, mode: () => "manual", claudeModel: () => "Opus 5.5",
    requestApproval: async (draft): Promise<ApprovalDecision> => {
      asked.push(draft);
      if (state.answer === null) return { decision: "deny", message: null, answers: null, remember: false };
      return { decision: "approve", message: null, answers: { [MAKER_QUESTION]: state.answer ?? "OpenAI image" }, remember: false };
    },
    emit: (_kind, data) => void events.push(data), signal: new AbortController().signal,
    tellAgent: (text) => (over.tell === false ? false : (told.push(text), true)),
  };
  const deps: StudioDeps = {
    codex, store, renderer: async () => (over.renderer === false ? null : loadRenderer()),
    openaiReady: async () => ({ ready: over.ready !== false, note: over.ready === false ? over.note ?? "Codex is not signed in on test-host. Run `codex login` there." : null }),
    afterOpenAi: () => {}, caps: { perRun: over.perRun ?? 4, perHour: over.perHour ?? 20 },
    lastMaker: () => state.last, setLastMaker: (_t, m) => void (state.last = m),
    madeBy: (f) => made.get(f) ?? null, remember: (f, m) => void made.set(f, m), now: () => Date.UTC(2026, 10, 22, 12),
  };
  const run = new StudioRun(ctx, deps);
  const cards = () => events.filter((e) => e.imageCard).map((e) => e.imageCard as GeneratedImageCard);
  const issues = () => events.filter((e) => e.imageIssue).map((e) => e.imageIssue as ImageIssueCard);
  return { run, codex, store, events, asked, told, state, cwd, cards, issues };
}

describe("the image tools", () => {
  it("a plain request: OpenAI makes it at once, no question, and the card says OpenAI", async () => {
    const h = harness();
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Square spring sale post, headline 'Spring sale', pastel", name: "Spring sale post" });
    expect(r.isError).toBeFalsy();
    expect(h.asked).toEqual([]);
    expect(h.codex.calls).toHaveLength(1);
    const [card] = h.cards();
    expect(card).toMatchObject({
      type: "generated_image", maker: "openai", via: "ChatGPT plan · via Codex CLI", model: null, name: "Spring sale post", mime: "image/png", width: 1, height: 1, seconds: 26.1,
      savedPath: "assets/generated/2026-11-22-spring-sale-post.png", base: null, prompt: "Square spring sale post, headline 'Spring sale', pastel",
    });
    expect(existsSync(join(h.cwd, "assets", "generated", "2026-11-22-spring-sale-post.png"))).toBe(true);
    expect(r.text).toContain("OpenAI made the image");
    expect(r.text).toContain("do not describe it as your own work");
    expect(r.text).not.toContain("Read that file now");
    expect(h.state.last).toBe("openai");
  });

  it("with checking on, Claude is told to look at the file and compare it with the brief, and not to regenerate", async () => {
    const h = harness({ check: true });
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Square spring sale post, headline 'Spring sale'" });
    expect(r.text).toContain("Read that file now");
    expect(r.text).toContain("Do not make another image on your own");
  });

  it("a clear graphic: Claude's SVG is stored at once and the card says Claude, with its model", async () => {
    const h = harness({ ownerText: "make an SVG badge that says 20% off" });
    const r = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Sale badge", description: "Dark square badge with '20% off'" });
    expect(r.isError).toBeFalsy();
    expect(h.asked).toEqual([]);
    expect(h.codex.calls).toEqual([]);
    const [card] = h.cards();
    expect(card).toMatchObject({ maker: "claude", via: "Claude plan · SVG", model: "Opus 5.5", name: "Sale badge", mime: "image/svg+xml", width: 1080, height: 1080, seconds: null, savedPath: "assets/generated/2026-11-22-sale-badge.svg" });
    expect(readFileSync(join(h.cwd, "assets", "generated", "2026-11-22-sale-badge.svg"), "utf8")).toBe(SVG);
    expect(h.state.last).toBe("claude");
  });

  it("an unsafe SVG is not stored and nobody is asked anything", async () => {
    const h = harness({ ownerText: "make an SVG badge" });
    const r = await h.run.call(IMAGE_TOOL.claude, { svg: SVG.replace("<rect", "<script>fetch('http://x')</script><rect"), name: "Bad" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("not stored");
    expect(h.cards()).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  it("mixed signals: the owner is asked once, with OpenAI, Claude and Both; the answer holds for the rest of the run", async () => {
    const h = harness({ ownerText: "a photo of the shop with a text overlay saying 20% off", answer: "OpenAI image" });
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Photo of a small shop front with the text '20% off'" });
    expect(r.isError).toBeFalsy();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ kind: "question", risk: "low", title: MAKER_QUESTION, tool: "mcp__images__openai_image" });
    expect(h.asked[0].questions![0].options.map((o) => o.label)).toEqual(["OpenAI image", "Claude overlay / SVG", "Both"]);
    expect(h.asked[0].reason).toContain("points both ways");
    expect(h.cards()[0]).toMatchObject({ maker: "openai", routedWhy: "You chose OpenAI image." });
    // A second image in the same run does not ask again, and Claude's own tool is now turned away.
    await h.run.call(IMAGE_TOOL.openai, { prompt: "A second photo of the shop, from the left" });
    expect(h.asked).toHaveLength(1);
    const no = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Overlay" });
    // An ordinary result, in the third person: nothing went wrong, the job belongs to the other maker.
    expect(no.isError).toBeFalsy();
    expect(no.text).toContain("Nothing was stored. The owner chose OpenAI image.");
    expect(no.text).toContain(IMAGE_TOOL.openai);
    expect(h.cards()).toHaveLength(2);
  });

  it("the owner picks the other maker: nothing is generated and the agent is sent there", async () => {
    const h = harness({ ownerText: "a photo of the shop with a text overlay saying 20% off", answer: "Claude overlay / SVG" });
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Photo of a small shop front with the text '20% off'" });
    // The agent never sees the tap, and is right to distrust "the owner chose…" in tool output. So the tool only says an
    // answer is on its way, and the answer goes in as the owner's next message, in the words of the choice they tapped.
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Their answer arrives as their next message");
    expect(r.text).not.toContain("Claude overlay");
    expect(h.told).toEqual(["(Tapped in HomeBase) Claude overlay / SVG: make this one yourself, as an SVG graphic."]);
    expect(h.events.some((e) => e.imageRoute?.action === "told" && /Told the agent for you/.test(e.message))).toBe(true);
    expect(h.codex.calls).toEqual([]);
    expect(h.cards()).toEqual([]);
    const ok = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Overlay" });
    expect(ok.isError).toBeFalsy();
    expect(h.asked).toHaveLength(1);
    expect(h.cards()[0]).toMatchObject({ maker: "claude" });
  });

  it("when a run cannot take a message, the answer is in the result itself, with where it came from", async () => {
    const h = harness({ ownerText: "a photo of the shop with a text overlay saying 20% off", answer: "Claude overlay / SVG", tell: false });
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Photo of a small shop front with the text '20% off'" });
    expect(r.text).toBe("Nothing was sent to OpenAI. The owner answered HomeBase's question in the app just now, with one tap: Claude overlay / SVG. So this one is yours: draw it as an SVG and store it with claude_graphic. Do not call openai_image for this request.");
    const both = harness({ ownerText: "a photo of the shop with a text overlay saying 20% off", answer: "Both", tell: false });
    const b = await both.run.call(IMAGE_TOOL.openai, { prompt: "Photo of a small shop front with the text '20% off'" });
    expect(b.text).toContain("with one tap: Both");
    expect(b.text).toContain("no text, lettering or logos");
    expect(both.codex.calls).toEqual([]);
  });

  it("the owner dismisses the question: no image, and the agent is told not to find another way", async () => {
    const h = harness({ ownerText: "a photo of the shop with a text overlay", answer: null });
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Photo of a small shop front" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("dismissed the question");
    expect(h.codex.calls).toEqual([]);
  });

  it("both: OpenAI makes the picture, then Claude's overlay is composed on top and the card says whose picture it is on", async () => {
    const h = harness({ ownerText: "a photo of the shop with a text overlay saying 20% off", answer: "Both" });
    // The first brief was written for one maker doing everything, so nothing is made from it: the agent is sent back to split the job.
    const whole = await h.run.call(IMAGE_TOOL.openai, { prompt: "Photo of a small shop front with the words '20% off' across it", name: "Shop offer" });
    expect(whole.isError).toBeFalsy();
    expect(whole.text).toContain("Their answer arrives as their next message");
    expect(h.told).toEqual(["(Tapped in HomeBase) Both: have OpenAI make the picture with no text or lettering in it, then put the words on top yourself as an SVG overlay on that picture."]);
    expect(h.codex.calls).toEqual([]);
    const first = await h.run.call(IMAGE_TOOL.openai, { prompt: "Photo of a small shop front, no text", name: "Shop front" });
    expect(first.text).toContain("this is step 1");
    expect(first.text).not.toContain("Say in one short sentence that it is ready");
    const file = /File: (.+)/.exec(first.text)![1].trim();
    if (!(await loadRenderer())) return;
    const second = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Shop front with offer", description: "20% off over the shop photo", base_image: file });
    expect(second.isError).toBeFalsy();
    expect(h.asked).toHaveLength(1);
    const card = h.cards()[1];
    expect(card).toMatchObject({ maker: "claude", via: "Claude plan · SVG overlay", mime: "image/png", base: { maker: "openai", name: "Shop front" }, references: ["assets/generated/2026-11-22-shop-front.png"] });
    expect(h.codex.calls).toHaveLength(1);
    // The composed picture and the overlay itself are both kept.
    expect(existsSync(join(h.cwd, "assets", "generated", "2026-11-22-shop-front-with-offer.png"))).toBe(true);
    expect(readFileSync(join(h.cwd, "assets", "generated", "2026-11-22-shop-front-with-offer.overlay.svg"), "utf8")).toBe(SVG);
  });

  it("Both, when the agent started with its own drawing: it is sent to get the picture first, and an overlay on a picture goes straight through", async () => {
    const h = harness({ ownerText: "a photo of the shop with a text overlay saying 20% off", answer: "Both" });
    const alone = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Offer" });
    expect(alone.isError).toBeFalsy();
    expect(alone.text).toContain("Their answer arrives as their next message");
    expect(h.told).toHaveLength(1);
    expect(h.cards()).toEqual([]);
    if (!(await loadRenderer())) return;
    const fresh = harness({ ownerText: "a photo of the shop with a text overlay saying 20% off", answer: "Both" });
    mkdirSync(join(fresh.cwd, "brand"), { recursive: true });
    writeFileSync(join(fresh.cwd, "brand", "shop.png"), PNG);
    const over = await fresh.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Offer", base_image: "brand/shop.png" });
    expect(over.isError).toBeFalsy();
    // The owner's own photo has no maker to name; the card says what it sits on.
    expect(fresh.cards()[0]).toMatchObject({ maker: "claude", base: null, references: ["brand/shop.png"] });
  });

  it("an overlay needs the image library; without it the agent is told to store the SVG on its own", async () => {
    const h = harness({ ownerText: "add a text overlay to that picture", renderer: false });
    mkdirSync(join(h.cwd, "brand"), { recursive: true });
    writeFileSync(join(h.cwd, "brand", "photo.png"), PNG);
    const r = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Overlay", base_image: "brand/photo.png" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("without base_image");
    // On its own the SVG is stored, with no preview.
    const alone = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Overlay" });
    expect(alone.isError).toBeFalsy();
    expect(h.cards()[0]).toMatchObject({ maker: "claude", previewId: null, mime: "image/svg+xml" });
  });

  it("a session set to always OpenAI turns Claude's drawing away, unless the message names Claude", async () => {
    const h = harness({ route: "openai", ownerText: "a badge for the sale" });
    const r = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Badge" });
    // The setting was made in the app, so it is said to the agent as the owner's message, once.
    expect(r.text).toContain("What they set arrives as their next message");
    expect(h.told).toEqual(["(Set in HomeBase for this session) Images here are always made by OpenAI: have OpenAI make this one as a rendered picture."]);
    expect(h.cards()).toEqual([]);
    const again = await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Badge" });
    expect(again.text).toContain("Nothing was stored. This session is set to Always OpenAI.");
    expect(h.told).toHaveLength(1);
    expect(h.asked).toEqual([]);
    h.state.ownerText = "have Claude draw the badge as an SVG";
    expect((await h.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Badge" })).isError).toBeFalsy();
  });

  it("a session set to ask: one question, even for a clear request", async () => {
    const h = harness({ route: "ask", ownerText: "a photo of a lighthouse", answer: "OpenAI image" });
    await h.run.call(IMAGE_TOOL.openai, { prompt: "A photo of a lighthouse at dawn" });
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].questions![0].options.map((o) => o.label)).toEqual(["OpenAI image", "Claude overlay / SVG"]);
    expect(h.cards()).toHaveLength(1);
  });

  it("OpenAI not signed in: a card with the command to run, nothing generated, no substitute suggested", async () => {
    const h = harness({ ready: false });
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Square spring sale post" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("codex login");
    expect(r.text).toContain("Do not draw a substitute yourself");
    expect(h.codex.calls).toEqual([]);
    expect(h.issues()).toEqual([{ type: "image_issue", maker: "openai", reason: "not_ready", title: "not connected", message: "Codex is not signed in on test-host. Run `codex login` there.", hint: null }]);
    // It did not count against the hourly cap.
    expect(h.store.countLastHour("openai")).toBe(0);
  });

  it("caps: four per reply and twenty per hour, each with its own card; the same brief twice is refused", async () => {
    const h = harness({ perRun: 2 });
    await h.run.call(IMAGE_TOOL.openai, { prompt: "Spring sale post, version A" });
    const again = await h.run.call(IMAGE_TOOL.openai, { prompt: "Spring sale post, version A" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already asked for exactly this image");
    await h.run.call(IMAGE_TOOL.openai, { prompt: "Spring sale post, version B" });
    const third = await h.run.call(IMAGE_TOOL.openai, { prompt: "Spring sale post, version C" });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("limit for one reply");
    expect(h.codex.calls).toHaveLength(2);
    expect(h.issues().at(-1)).toMatchObject({ maker: "openai", reason: "limit", title: "limit for one reply reached" });

    const hourly = harness({ perHour: 1 });
    await hourly.run.call(IMAGE_TOOL.openai, { prompt: "Spring sale post, first" });
    const over = await hourly.run.call(IMAGE_TOOL.openai, { prompt: "Spring sale post, second" });
    expect(over.isError).toBe(true);
    expect(hourly.issues().at(-1)).toMatchObject({ reason: "limit", title: "hourly limit reached" });
    expect(hourly.codex.calls).toHaveLength(1);
  });

  it("OpenAI's own limit or refusal is passed on under OpenAI's name, with no retry and no fallback", async () => {
    const h = harness();
    h.codex.next = { ok: false, reason: "limit", message: "You've hit your usage limit. Try again at 6:14 PM.", seconds: 3 };
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "Square spring sale post" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Do not retry");
    expect(h.issues()[0]).toMatchObject({ maker: "openai", reason: "limit", title: "plan limit reached", message: "You've hit your usage limit. Try again at 6:14 PM.", hint: "Nothing was switched to another provider. Try again after the plan resets." });
    h.codex.next = { ok: false, reason: "refused", message: "I can't create that image.", seconds: 3 };
    await h.run.call(IMAGE_TOOL.openai, { prompt: "Another square spring sale post" });
    expect(h.issues()[1]).toMatchObject({ reason: "refused", title: "declined to make this image" });
    expect(h.cards()).toEqual([]);
    expect(h.codex.calls).toHaveLength(2);
  });

  it("reference images come from the working directory; anything else stops the call before OpenAI is asked", async () => {
    const h = harness();
    mkdirSync(join(h.cwd, "brand"), { recursive: true });
    writeFileSync(join(h.cwd, "brand", "logo.png"), PNG);
    const bad = await h.run.call(IMAGE_TOOL.openai, { prompt: "Post with the logo", reference_images: ["C:/Windows/win.ini"] });
    expect(bad.isError).toBe(true);
    expect(h.codex.calls).toEqual([]);
    await h.run.call(IMAGE_TOOL.openai, { prompt: "Post with the logo in the corner", reference_images: ["brand/logo.png"] });
    expect(h.codex.calls[0].references).toEqual([join(h.cwd, "brand", "logo.png")]);
    expect(h.cards()[0].references).toEqual(["brand/logo.png"]);
  });

  it("choose_maker asks only when there is something to ask", async () => {
    const named = harness({ ownerText: "use GPT image for this" });
    expect((await named.run.call(IMAGE_TOOL.ask, { request: "a sale graphic" })).text).toContain("No need to ask");
    expect(named.asked).toEqual([]);
    const set = harness({ route: "claude" });
    expect((await set.run.call(IMAGE_TOOL.ask, { request: "a sale graphic" })).text).toContain("Always Claude");
    const open = harness({ answer: "Claude overlay / SVG" });
    const r = await open.run.call(IMAGE_TOOL.ask, { request: "a sale graphic", both_makes_sense: true });
    expect(open.asked).toHaveLength(1);
    expect(open.asked[0].questions![0].options).toHaveLength(3);
    expect(r.text).toContain(IMAGE_TOOL.claude);
    // The answer is remembered: Claude's drawing now goes ahead without another question.
    expect((await open.run.call(IMAGE_TOOL.claude, { svg: SVG, name: "Sale graphic" })).isError).toBeFalsy();
    expect(open.asked).toHaveLength(1);
  });

  it("save_to_brand copies a session image into the brand folder", async () => {
    const h = harness();
    const r = await h.run.call(IMAGE_TOOL.openai, { prompt: "A clean wordmark for Harbor Pine", name: "Wordmark" });
    const file = /File: (.+)/.exec(r.text)![1].trim();
    const saved = await h.run.call(IMAGE_TOOL.brand, { file });
    expect(saved.isError).toBeFalsy();
    expect(existsSync(join(h.cwd, "brand", "wordmark.png"))).toBe(true);
    expect((await h.run.call(IMAGE_TOOL.brand, { file: "C:/Windows/win.ini" })).isError).toBe(true);
  });
});

// ---------------------------------------------------------------- the studio

describe("the studio", () => {
  it("says what is wrong with Codex and how to fix it, by machine name", () => {
    const at = { checkedAt: 1 };
    expect(openaiNote({ installed: false, version: null, signedIn: null, method: null, ...at }, "homebase-server")).toContain("npm i -g @openai/codex");
    expect(openaiNote({ installed: true, version: "0.144.5", signedIn: false, method: null, ...at }, "homebase-server")).toContain("Codex is not signed in on homebase-server. Run `codex login` there");
    expect(openaiNote({ installed: true, version: "0.144.5", signedIn: true, method: "api_key", ...at }, "homebase-server")).toContain("API key");
    expect(openaiNote({ installed: true, version: "0.144.5", signedIn: true, method: "chatgpt", ...at }, "homebase-server")).toBeNull();
  });

  it("reports facts only: readiness, version, plan numbers and the caps", async () => {
    const codex = new FakeCodex(tmp("out"));
    const changes: number[] = [];
    const studio = new ImageStudio({ dataDir: tmp("data"), hub: () => null, codex, host: "test-host", onChange: () => changes.push(1), env: {} });
    await studio.start();
    expect(studio.facts()).toMatchObject({
      openai: { ready: true, cliVersion: "9.9.9", signedIn: true, method: "chatgpt", note: null, plan: "plus", usedPercent: 12, windowMins: 10080, imagesLastHour: 0, capPerHour: 20, capPerRun: 4 },
      saveDir: "assets/generated", brandDir: "brand",
    });
    expect(changes.length).toBeGreaterThan(0);
    codex.ready = { installed: true, version: "9.9.9", signedIn: false, method: null };
    await studio.check();
    expect(studio.facts().openai).toMatchObject({ ready: false, signedIn: false, note: "Codex is not signed in on test-host. Run `codex login` there (`codex login --device-auth` on a machine without a browser)." });
    await studio.stop();
  });

  it("lets the image tools through the permission prompt and leaves every other tool to the usual policy", () => {
    const studio = new ImageStudio({ dataDir: tmp("data"), hub: () => null, codex: new FakeCodex(tmp("out")), env: {} });
    const env = { cwd: tmp("cwd"), profile: "strict" as const, mode: "manual" as const };
    expect(studio.decide("mcp__images__openai_image", { prompt: "x" }, env)).toMatchObject({ tier: "auto", silent: true });
    expect(studio.decide("mcp__images__claude_graphic", {}, env)).toMatchObject({ tier: "auto" });
    expect(studio.decide("Bash", { command: "rm -rf /" }, env).tier).not.toBe("auto");
    expect(studio.decide("mcp__other__thing", {}, env)).toMatchObject({ tier: "ask" });
  });

  it("reads the caps from the environment", () => {
    const studio = new ImageStudio({ dataDir: tmp("data"), hub: () => null, codex: new FakeCodex(tmp("out")), env: { HB_IMAGES_PER_RUN: "2", HB_IMAGES_PER_HOUR: "5" } });
    expect(studio.caps).toEqual({ perRun: 2, perHour: 5 });
  });
});
