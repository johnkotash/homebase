// A throwaway local stack for looking at the Comms agent in a client without a real mailbox:
// an in-memory hub on a fixed port, the Comms agent with the real Claude Code CLI, and the fake Gmail.
//   node --import tsx apps/connector/test/demo-comms.ts [--port 8791]      then pair a client at http://localhost:8791
// Nothing is written outside a temp folder; stop it with Ctrl+C. No real mailbox, no real email.
import { rmSync } from "node:fs";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { checkClaude } from "../src/adapters/claude-code";
import { loadClaudeConfig } from "../src/config";
import { CommsAgent } from "../src/gmail/comms";
import { HubLink } from "../src/HubLink";
import { FakeGmail, seedDemoMailbox } from "./fake-gmail";
import { gmailBox } from "./gmail-helpers";
import { bootHub, pairToken } from "./harness";

const at = process.argv.indexOf("--port");
const port = at > 0 ? Number(process.argv[at + 1]) : 8791;
const fake = await new FakeGmail().start();
seedDemoMailbox(fake);
const box = gmailBox(fake, { connected: !process.argv.includes("--disconnected") });
const base = { ...loadClaudeConfig("/nonexistent/claude-agent.json", { ...process.env, HB_CLAUDE_MODEL: process.env.HB_E2E_MODEL ?? "haiku" }), maxTurns: 12 };
const ready = await checkClaude(base);
const app = await bootHub({ port, quiet: false });
const approvals = new ApprovalServer();
let link: HubLink | null = null;
const comms = new CommsAgent({
  base, approvals, env: { ...process.env, ...box.env, HB_COMMS_OWNER_NAME: "Alex" }, pollMs: 60_000, log: (...a) => console.log("[comms]", ...a),
  cliReadiness: async () => ready,
  emitInbox: (item) => link?.ingestInbox(item) ?? false,
  onChange: () => link?.updateAgent("comms", comms.registration()),
});
comms.setCli(ready);
await comms.check();
link = new HubLink({ hubUrl: app.url, token: pairToken(app, "connector", "demo-connector").token, name: "demo-connector", agents: [{ ...comms.registration(), adapter: comms.adapter }] });
link.start();
await link.whenReady();
await comms.poll();
console.log(`\nDemo hub: ${app.url}   fake Gmail: ${fake.url} (${fake.account})`);
console.log(`Device pairing code: ${app.directory.createPairingCode("device", null, 3_600_000).code}\n`);
const bye = async () => {
  link?.stop();
  await comms.stop();
  await approvals.stop();
  await app.close();
  await fake.stop();
  rmSync(box.dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
