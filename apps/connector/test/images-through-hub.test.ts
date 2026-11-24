import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { IMAGES_MCP_SERVER, MAKER_QUESTION, newId, type Agent, type Approval, type GeneratedImageCard, type Message, type Run } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { createClaudeCodeAdapter } from "../src/adapters/claude-code";
import type { CodexClient, CodexImageResult } from "../src/images/codex";
import { ImageStudio } from "../src/images/studio";
import { loadRenderer } from "../src/images/svg";
import { HubLink } from "../src/HubLink";
import { askApprovalTool, fakeClaude, testConfig } from "./claude-fixtures";
import { cliTurn } from "./gmail-helpers";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080"><rect width="1080" height="1080" fill="#111"/><text x="540" y="560" font-family="sans-serif" font-size="96" fill="#fff" text-anchor="middle">20% off</text></svg>';

/** Stands in for the Codex CLI: writes a PNG where Codex would. */
class FakeCodex implements CodexClient {
  calls: Array<{ prompt: string; references: string[] }> = [];
  signedIn = true;
  constructor(private dir: string) {}
  async status() {
    return { installed: true, version: "9.9.9", signedIn: this.signedIn, method: this.signedIn ? "chatgpt" : null, checkedAt: Date.now() };
  }
  async limits() {
    return { plan: "plus", usedPercent: 12, windowMins: 10080, resetsAt: 1795716883000, limitReached: false };
  }
  async image(req: { prompt: string; references: string[] }): Promise<CodexImageResult> {
    this.calls.push({ prompt: req.prompt, references: req.references });
    const file = join(this.dir, `gen-${this.calls.length}.png`);
    writeFileSync(file, PNG);
    return { ok: true, file, threadId: "0199fake", note: "Created one image.", seconds: 26.1, usage: null };
  }
}

/** Talks to the image tools the way the CLI does, using the entry from a run's --mcp-config. */
async function imagesMcp(mcpConfig: string) {
  const server = JSON.parse(mcpConfig).mcpServers[IMAGES_MCP_SERVER] as { url: string; headers: Record<string, string> };
  const client = new Client({ name: "fake-claude", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  return {
    list: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name: string, args: Record<string, unknown>) => {
      const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000 });
      return { text: String(res.content?.[0]?.text ?? ""), isError: res.isError === true };
    },
    close: () => client.close(),
  };
}

/** Claude leads, OpenAI or Claude makes the image: real hub, real sockets, the real Claude adapter with a scripted CLI and a stand-in for Codex. */
describe("images through the hub", () => {
  let app: HubApp | null = null;
  let link: HubLink | null = null;
  let studio: ImageStudio | null = null;
  const clients: Array<{ client: { stop(): void } }> = [];
  const servers: ApprovalServer[] = [];
  const dirs: string[] = [];
  const tmp = (n: string) => {
    const d = mkdtempSync(join(tmpdir(), `hb-imgs-${n}-`));
    dirs.push(d);
    return d;
  };
  afterEach(async () => {
    for (const c of clients.splice(0)) c.client.stop();
    link?.stop();
    link = null;
    await studio?.stop();
    studio = null;
    for (const s of servers.splice(0)) await s.stop();
    await app?.close();
    app = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function boot(script: Parameters<typeof fakeClaude>[0]) {
    const cwd = tmp("cwd");
    const codex = new FakeCodex(tmp("codex"));
    const cli = fakeClaude(script);
    const approvals = new ApprovalServer();
    servers.push(approvals);
    app = await bootHub();
    const { token } = pairToken(app, "connector", "pc-connector");
    const hubUrl = app.url;
    const s = new ImageStudio({ dataDir: tmp("data"), hub: () => ({ url: hubUrl, token }), codex, host: "test-host", env: {}, onChange: () => link?.updateAgent("claude", { images: s.facts() }) });
    studio = s;
    await s.start();
    const adapter = s.wrap(createClaudeCodeAdapter({
      config: testConfig({ command: process.execPath, sandboxDir: cwd }), approvals, spawnFn: cli.spawn, decide: s.decide, extraMcp: s.extraMcp,
      readiness: async () => ({ ok: true, version: "2.1.319", note: null, checkedAt: Date.now() }),
    }));
    // Follow-ups the connector has handed to the run, so a test can wait for one to arrive.
    const inputs: string[] = [];
    const counted = { kind: adapter.kind, start: (ctx: any) => { const h = adapter.start(ctx); return { ...h, input: (text: string) => { inputs.push(text); h.input(text); } }; } };
    link = new HubLink({
      hubUrl, token, name: "pc-connector", log: () => {},
      agents: [{ key: "claude", name: "Claude agent", kind: "claude", description: "", capabilities: ["images"], workspaces: [{ label: "sandbox", cwd }], modes: ["manual", "auto"], images: s.facts(), adapter: counted }],
    });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    clients.push(phone);
    const agent = (await waitFor(() => (phone.list("agents") as Agent[]).find((a) => a.key === "claude" && a.status === "online"), "claude agent online")) as Agent;
    const threadId = newId("thr");
    await phone.client.mutate("thread.create", { threadId, title: "Social", agentId: agent.id });
    const say = (text: string) => phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    const runs = () => (phone.list("runs") as Run[]).filter((r) => r.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const messages = () => (phone.list("messages") as Message[]).filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const cards = () => messages().filter((m) => m.card?.type === "generated_image").map((m) => m.card as GeneratedImageCard);
    const fetchArtifact = (id: string) => fetch(`${hubUrl}/v1/artifacts/${id}`, { headers: { Authorization: `Bearer ${phone.token}` } });
    const agentNow = () => (phone.list("agents") as Agent[]).find((a) => a.key === "claude")!;
    const events = (runId: string) => app!.store.all<{ kind: string; data: string }>("SELECT kind, data FROM run_events WHERE run_id = ? ORDER BY idx", runId).map((e) => ({ kind: e.kind, data: JSON.parse(e.data) }));
    return { cwd, codex, cli, phone, agent, agentNow, threadId, say, runs, messages, cards, fetchArtifact, events, studio: s, inputs };
  }

  it("a plain request: no question, OpenAI makes it, the session shows a card marked OpenAI and every device can load the picture", async () => {
    let tools: string[] = [];
    let result = "";
    const s = await boot(async (call) => {
      const cfg = call.arg("--mcp-config")!;
      const mcp = await imagesMcp(cfg);
      tools = await mcp.list();
      const input = { prompt: "Square spring sale post, headline 'Spring sale', pastel", name: "Spring sale post" };
      // The CLI asks HomeBase before any MCP tool; the image tools are let through because their own gate does the asking.
      expect((await askApprovalTool(cfg, { tool_name: "mcp__images__openai_image", input })).behavior).toBe("allow");
      result = (await mcp.call("openai_image", input)).text;
      await mcp.close();
      return cliTurn("The spring sale post is ready.");
    });
    expect(s.agent.images).toMatchObject({ openai: { ready: true, cliVersion: "9.9.9", plan: "plus", usedPercent: 12 }, saveDir: "assets/generated" });
    await s.say("generate a social media graphic for the spring sale");
    const run = (await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "run done")) as Run;
    expect(tools).toEqual(["openai_image", "claude_graphic", "choose_maker", "save_to_brand"]);
    expect(result).toContain("OpenAI made the image");
    expect(s.phone.list("approvals")).toEqual([]);
    expect(s.codex.calls).toHaveLength(1);
    const [card] = s.cards();
    expect(card).toMatchObject({ maker: "openai", via: "ChatGPT plan · via Codex CLI", name: "Spring sale post", mime: "image/png", stored: true, base: null });
    expect(card.savedPath).toMatch(/^assets\/generated\/\d{4}-\d{2}-\d{2}-spring-sale-post\.png$/);
    expect(readFileSync(join(s.cwd, card.savedPath!)).equals(PNG)).toBe(true);
    const res = await s.fetchArtifact(card.artifactId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    // The card sits between the owner's message and Claude's reply, and the timeline says why OpenAI.
    expect(s.messages().map((m) => m.card?.type ?? m.role)).toEqual(["user", "generated_image", "assistant"]);
    expect(s.events(run.id).some((e) => e.kind === "system" && e.data.imageRoute?.maker === "openai" && /Nothing in your message said otherwise/.test(e.data.message))).toBe(true);
    // Nothing was auto-approved on the audit trail for it: the image has its own audit entry.
    expect(app!.store.all("SELECT 1 FROM audit_log WHERE action = 'approval.auto'")).toEqual([]);
    expect(app!.store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'image.made'").map((r) => JSON.parse(r.detail))).toEqual([expect.objectContaining({ maker: "openai", name: "Spring sale post" })]);
  });

  it("an ambiguous request: one question on the phone, one tap answers it, and the other maker's work shows as a card marked Claude", async () => {
    const log: string[] = [];
    const s = await boot(async (call, turn, text) => {
      const mcp = await imagesMcp(call.arg("--mcp-config")!);
      try {
        if (turn === 0) {
          // The tool makes nothing and says the owner's answer is coming; the agent ends its turn.
          log.push((await mcp.call("openai_image", { prompt: "Photo of a small shop front with the text '20% off'", name: "Shop offer" })).text);
          return cliTurn("One moment.");
        }
        // The owner's tap arrives as their next message, and the agent does what it says.
        log.push(text);
        log.push((await mcp.call("claude_graphic", { svg: SVG, name: "Shop offer", description: "Dark square card with '20% off'" })).text);
        return cliTurn("Done: I drew it as a graphic.", false);
      } finally {
        await mcp.close();
      }
    });
    await s.say("a photo of the shop with a text overlay saying 20% off");
    const q = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "the question")) as Approval;
    expect(q).toMatchObject({ kind: "question", risk: "low", title: MAKER_QUESTION, tool: "mcp__images__openai_image" });
    expect(q.questions![0].options.map((o) => o.label)).toEqual(["OpenAI image", "Claude overlay / SVG", "Both"]);
    expect(q.reason).toContain("points both ways");
    expect(s.runs()[0].status).toBe("waiting_approval");
    expect(s.codex.calls).toEqual([]);
    // One tap: the label is the answer.
    await s.phone.client.mutate("approval.decide", { approvalId: q.id, decision: "approve", answers: { [MAKER_QUESTION]: "Claude overlay / SVG" } });
    await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "run done");
    expect(log[0]).toContain("Their answer arrives as their next message");
    expect(log[1]).toBe("(Tapped in HomeBase) Claude overlay / SVG: make this one yourself, as an SVG graphic.");
    expect(log[2]).toContain("Stored “Shop offer”");
    expect(s.runs()).toHaveLength(1);
    expect(s.codex.calls).toEqual([]);
    const [card] = s.cards();
    expect(card).toMatchObject({ maker: "claude", via: "Claude plan · SVG", mime: "image/svg+xml", name: "Shop offer", routedWhy: "You chose Claude overlay / SVG." });
    const svg = await s.fetchArtifact(card.artifactId);
    expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await svg.text()).toBe(SVG);
    if (await loadRenderer()) {
      expect(card.previewId).toBe(`${card.artifactId}p`);
      expect((await s.fetchArtifact(card.previewId!)).headers.get("Content-Type")).toBe("image/png");
    }
    expect((s.phone.list("approvals") as Approval[])[0]).toMatchObject({ status: "approved", answers: { [MAKER_QUESTION]: "Claude overlay / SVG" } });
  });

  it("a session set to Off gets no image tools at all; set back, they return", async () => {
    const seen: boolean[] = [];
    const s = await boot(async (call) => {
      seen.push(IMAGES_MCP_SERVER in JSON.parse(call.arg("--mcp-config")!).mcpServers);
      return cliTurn("ok");
    });
    await s.phone.client.mutate("images.set", { scope: "thread", id: s.threadId, route: "off" });
    await s.say("make a picture of a kite");
    await waitFor(() => s.runs().filter((r) => r.status === "succeeded").length === 1, "first run");
    await s.phone.client.mutate("images.set", { scope: "thread", id: s.threadId, route: null });
    await s.say("make a picture of a kite");
    await waitFor(() => s.runs().filter((r) => r.status === "succeeded").length === 2, "second run");
    expect(seen).toEqual([false, true]);
  });

  it("Codex signed out: the agent page says so with the command, the session shows a card under OpenAI's name, and nothing is generated", async () => {
    let result = { text: "", isError: false };
    const s = await boot(async (call) => {
      const mcp = await imagesMcp(call.arg("--mcp-config")!);
      result = await mcp.call("openai_image", { prompt: "Square spring sale post, pastel" });
      await mcp.close();
      return cliTurn("OpenAI is not signed in on this machine.");
    });
    s.codex.signedIn = false;
    await s.studio.check();
    await waitFor(() => s.agentNow().images?.openai.ready === false, "the agent's facts");
    expect(s.agentNow().images!.openai.note).toBe("Codex is not signed in on test-host. Run `codex login` there (`codex login --device-auth` on a machine without a browser).");
    await s.say("generate a social media graphic for the spring sale");
    await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "run done");
    expect(result.isError).toBe(true);
    expect(s.codex.calls).toEqual([]);
    const issue = s.messages().find((m) => m.card?.type === "image_issue")!;
    expect(issue.card).toMatchObject({ maker: "openai", reason: "not_ready", title: "not connected" });
    expect(s.cards()).toEqual([]);
  });

  it("a follow-up in the same run is what the routing rule reads next", async () => {
    const answers: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const s = await boot(async (call, turn) => {
      const mcp = await imagesMcp(call.arg("--mcp-config")!);
      if (turn === 0) {
        await gate; // the owner's second message arrives while this turn is still going
        await mcp.close();
        return cliTurn("Which one?");
      }
      // The second turn: the message named Claude, so OpenAI's tool is turned away without a question.
      answers.push((await mcp.call("openai_image", { prompt: "A badge that says 20% off, flat colours" })).text);
      await mcp.close();
      return cliTurn("I will draw it myself.", false);
    });
    await s.say("I need something for the sale");
    await waitFor(() => s.cli.calls.length === 1 && s.cli.calls[0].inputs.length === 1, "first turn started");
    await s.say("have Claude draw a badge as an SVG");
    await waitFor(() => s.inputs.length === 1, "the follow-up reaching the run");
    release();
    await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "run done");
    expect(answers[0]).toContain("The owner's message asked for Claude by name");
    expect(s.phone.list("approvals")).toEqual([]);
    expect(s.codex.calls).toEqual([]);
  });
});
