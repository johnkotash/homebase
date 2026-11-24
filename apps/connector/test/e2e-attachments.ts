// End-to-end check of pictures on a message with the REAL Claude Code CLI (2026-11-23).
//   node --import tsx apps/connector/test/e2e-attachments.ts            (model: haiku; uses the Claude Code login on this machine)
//   node --import tsx apps/connector/test/e2e-attachments.ts --serve --port 8795 --data <scratch dir>
//        keeps the scratch hub and the Claude agent running for a browser check, and prints a device pairing code.
// A hub, a paired device and the connector's Claude agent run locally. A picture with a word and a number on it is
// uploaded the way the app does it, sent on a message, and Claude must read them back. Nothing touches homebase-server.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ATTACHMENT_CAPABILITY, newId, type Agent, type Message, type MessageAttachment, type Run } from "@homebase/protocol";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { checkClaude, createClaudeCodeAdapter } from "../src/adapters/claude-code";
import { claudeWorkspaces, loadClaudeConfig } from "../src/config";
import { HubLink } from "../src/HubLink";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const serve = argv.includes("--serve");
const log = (...a: unknown[]) => console.log(...a);

const box = mkdtempSync(join(tmpdir(), "hb-e2e-att-"));
const dataDir = opt("--data") ?? mkdtempSync(join(tmpdir(), "hb-e2e-att-data-"));
const cfg = { ...loadClaudeConfig("/nonexistent/claude-agent.json", { ...process.env, HB_CLAUDE_MODEL: process.env.HB_E2E_MODEL ?? "haiku", HB_CLAUDE_SANDBOX: box }), sandboxDir: box, maxTurns: 6 };
const ready = await checkClaude(cfg);
if (!ready.ok) {
  console.error(`Claude Code is not ready on this machine: ${ready.note}`);
  process.exit(2);
}
const app = await bootHub({ dbPath: join(dataDir, "homebase.db"), port: Number(opt("--port") ?? 0), seed: { demo: false } });
const approvals = new ApprovalServer();
const link = new HubLink({
  hubUrl: app.url, token: pairToken(app, "connector", "e2e-connector").token, name: "e2e-connector", log: () => {},
  agents: [
    {
      key: cfg.key, name: cfg.name, kind: "claude", description: "Claude (scratch check)", capabilities: ["code", ATTACHMENT_CAPABILITY], workspaces: claudeWorkspaces(cfg),
      permissionProfile: cfg.permissionProfile, statusNote: null, modes: ["manual", "auto"],
      adapter: createClaudeCodeAdapter({ config: cfg, approvals, log: (...a) => log("   [claude]", ...a) }),
    },
    // An agent that cannot look at pictures, to check the refusal in the app.
    { key: "ops", name: "Ops agent", kind: "mock", description: "Scripted", capabilities: ["logs"], workspaces: [], adapter: { kind: "mock", start: () => { throw new Error("not used"); } } },
  ],
});
link.start();
await link.whenReady();
log(`Claude Code ${ready.version}, model ${cfg.model}; scratch hub ${app.url}, data ${dataDir}`);

if (serve) {
  const { code } = app.directory.createPairingCode("device", null, 60 * 60_000);
  log(`\nServing. Device pairing code: ${code}  (hub ${app.url}). Ctrl+C to stop.`);
  const stop = async () => {
    link.stop();
    await approvals.stop();
    await app.close();
    rmSync(box, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  let exit = 0;
  try {
    const phone = await connectDevice(app, "Phone");
    const agent = (await waitFor(() => (phone.list("agents") as Agent[]).find((a) => a.key === cfg.key && a.status === "online"), "claude online")) as Agent;
    // A picture only the model's own eyes can read: a word and a number drawn as text.
    const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="100%" height="100%" fill="#fff"/><text x="40" y="150" font-family="Arial" font-size="110" font-weight="700" fill="#000">ZEBRA 47</text></svg>`)).png().toBuffer();
    const id = newId("att");
    const up = await fetch(`${app.url}/v1/attachments/${id}`, { method: "PUT", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "image/png", "X-File-Name": "zebra.png" }, body: new Uint8Array(png) });
    const attachment = ((await up.json()) as { attachment: MessageAttachment }).attachment;
    log(`uploaded ${attachment.id}: ${attachment.mime} ${attachment.width} x ${attachment.height}, ${attachment.bytes} bytes`);
    const threadId = newId("thr");
    await phone.client.mutate("thread.create", { threadId, title: "Picture check", agentId: agent.id });
    await phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text: "What word and what number are written in the attached image? Reply with exactly the word and the number, nothing else. Do not use any tools.", source: "text", attachments: [attachment] });
    const run = (await waitFor(() => (phone.list("runs") as Run[]).find((r) => r.threadId === threadId && ["succeeded", "failed", "cancelled"].includes(r.status)), "run done", 180_000)) as Run;
    await new Promise((r) => setTimeout(r, 300));
    const reply = (phone.list("messages") as Message[]).filter((m) => m.threadId === threadId && m.role === "assistant").map((m) => m.text).join("\n");
    const events = app.store.all<{ kind: string; data: string }>("SELECT kind, data FROM run_events WHERE run_id = ? ORDER BY idx", run.id).map((e) => ({ kind: e.kind, data: JSON.parse(e.data) }));
    const tools = events.filter((e) => e.kind === "tool_call").map((e) => e.data.tool);
    log(`run ${run.status}${run.error ? `: ${run.error}` : ""}; reply: ${JSON.stringify(reply)}; tools used: ${tools.join(", ") || "none"}`);
    log(`timeline: ${events.filter((e) => e.kind === "system").map((e) => e.data.message).join(" | ")}`);
    const ok = run.status === "succeeded" && /zebra/i.test(reply) && /47/.test(reply);
    log(ok ? "PASS  Claude read the word and the number from the picture" : "FAIL  Claude did not read the picture");
    if (!ok) exit = 1;
    phone.client.stop();
  } catch (err) {
    console.error(err);
    exit = 1;
  }
  link.stop();
  await approvals.stop();
  await app.close();
  rmSync(box, { recursive: true, force: true });
  if (!opt("--data")) rmSync(dataDir, { recursive: true, force: true });
  process.exit(exit);
}
