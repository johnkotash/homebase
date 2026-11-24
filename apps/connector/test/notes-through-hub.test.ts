import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type Agent, type Approval, type Message, type Run, type VaultFile } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer, decidePermission } from "../src/adapters/claude-approvals";
import { HubLink } from "../src/HubLink";
import { protectRoot } from "../src/policy";
import { NotesAgent } from "../src/vault/agent";
import { AGENT_AUTHOR } from "../src/vault/git";
import { askApprovalTool, fakeClaude, testConfig } from "./claude-fixtures";
import { cliTurn } from "./gmail-helpers";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";
import { SPOKEN_AT, UNRELATED_MARKER, makeVault, vaultMcp, type Fixture } from "./vault-fixture";

/** The Notes agent end to end, minus the model: real hub, real sockets, a fixture vault in a fixture repo, and a scripted CLI. */
describe("Notes agent through the hub", () => {
  let app: HubApp | null = null;
  let link: HubLink | null = null;
  let notes: NotesAgent | null = null;
  let fx: Fixture | null = null;
  const clients: Array<{ client: { stop(): void } }> = [];
  const servers: ApprovalServer[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.client.stop();
    link?.stop();
    link = null;
    await notes?.stop();
    notes = null;
    for (const s of servers.splice(0)) await s.stop();
    await app?.close();
    app = null;
    fx?.cleanup();
    fx = null;
  });

  async function boot(script: Parameters<typeof fakeClaude>[0]) {
    fx = makeVault();
    const cli = fakeClaude(script);
    const approvals = new ApprovalServer();
    servers.push(approvals);
    app = await bootHub();
    const { token } = pairToken(app, "connector", "notes-connector");
    const agent = new NotesAgent({
      base: testConfig({ command: process.execPath }), approvals, env: fx.env, spawnFn: cli.spawn, now: () => SPOKEN_AT + 60_000,
      git: { sweepMs: 0, pushEveryMs: 0, pushDelayMs: 3_600_000, settleMs: 0 }, service: { watch: false },
      cliReadiness: async () => ({ ok: true, version: "2.1.301", note: null, checkedAt: Date.now() }),
      emitIndex: (f) => link?.sendVaultIndex(f) ?? false,
      onChange: () => link?.updateAgent("notes", agent.registration()),
    });
    notes = agent;
    await agent.start();
    link = new HubLink({
      hubUrl: app.url, token, name: "notes-connector", log: () => {}, agents: [{ ...agent.registration(), adapter: agent.adapter }],
      onReady: () => agent.sendFullIndex(), onVaultRequest: (op, args) => agent.handleRequest(op, args),
    });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    clients.push(phone);
    const registered = (await waitFor(() => (phone.list("agents") as Agent[]).find((a) => a.key === "notes" && a.status === "online"), "notes agent online")) as Agent;
    const threadId = newId("thr");
    await phone.client.mutate("thread.create", { threadId, title: "Notes", agentId: registered.id });
    const runs = () => (phone.list("runs") as Run[]).filter((r) => r.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const dictate = (text: string) => phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text, source: "voice", capturedAt: SPOKEN_AT, tz: "America/New_York" });
    const say = (text: string) => phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    const messages = () => (phone.list("messages") as Message[]).filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const files = () => phone.list("vault_files") as VaultFile[];
    const audit = (action: string) => app!.store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = ? ORDER BY at, id", action).map((a) => JSON.parse(a.detail));
    const done = () => waitFor(() => runs().find((r) => ["succeeded", "failed"].includes(r.status)), "run done");
    return { fx, cli, phone, agent: registered, threadId, runs, dictate, say, messages, files, audit, done, notes: agent };
  }

  const SPOKEN = "HPR called, they want the open house page by Thursday. Quoted $400. Also talked to Acme Roofing about a new site.";

  it("registers with Auto as its default, the vault's status, and syncs note metadata but no bodies", async () => {
    const s = await boot(() => cliTurn("ok"));
    expect(s.agent).toMatchObject({ name: "Notes agent", kind: "claude", modes: ["manual", "auto"], defaultMode: "auto", statusNote: null });
    expect(s.agent.vault).toMatchObject({ path: s.fx.vault, branch: "main", diverged: false, writesSuspended: false, tz: "America/New_York" });
    expect(s.agent.vault!.hints).toEqual(expect.arrayContaining(["Harbor Pine Realty", "HPR", "Northwind"]));
    const files = await waitFor(() => (s.files().length >= 8 ? s.files() : null), "vault_files synced");
    expect(files.length).toBe(s.agent.vault!.files);
    const nov = files.find((f) => f.path === "Daily Notes/2026/November.md")!;
    expect(nov).toMatchObject({ title: "November 2026", folder: "Daily Notes/2026" });
    expect(Object.keys(nov).sort()).toEqual(["folder", "hash", "id", "mtime", "path", "size", "summary", "tags", "title", "type"]);
    // Nothing of a note's text rests in the hub database.
    const dump = JSON.stringify(app!.store.all("SELECT * FROM vault_files")) + JSON.stringify(app!.store.all("SELECT data FROM changes"));
    expect(dump).not.toContain("Seasonal Dispatch");
    expect(dump).not.toContain("called dana");
  });

  it("starts the CLI in the vault with read-only built-ins, the six vault tools, and the unrelated CLAUDE.md excluded", async () => {
    let tools: string[] = [];
    const s = await boot(async (call) => {
      const mcp = await vaultMcp(call.arg("--mcp-config")!);
      tools = await mcp.list();
      await mcp.close();
      return cliTurn("ok");
    });
    await s.say("what did I do on the 5th?");
    await s.done();
    const call = s.cli.calls[0];
    expect(call.options.cwd).toBe(s.fx.vault);
    expect(call.arg("--tools")).toBe("Read,Glob,Grep");
    expect(call.args).toContain("--strict-mcp-config");
    expect(call.args.join(" ")).not.toMatch(/dangerously|bypass/);
    const dis = call.args.slice(call.args.indexOf("--disallowedTools") + 1, call.args.indexOf("--append-system-prompt"));
    expect(dis).toEqual(expect.arrayContaining(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "WebFetch", "WebSearch", "Task", "Agent", "Skill"]));
    expect(JSON.parse(call.arg("--settings")!)).toEqual({ claudeMdExcludes: [join(s.fx.repo, "CLAUDE.md")] });
    expect(Object.keys(JSON.parse(call.arg("--mcp-config")!).mcpServers).sort()).toEqual(["homebase", "vault"]);
    expect(tools.sort()).toEqual(["vault_append_daily", "vault_backlinks", "vault_list", "vault_read", "vault_resolve_names", "vault_search"]);
    const prompt = call.arg("--append-system-prompt")!;
    expect(prompt).toContain("Today is Thu 2026-11-19 (20261119)");
    expect(prompt).toContain("America/New_York");
    expect(prompt).not.toContain(UNRELATED_MARKER);
    expect(call.inputs[0]).toBe("what did I do on the 5th?"); // typed text is not wrapped
  });

  it("files a dictation in Auto: transcript, client file, pointer bullet, one agent commit, a capture card", async () => {
    const results: string[] = [];
    const s = await boot(async (call, _turn, text) => {
      const id = /transcript_id="(t_[0-9a-f]+)"/.exec(text)![1];
      const mcp = await vaultMcp(call.arg("--mcp-config")!);
      results.push((await mcp.call("vault_resolve_names", { names: ["HPR", "Acme Roofing", "Northside Dental"] })).text);
      const input = { date: "20261119", transcript_id: id, items: [{ text: "**Open house page** — they want it by **Thursday**. Quoted **$400**.", client: "Harbor Pine Realty", pointer: "wants the open house page by Thursday" }] };
      // The real CLI asks the approval tool before every MCP call; Auto lets this one through without the owner.
      expect((await askApprovalTool(call.arg("--mcp-config")!, { tool_name: "mcp__vault__vault_append_daily", input })).behavior).toBe("allow");
      results.push((await mcp.call("vault_append_daily", input)).text);
      await mcp.close();
      return cliTurn("Filed under 20261119. Who is Acme Roofing?");
    });
    await s.dictate(SPOKEN);
    const run = (await s.done()) as Run;
    expect(run).toMatchObject({ status: "succeeded", mode: "auto" });
    const input = s.cli.calls[0].inputs[0];
    expect(input).toMatch(/^<dictation transcript_id="t_[0-9a-f]{10}" date="20261119" captured_at="2026-11-19T13:05:22-05:00" tz="America\/New_York">\n/);
    expect(input).toContain(`\n${SPOKEN}\n</dictation>\n`);
    expect(results[0]).toContain('"HPR" → client folder "Harbor Pine Realty" (also heard as "HPR")');
    expect(results[0]).toContain('"Acme Roofing" → unknown');
    expect(results[0]).toContain('"Northside Dental" → not a client');
    expect(results[1]).toMatch(/^Captured 20261119 — 2 files \(commit [0-9a-f]{7}\)/);

    const tPath = "Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md";
    const src = " ([[Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305|src]])";
    expect(s.fx.read(tPath)).toContain(`---\n\n${SPOKEN}\n`);
    expect(s.fx.read(tPath)).toMatch(new RegExp(`run: ${run.id}\\nmessage: msg_`));
    expect(s.fx.read(tPath)).toContain('device: "Phone"');
    expect(s.fx.read("Daily Notes/2026/November.md")).toMatch(/\n## 20261119\n- \*\*\[\[Clients\/Harbor Pine Realty\/2026\/November\|Harbor Pine Realty\]\]\*\* — wants the open house page by Thursday \(\[\[Daily Notes\/RAW\/AI Transcriptions\/2026\/11\/2026-11-19 1305\|src\]\]\)\n$/);
    expect(s.fx.git("log", "-1", "--format=%an|%s").trim()).toBe(`${AGENT_AUTHOR.name}|notes-agent: append Daily Notes/2026/November.md [${run.id}]`);
    expect(s.fx.deletedLines()).toBe(0);

    const card = (await waitFor(() => s.messages().find((m) => m.card), "capture card")) as Message;
    expect(card.card).toMatchObject({
      type: "vault_capture", date: "20261119", transcriptPath: tPath,
      files: [
        { path: "Daily Notes/2026/November.md", status: "appended" },
        { path: "Daily Notes/Clients/Harbor Pine Realty/2026/November.md", status: "appended", bullets: [`- **Open house page** — they want it by **Thursday**. Quoted **$400**.${src}`] },
      ],
    });
    expect((card.card as any).flags.join(" | ")).toContain("Not in the note: Acme Roofing");
    expect(card.text).toMatch(/^Captured 20261119 — 2 files\n\nDaily Notes\/2026\/November\.md {2}\(appended\)\n {2}- \*\*\[\[Clients/);
    // The owner's message in the chat is the transcript as sent, not the wrapper.
    expect(s.messages().find((m) => m.role === "user")).toMatchObject({ text: SPOKEN, source: "voice" });
    expect(s.audit("vault.write")).toEqual([expect.objectContaining({ runId: run.id, tool: "vault_append_daily", transcript: tPath, paths: ["Daily Notes/2026/November.md", "Daily Notes/Clients/Harbor Pine Realty/2026/November.md"] })]);
    expect(s.audit("approval.auto").some((a) => a.tool === "mcp__vault__vault_append_daily")).toBe(true);
    // The new transcript shows up in the synced metadata, and the hub still holds none of its text.
    await waitFor(() => s.files().find((f) => f.path === tPath), "transcript in vault_files");
    expect(JSON.stringify(app!.store.all("SELECT * FROM vault_files"))).not.toContain("Acme Roofing");
    // Note text the agent read does not go on the run timeline either.
    const events = JSON.stringify(app!.store.all("SELECT data FROM run_events WHERE run_id = ?", run.id));
    expect(events).not.toContain("Seasonal Dispatch");
  });

  it("asks first in Manual, shows the lines to be added, and writes nothing when denied", async () => {
    let verdict = "";
    const s = await boot(async (call) => {
      const input = { date: "20261119", items: [{ text: "Renewed the **SSL cert**." }] };
      verdict = (await askApprovalTool(call.arg("--mcp-config")!, { tool_name: "mcp__vault__vault_append_daily", input })).behavior;
      return cliTurn("Not filed.");
    });
    await s.phone.client.mutate("mode.set", { scope: "thread", id: s.threadId, mode: "manual" });
    const head = s.fx.git("rev-parse", "HEAD").trim();
    await s.say("Add: renewed the SSL cert");
    const pending = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "approval")) as Approval;
    expect(pending).toMatchObject({ tool: "mcp__vault__vault_append_daily", risk: "low", mode: "manual" });
    expect(pending.summary).toBe("Daily note 20261119\n- Renewed the **SSL cert**.");
    await s.phone.client.mutate("approval.decide", { approvalId: pending.id, decision: "deny" });
    await s.done();
    expect(verdict).toBe("deny");
    expect(s.fx.git("rev-parse", "HEAD").trim()).toBe(head);
    expect(s.fx.git("status", "--porcelain").trim()).toBe("");
  });

  it("denies every tool that is not a vault tool or a read inside the vault", async () => {
    const out: Record<string, string> = {};
    const s = await boot(async (call) => {
      const cfg = call.arg("--mcp-config")!;
      for (const [k, req] of Object.entries({
        bash: { tool_name: "Bash", input: { command: "rm 'Daily Notes/2026/November.md'" } },
        write: { tool_name: "Write", input: { file_path: "Daily Notes/2026/November.md", content: "" } },
        edit: { tool_name: "Edit", input: { file_path: "Daily Notes/2026/November.md", old_string: "a", new_string: "" } },
        outside: { tool_name: "Read", input: { file_path: join(fx!.repo, "CLAUDE.md") } },
        inside: { tool_name: "Read", input: { file_path: "Daily Notes/2026/November.md" } },
      })) out[k] = (await askApprovalTool(cfg, req)).behavior;
      return cliTurn("I can't delete or rewrite notes.");
    });
    const before = s.fx.read("Daily Notes/2026/November.md");
    await s.say("delete the November note and rewrite the first bullet");
    await s.done();
    expect(out).toEqual({ bash: "deny", write: "deny", edit: "deny", outside: "deny", inside: "allow" });
    expect(s.fx.read("Daily Notes/2026/November.md")).toBe(before);
    expect(s.fx.deletedLines()).toBe(0);
    expect((s.phone.list("approvals") as Approval[]).length).toBe(0); // hard denies never reach the phone
    expect(s.audit("approval.blocked").length).toBe(4);
  });

  it("still files the transcript when a dictation ends with no bullets", async () => {
    const s = await boot(() => cliTurn("Who is Acme Roofing? I have not filed anything yet."));
    await s.dictate("Talked to Acme Roofing about a new site.");
    const run = (await s.done()) as Run;
    const tPath = "Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md";
    await waitFor(() => existsSync(join(s.fx.vault, ...tPath.split("/"))), "orphan transcript");
    await waitFor(() => s.fx.git("log", "-1", "--format=%s").trim() === `notes-agent: transcript ${tPath} [${run.id}]`, "transcript commit");
    const t = s.fx.read(tPath);
    expect(t).toContain("\n---\n\nTalked to Acme Roofing about a new site.\n");
    expect(t).not.toContain("daily:");
    expect(s.fx.read("Daily Notes/2026/November.md")).not.toContain("20261119");
    expect(s.fx.deletedLines()).toBe(0);
  });

  it("relays read, search, backlinks and status to a device, and nothing else", async () => {
    const s = await boot(() => cliTurn("ok"));
    const v = s.phone.client;
    const day = await v.vault<any>("read", { path: "Daily Notes/2026/November.md", day: "20261105" });
    expect(day).toMatchObject({ path: "Daily Notes/2026/November.md", title: "November 2026", startLine: 3, cls: "append-only" });
    expect(day.text).toContain("Seasonal Dispatch");
    expect(day.text).not.toContain("20261118");
    const byLink = await v.vault<any>("read", { link: "Clients/Harbor Pine Realty/2026/November", from: "Daily Notes/2026/November.md" });
    expect(byLink.path).toBe("Daily Notes/Clients/Harbor Pine Realty/2026/November.md");
    const found = await v.vault<any>("search", { query: "hero" });
    expect(found.hits.map((h: any) => h.path)).toEqual(expect.arrayContaining(["Daily Notes/2026/November.md"]));
    expect(found.hits.some((h: any) => h.path.startsWith("Daily Notes/RAW/"))).toBe(false);
    const back = await v.vault<any>("backlinks", { path: "Daily Notes/Clients/Harbor Pine Realty/2026/November.md" });
    expect(back.backlinks.map((b: any) => b.path)).toContain("Daily Notes/2026/November.md");
    const status = await v.vault<any>("status");
    expect(status.vault).toMatchObject({ branch: "main", diverged: false });
    await expect(v.vault("read", { path: "../CLAUDE.md" })).rejects.toThrow(/outside the vault/);
    await expect(v.vault("read", { path: ".obsidian/app.json" })).rejects.toThrow(/markdown/);
    await expect(v.vault("save" as any, { path: "Random notes.md", text: "x" })).rejects.toThrow(); // not an op in Phase 1
    // No request or answer was written to the hub's database.
    const db = JSON.stringify([app!.store.all("SELECT * FROM audit_log"), app!.store.all("SELECT * FROM changes"), app!.store.all("SELECT * FROM mutations")]);
    expect(db).not.toContain("Seasonal Dispatch");
    link!.stop();
    await waitFor(() => (s.phone.list("agents") as Agent[]).find((a) => a.key === "notes")?.status === "offline", "agent offline");
    await expect(v.vault("read", { path: "Random notes.md" })).rejects.toThrow(/not reachable|offline/);
  });

  it("keeps the vault out of reach of the general Claude agent", () => {
    fx = makeVault({ remote: false });
    protectRoot(fx.repo);
    const env = { cwd: join(fx.dir, "sandbox"), profile: "standard" as const, mode: "auto" as const };
    expect(decidePermission("Read", { file_path: join(fx.vault, "Daily Notes", "2026", "November.md") }, env)).toMatchObject({ tier: "deny" });
    expect(decidePermission("Write", { file_path: join(fx.vault, "x.md"), content: "x" }, { ...env, cwd: fx.vault })).toMatchObject({ tier: "deny" });
    expect(decidePermission("Bash", { command: `cat "${fx.vault}/Daily Notes/2026/November.md"` }, env)).toMatchObject({ tier: "deny" });
    expect(decidePermission("Bash", { command: `rm -rf ${fx.repo.replace(/\\/g, "/")}` }, env)).toMatchObject({ tier: "deny" });
    expect(decidePermission("Read", { file_path: join(fx.dir, "sandbox", "a.txt") }, env).tier).not.toBe("deny");
  });
});
