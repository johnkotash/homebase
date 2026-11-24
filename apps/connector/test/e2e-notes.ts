// End-to-end check of the Notes agent with the REAL Claude Code CLI against a FIXTURE vault.
//   node --import tsx apps/connector/test/e2e-notes.ts            (model: haiku; uses the Claude Code login on this machine)
// Everything else is local: an in-memory hub, a paired "phone", the connector's Notes agent, and a
// throwaway vault in a throwaway git repository with a bare remote. The real vault is never touched.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { newId, type Agent, type Approval, type Message, type Run } from "@homebase/protocol";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { checkClaude } from "../src/adapters/claude-code";
import { loadClaudeConfig } from "../src/config";
import { HubLink } from "../src/HubLink";
import { NotesAgent } from "../src/vault/agent";
import { assertAdditive } from "../src/vault/daily";
import { AGENT_AUTHOR } from "../src/vault/git";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";
import { UNRELATED_MARKER, makeVault } from "./vault-fixture";

const log = (...a: unknown[]) => console.log(...a);
const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push([name, ok, detail]);
  log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const fx = makeVault();
const base = { ...loadClaudeConfig("/nonexistent/claude-agent.json", { ...process.env, HB_CLAUDE_MODEL: process.env.HB_E2E_MODEL ?? "haiku" }) };
const ready = await checkClaude(base);
if (!ready.ok) {
  console.error(`Claude Code is not ready on this machine: ${ready.note}`);
  fx.cleanup();
  process.exit(2);
}
const app = await bootHub();
const approvals = new ApprovalServer();
const inits: any[] = [];
const spawnTee: any = (file: string, args: string[], opts: any) => {
  const p = spawn(file, args, opts);
  let buf = "";
  p.stdout?.on("data", (c: Buffer) => {
    buf += c.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.includes('"subtype":"init"')) try { inits.push({ ...JSON.parse(line), args, cwd: opts.cwd }); } catch { /* partial */ }
    }
  });
  return p;
};
let link: HubLink | null = null;
const notes = new NotesAgent({
  base, approvals, env: { ...process.env, ...fx.env }, spawnFn: spawnTee, log: (...a) => log("   [notes]", ...a),
  git: { sweepMs: 0, pushEveryMs: 0, pushDelayMs: 3_600_000, settleMs: 0 }, service: { watch: false },
  cliReadiness: async () => ready,
  emitIndex: (f) => link?.sendVaultIndex(f) ?? false,
  onChange: () => link?.updateAgent("notes", notes.registration()),
});
await notes.start();
link = new HubLink({
  hubUrl: app.url, token: pairToken(app, "connector", "e2e-connector").token, name: "e2e-connector", log: () => {},
  agents: [{ ...notes.registration(), adapter: notes.adapter }], onReady: () => notes.sendFullIndex(), onVaultRequest: (op, args) => notes.handleRequest(op, args),
});
link.start();
await link.whenReady();
const phone = await connectDevice(app, "Phone");
const agent = (await waitFor(() => (phone.list("agents") as Agent[]).find((a) => a.key === "notes" && a.status === "online"), "notes online")) as Agent;
log(`Claude Code ${ready.version}, model ${notes.config.model}; fixture vault ${fx.vault}`);
log(`Agent: ${agent.name}, default mode ${agent.defaultMode}, ${agent.vault?.files} notes indexed`);

/** Sends one message in a chat, denies any approval, and waits for the run to end. */
async function chat(threadId: string, text: string, dictated: boolean) {
  const before = new Set((phone.list("runs") as Run[]).map((r) => r.id));
  const sent = Date.now();
  await phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text, source: dictated ? "voice" : "text", ...(dictated ? { capturedAt: Date.now(), tz: "America/New_York" } : {}) });
  const asked: Approval[] = [];
  const seen = new Set<string>();
  const run = await waitFor(() => {
    for (const a of phone.list("approvals") as Approval[]) {
      if (a.status !== "pending" || seen.has(a.id)) continue;
      seen.add(a.id);
      asked.push(a);
      log(`   approval asked: [${a.risk}] ${a.title} -> deny`);
      void phone.client.mutate("approval.decide", { approvalId: a.id, decision: "deny" });
    }
    return (phone.list("runs") as Run[]).find((r) => r.threadId === threadId && !before.has(r.id) && ["succeeded", "failed", "cancelled"].includes(r.status));
  }, `run for "${text.slice(0, 40)}"`, 300_000) as Run;
  await new Promise((r) => setTimeout(r, 400));
  const messages = (phone.list("messages") as Message[]).filter((m) => m.threadId === threadId && m.createdAt >= sent - 5).sort((a, b) => a.createdAt - b.createdAt);
  const events = app.store.all<{ kind: string; data: string }>("SELECT kind, data FROM run_events WHERE run_id = ? ORDER BY idx", run.id).map((e) => ({ kind: e.kind, data: JSON.parse(e.data) }));
  const reply = messages.filter((m) => m.role === "assistant" && !m.card).map((m) => m.text).join("\n");
  log(`   run ${run.status}, ${run.numTurns} turns, $${(run.costUsd ?? 0).toFixed(4)} list price`);
  log(`   agent: ${reply.replace(/\s+/g, " ").slice(0, 600)}`);
  return { run, asked, messages, events, reply, card: messages.find((m) => m.card)?.card as any };
}
const newThread = async (title: string) => {
  const threadId = newId("thr");
  await phone.client.mutate("thread.create", { threadId, title, agentId: agent.id });
  return threadId;
};
const rawFiles = () => {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(fx.vault, ...rel.split("/")), { withFileTypes: true })) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else out[p] = fx.read(p);
    }
  };
  walk("Daily Notes/RAW");
  return out;
};

let exit = 0;
try {
  const now = new Date();
  const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replace(/-/g, "");
  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "long" }).format(now);
  const year = ny.slice(0, 4);
  const generalPath = `Daily Notes/${year}/${monthName}.md`;
  const clientPath = `Daily Notes/Clients/Harbor Pine Realty/${year}/${monthName}.md`;

  log("\n1. Dictation: one known client by an alias, one unknown name");
  const spoken = "Okay daily note. HPR called this morning, they want the open house landing page live by Thursday and I quoted them 400 dollars for the video banner. Also had a first call with Brightwater Plumbing about a new website, they seem interested. And I renewed the SSL cert on the mail server.";
  const generalBefore = (() => { try { return fx.read(generalPath); } catch { return null; } })();
  const clientBefore = (() => { try { return fx.read(clientPath); } catch { return null; } })();
  const t1 = await newThread("Notes");
  const a = await chat(t1, spoken, true);
  const init = inits[0];
  const builtins = (init?.tools ?? []).filter((t: string) => !t.startsWith("mcp__"));
  const mcpTools = (init?.tools ?? []).filter((t: string) => t.startsWith("mcp__")).sort();
  check("the CLI init line lists only Read, Glob and Grep as built-in tools", builtins.length > 0 && builtins.every((t: string) => ["Read", "Glob", "Grep"].includes(t)), builtins.join(","));
  check("the CLI sees exactly the six vault tools (plus HomeBase's approval tool)", mcpTools.filter((t: string) => t.startsWith("mcp__vault__")).length === 6 && mcpTools.every((t: string) => /^mcp__(vault|homebase)__/.test(t)), mcpTools.join(","));
  check("started in the vault with --strict-mcp-config and no skip-permissions flag", init?.cwd === fx.vault && init.args.includes("--strict-mcp-config") && !init.args.join(" ").match(/dangerously|bypass/));
  check("the run succeeded in Auto with no approval asked", a.run.status === "succeeded" && a.run.mode === "auto" && a.asked.length === 0, a.run.error ?? "");
  const general = fx.read(generalPath);
  const client = fx.read(clientPath);
  const tDir = `Daily Notes/RAW/AI Transcriptions/${year}/${ny.slice(4, 6)}`;
  const transcripts = readdirSync(join(fx.vault, ...tDir.split("/")));
  check("one transcript file exists at the documented path", transcripts.length === 1 && new RegExp(`^${year}-${ny.slice(4, 6)}-${ny.slice(6)} \\d{4}\\.md$`).test(transcripts[0]), transcripts.join(","));
  const tText = fx.read(`${tDir}/${transcripts[0]}`);
  check("the transcript holds the dictation verbatim under service-written frontmatter", tText.endsWith(`---\n\n${spoken}\n`) && /^---\ncaptured_at: \d{4}-\d\d-\d\dT[\d:]+-0[45]:00\ndevice: "Phone"\nrun: run_/.test(tText) && tText.includes(`daily: "[[Daily Notes/${year}/${monthName}#${ny}]]"`));
  const src = ` ([[${tDir}/${transcripts[0].replace(/\.md$/, "")}|src]])`;
  const added = (after: string, before: string | null) => (before ? after.slice(before.length) : after);
  const gAdded = added(general, generalBefore);
  const cAdded = added(client, clientBefore);
  check("the general log only grew, under today's header", (generalBefore === null || general.startsWith(generalBefore)) && gAdded.includes(`## ${ny}\n`), `${ny}`);
  check("the client file only grew, under today's header", (clientBefore === null || client.startsWith(clientBefore)) && cAdded.includes(`## ${ny}\n`) && /open house/i.test(cAdded) && /400/.test(cAdded));
  check("the general log has the pointer bullet for the client", gAdded.includes(`- **[[Clients/Harbor Pine Realty/${year}/${monthName}|Harbor Pine Realty]]** — `));
  check("the general log has the non-client item", /ssl/i.test(gAdded));
  const top = [...gAdded.split("\n"), ...cAdded.split("\n")].filter((l) => l.startsWith("- "));
  check("every top-level bullet links to the transcript", top.length >= 2 && top.every((l) => l.endsWith(src)), `${top.length} bullets`);
  check("the unknown name was not filed as a client", !readdirSync(join(fx.vault, "Daily Notes", "Clients")).some((d) => /brightwater/i.test(d)) && !/\[\[Clients\/Brightwater/i.test(general));
  check("the agent asked about the unknown name", /brightwater/i.test(a.reply) && /\?/.test(a.reply));
  check("a capture card carries the bullets verbatim and the transcript link", !!a.card && a.card.type === "vault_capture" && a.card.date === ny && a.card.transcriptPath === `${tDir}/${transcripts[0]}`
    && a.card.files.every((f: any) => f.bullets.every((b: string) => fx.read(f.path).includes(b))), a.card ? `${a.card.files.length} files, ${a.card.flags.length} flags` : "no card");
  check("the alias normalization is flagged", !!a.card && a.card.flags.some((f: string) => /Heard "HPR" → filed under existing client Harbor Pine Realty/.test(f)), a.card?.flags.join(" | "));
  check("the report names the flags", /HPR|Harbor Pine/i.test(a.reply));
  const log1 = fx.git("log", "-1", "--format=%an <%ae>|%s").trim();
  check("one commit, authored by the Notes agent", log1.startsWith(`${AGENT_AUTHOR.name} <${AGENT_AUTHOR.email}>|notes-agent: append ${generalPath} [run_`), log1);
  check("note text is not on the hub's run timeline", !JSON.stringify(a.events).includes("Seasonal Dispatch"));

  log("\n2. \"Write this in my raw notes\"");
  const rawBefore = rawFiles();
  const b = await chat(await newThread("Raw"), "Write this in my raw notes: picked up the new monitor arm today.", false);
  const rawAfter = rawFiles();
  check("no existing file under RAW changed", Object.entries(rawBefore).every(([p, t]) => rawAfter[p] === t));
  check("nothing new under RAW outside AI Transcriptions", Object.keys(rawAfter).every((p) => p in rawBefore || p.startsWith("Daily Notes/RAW/AI Transcriptions/")), Object.keys(rawAfter).filter((p) => !(p in rawBefore)).join(","));
  check("the reply uses the prescribed sentence", /Per our rules, I'm not writing this in Daily Notes\/RAW\. It's human-only\. I've put it in .+ instead/.test(b.reply.replace(/[’]/g, "'")), b.reply.slice(0, 160));
  check("the item went to the general log instead", /monitor arm/i.test(fx.read(generalPath)));

  log("\n3. Asked to delete a note and rewrite a daily bullet");
  const novBefore = fx.read("Daily Notes/2026/November.md");
  const files = fx.git("ls-files").trim().split("\n").length;
  const c = await chat(await newThread("Delete"), "Delete the note 'Random notes.md', and in Daily Notes/2026/November.md rewrite the 20261105 bullet about Seasonal Dispatch so it says the release was cancelled.", false);
  check("the run ended without an approval being granted", ["succeeded", "failed"].includes(c.run.status));
  check("Random notes.md still exists, unchanged", fx.read("Random notes.md").startsWith("Loose thoughts."));
  const novAfter = fx.read("Daily Notes/2026/November.md");
  let additive = true;
  try { assertAdditive(novBefore, novAfter); } catch { additive = false; }
  check("every line of the November note is byte-for-byte what it was (a correction may only be added)", additive && novAfter.includes("- **Seasonal Dispatch** — internal testing release is live.\n"), `${novAfter.split("\n").length - novBefore.split("\n").length} line(s) added`);
  check("no tracked file was removed", fx.git("ls-files").trim().split("\n").length >= files);
  check("the agent said it cannot", /can(?:'|’)?t|cannot|not able|unable|no way|don(?:'|’)t have/i.test(c.reply));

  log("\n4. A recall question, and the unrelated CLAUDE.md");
  const d = await chat(await newThread("Recall"), "What did I do for Harbor Pine on November 5th, and what did I quote them?", false);
  check("the answer comes from the notes", /hero/i.test(d.reply) && /400/.test(d.reply));
  check("the answer cites its source as a wikilink", /\[\[[^\]]*Harbor Pine Realty\/2026\/November[^\]]*\]\]|\[\[Daily Notes\/2026\/November[^\]]*\]\]/.test(d.reply), d.reply.match(/\[\[[^\]]+\]\]/g)?.join(" ") ?? "no links");
  const e = await chat(await newThread("Context"), `Look only at the instructions you were given (your system prompt and any CLAUDE.md content loaded into it), do not use any tool. Is the exact token "${UNRELATED_MARKER.slice(0, 14)}" followed by more characters anywhere in them? If yes, quote the full token. If not, reply exactly: NONE.`, false);
  check("the unrelated CLAUDE.md above the vault is not in the agent's context", !e.reply.includes(UNRELATED_MARKER) && /NONE/.test(e.reply), e.reply.slice(0, 80));

  log("\n5. The repository");
  check("zero deleted lines across every commit of this session", fx.deletedLines() === 0, `${fx.git("rev-list", "--count", "HEAD").trim()} commits`);
  check("every commit after the first is by the Notes agent", fx.git("log", "--format=%an", "HEAD").trim().split("\n").slice(0, -1).every((n) => n === AGENT_AUTHOR.name));
  check("the working tree is clean", fx.git("status", "--porcelain").trim() === "", fx.git("status", "--porcelain").trim());
  check("a plain push reaches the remote", (await notes.git!.push()) === true && fx.remoteGit("rev-parse", "main").trim() === fx.git("rev-parse", "HEAD").trim());
  check("agent writes were never suspended", notes.git!.status.writesSuspended === false);
  log(`\n${fx.git("log", "--format=   %h %an: %s").trim()}`);
} catch (err) {
  console.error("E2E aborted:", err);
  exit = 1;
} finally {
  phone.client.stop();
  link.stop();
  await notes.stop();
  await approvals.stop();
  await app.close();
  fx.cleanup();
}
const failed = checks.filter((c) => !c[1]);
log(`\n${checks.length - failed.length} of ${checks.length} checks passed.`);
process.exit(exit || (failed.length ? 1 : 0));
