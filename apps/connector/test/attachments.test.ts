import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_CAPABILITY, newId, type Agent, type Message, type MessageAttachment, type Run, type RunEventKind } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { createClaudeCodeAdapter, loadImageBlock, userLineWithImages } from "../src/adapters/claude-code";
import type { ApprovalDecision, RunContext } from "../src/adapters/types";
import { claudeWorkspaces } from "../src/config";
import { HubLink } from "../src/HubLink";
import { fakeClaude, fixture, testConfig, turnsOf } from "./claude-fixtures";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 3, ...Array(9).fill(0), 0xff, 0xd9]);
const listFiles = turnsOf(fixture("claude-list-files.jsonl"));
const twoTurns = turnsOf(fixture("claude-denied-then-followup.jsonl"));
const approve: ApprovalDecision = { decision: "approve", message: null, answers: null, remember: false };
const att = (over: Partial<MessageAttachment> = {}): MessageAttachment => ({ id: newId("att"), kind: "image", mime: "image/png", bytes: PNG.length, width: 1, height: 1, ...over });

const dirs: string[] = [];
const sandbox = () => {
  const d = mkdtempSync(join(tmpdir(), "hb-att-claude-"));
  dirs.push(d);
  return d;
};
const servers: ApprovalServer[] = [];
const approvalServer = () => {
  const s = new ApprovalServer();
  servers.push(s);
  return s;
};
let app: HubApp | null = null;
let link: HubLink | null = null;
const clients: Array<{ client: { stop(): void } }> = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.client.stop();
  link?.stop();
  link = null;
  await app?.close();
  app = null;
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(over: { prompt?: string; attachments?: MessageAttachment[]; load?: RunContext["loadAttachment"] } = {}) {
  const events: Array<{ kind: RunEventKind; data: any }> = [];
  const statuses: Array<{ status: string; extra: any }> = [];
  const ctx: RunContext = {
    run: { id: "run_test", agentKey: "claude", threadId: null, prompt: over.prompt ?? "What is on this screen?", cwd: null, resumeSessionRef: null, attachments: over.attachments },
    signal: new AbortController().signal,
    emit: (kind, data) => void events.push({ kind, data }),
    status: (status, extra) => void statuses.push({ status, extra: extra ?? {} }),
    requestApproval: async () => approve,
    loadAttachment: over.load,
  };
  return { ctx, events, statuses };
}

describe("pictures as image content for the CLI", () => {
  it("the stream-json line puts each picture first as a base64 image block, then the words", () => {
    const line = JSON.parse(userLineWithImages("What is wrong?", [{ mime: "image/png", data: "AAA=" }, { mime: "image/jpeg", data: "BBB=" }]));
    expect(line).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB=" } },
          { type: "text", text: "What is wrong?" },
        ],
      },
    });
    // Pictures with no words go alone; no pictures is the plain text line as before.
    expect(JSON.parse(userLineWithImages("  ", [{ mime: "image/png", data: "AAA=" }])).message.content).toHaveLength(1);
    expect(JSON.parse(userLineWithImages("hi", [])).message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("the picture's type comes from its bytes; a non-image or a slow hub is an error", async () => {
    expect(await loadImageBlock(att({ mime: "image/png" }), async () => JPEG)).toEqual({ mime: "image/jpeg", data: JPEG.toString("base64") });
    await expect(loadImageBlock(att(), async () => new TextEncoder().encode("<html>"))).rejects.toThrow(/not a PNG/);
    await expect(loadImageBlock(att(), undefined)).rejects.toThrow(/cannot fetch/);
    await expect(loadImageBlock(att(), () => new Promise(() => {}), 20)).rejects.toThrow(/in time/);
  });

  it("the first turn and a follow-up both carry their pictures; the timeline says how many went", async () => {
    const a = att();
    const b = att({ mime: "image/jpeg" });
    const bytes: Record<string, Buffer> = { [a.id]: PNG, [b.id]: JPEG };
    const fake = fakeClaude((_call, turn) => twoTurns[turn]);
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: sandbox() }), approvals: approvalServer(), spawnFn: fake.spawn, env: {} });
    const h = harness({ attachments: [a], load: async (x) => bytes[x.id] });
    const handle = adapter.start(h.ctx);
    handle.input("and this one", [b]);
    await handle.done;
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].inputs).toEqual(["What is on this screen?", "and this one"]);
    expect(fake.calls[0].contents![0]).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
      { type: "text", text: "What is on this screen?" },
    ]);
    expect(fake.calls[0].contents![1][0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") } });
    const said = h.events.filter((e) => e.kind === "system" && e.data.attachments).map((e) => e.data.message);
    expect(said).toEqual(["1 image attached to this message", "1 image attached to this message"]);
    expect(h.statuses.at(-1)!.status).toBe("succeeded");
  });

  it("a picture that cannot be had is named on the timeline and to the agent, and the rest still go", async () => {
    const good = att();
    const bad = att({ name: "lost.png" });
    const fake = fakeClaude(() => listFiles[0]);
    const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: sandbox() }), approvals: approvalServer(), spawnFn: fake.spawn, env: {} });
    const h = harness({ attachments: [good, bad], load: async (x) => (x.id === good.id ? PNG : Promise.reject(new Error("the hub answered 404"))) });
    await adapter.start(h.ctx).done;
    const content = fake.calls[0].contents![0];
    expect(content.filter((c) => c.type === "image")).toHaveLength(1);
    expect(content.at(-1)!.text).toMatch(/^What is on this screen\?\n\n\[HomeBase: 1 image the owner attached could not be loaded/);
    expect(h.events.find((e) => e.kind === "error")!.data.message).toBe("1 image could not be given to Claude: lost.png (the hub answered 404)");
  });
});

describe("pictures from a device to Claude, through the hub", () => {
  it("a device uploads, sends; every device sees the picture on the message; the CLI gets the same bytes", async () => {
    const box = sandbox();
    const cfg = testConfig({ sandboxDir: box });
    const fake = fakeClaude(() => listFiles[0]);
    app = await bootHub();
    const { token } = pairToken(app, "connector", "claude-connector");
    link = new HubLink({
      hubUrl: app.url, token, name: "claude-connector", log: () => {},
      agents: [{
        key: cfg.key, name: cfg.name, kind: "claude", description: "Claude", capabilities: ["code", ATTACHMENT_CAPABILITY], workspaces: claudeWorkspaces(cfg),
        permissionProfile: cfg.permissionProfile, statusNote: null,
        adapter: createClaudeCodeAdapter({ config: cfg, approvals: approvalServer(), spawnFn: fake.spawn, env: {} }),
      }],
    });
    link.start();
    await link.whenReady();
    const desktop = await connectDevice(app, "Desktop");
    const phone = await connectDevice(app, "Phone");
    clients.push(desktop, phone);
    const agent = (await waitFor(() => (desktop.list("agents") as Agent[]).find((a) => a.key === "claude" && a.status === "online"), "agent online")) as Agent;

    // Upload once, over HTTP, with the device's own token.
    const id = newId("att");
    const up = await fetch(`${app.url}/v1/attachments/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${desktop.token}`, "Content-Type": "image/png", "X-File-Name": "snip.png" }, body: new Uint8Array(PNG) });
    expect(up.status).toBe(200);
    const attachment = ((await up.json()) as { attachment: MessageAttachment }).attachment;

    const threadId = newId("thr");
    await desktop.client.mutate("thread.create", { threadId, title: "New session", agentId: agent.id });
    await desktop.client.mutate("message.send", { threadId, messageId: newId("msg"), text: "What is on this screen?", source: "text", attachments: [attachment] });

    await waitFor(() => (desktop.list("runs") as Run[]).find((r) => r.threadId === threadId && r.status === "succeeded"), "run done");
    expect(fake.calls[0].contents![0][0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
    // The phone sees the same message with the same picture facts (no bytes in the sync data).
    const onPhone = (await waitFor(() => (phone.list("messages") as Message[]).find((m) => m.threadId === threadId && m.role === "user"), "message on the phone")) as Message;
    expect(onPhone.attachments).toEqual([{ ...attachment, name: "snip.png" }]);
    expect(JSON.stringify(onPhone).length).toBeLessThan(1000);
  });
});
