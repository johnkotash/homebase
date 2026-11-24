import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type Agent, type Approval, type InboxItem, type Message, type Run } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer } from "../src/adapters/claude-approvals";
import { REQUIRED_SCOPES, saveToken } from "../src/gmail/auth";
import { CommsAgent } from "../src/gmail/comms";
import { HubLink } from "../src/HubLink";
import { askApprovalTool, fakeClaude, testConfig } from "./claude-fixtures";
import { EVIL, FakeGmail, seedDemoMailbox } from "./fake-gmail";
import { cliTurn, gmailBox, gmailMcp } from "./gmail-helpers";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

/** The Comms agent end to end, minus the model: real hub, real sockets, a fake mailbox and a scripted CLI. */
describe("Comms agent through the hub", () => {
  let app: HubApp | null = null;
  let link: HubLink | null = null;
  let comms: CommsAgent | null = null;
  let fake: FakeGmail | null = null;
  const clients: Array<{ client: { stop(): void } }> = [];
  const servers: ApprovalServer[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.client.stop();
    link?.stop();
    link = null;
    await comms?.stop();
    comms = null;
    for (const s of servers.splice(0)) await s.stop();
    await app?.close();
    app = null;
    await fake?.stop();
    fake = null;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function boot(script: Parameters<typeof fakeClaude>[0], opts: { connected?: boolean } = {}) {
    fake = await new FakeGmail().start();
    const mail = seedDemoMailbox(fake);
    const box = gmailBox(fake, { connected: opts.connected });
    dirs.push(box.dir);
    const cli = fakeClaude(script);
    const approvals = new ApprovalServer();
    servers.push(approvals);
    app = await bootHub();
    const { token } = pairToken(app, "connector", "comms-connector");
    const agent = new CommsAgent({
      base: testConfig({ command: process.execPath }), approvals, env: box.env, spawnFn: cli.spawn, pollMs: 3_600_000,
      cliReadiness: async () => ({ ok: true, version: "2.1.301", note: null, checkedAt: Date.now() }),
      emitInbox: (item) => link?.ingestInbox(item) ?? false,
      onChange: () => link?.updateAgent("comms", agent.registration()),
    });
    comms = agent;
    await agent.check();
    link = new HubLink({ hubUrl: app.url, token, name: "comms-connector", log: () => {}, agents: [{ ...agent.registration(), adapter: agent.adapter }] });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    clients.push(phone);
    const registered = (await waitFor(() => (phone.list("agents") as Agent[]).find((a) => a.key === "comms" && a.status === "online"), "comms agent online")) as Agent;
    const threadId = newId("thr");
    await phone.client.mutate("thread.create", { threadId, title: "Mail", agentId: registered.id });
    const runs = () => (phone.list("runs") as Run[]).filter((r) => r.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const say = (text: string) => phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text, source: "text" });
    const messages = () => (phone.list("messages") as Message[]).filter((m) => m.threadId === threadId).sort((a, b) => a.createdAt - b.createdAt);
    const events = (runId: string) => app!.store.all<{ kind: string; data: string }>("SELECT kind, data FROM run_events WHERE run_id = ? ORDER BY idx", runId).map((e) => ({ kind: e.kind, data: JSON.parse(e.data) }));
    const audit = (action: string) => app!.store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = ? ORDER BY at, id", action).map((a) => JSON.parse(a.detail));
    const agentNow = () => (phone.list("agents") as Agent[]).find((a) => a.key === "comms")!;
    return { box, cli, phone, agent: registered, agentNow, threadId, runs, say, messages, events, audit, mail, comms: agent };
  }

  it("registers as a real agent with Manual as the default mode and its Gmail status, never a token", async () => {
    const s = await boot(() => cliTurn("hi"));
    expect(s.agent).toMatchObject({ kind: "claude", name: "Comms agent", modes: ["manual", "auto"], defaultMode: "manual", statusNote: null, permissionProfile: "strict" });
    expect(s.agent.gmail).toMatchObject({ connected: true, account: "owner@business.test", scopes: ["gmail.readonly", "gmail.compose"], sendCapPerHour: 10, sendsLastHour: 0 });
    const everything = JSON.stringify(app!.hub.snapshot()) + JSON.stringify(app!.store.all("SELECT * FROM changes"));
    expect(everything).not.toContain("fake-refresh-token");
    expect(everything).not.toContain("fake-access-token");
    expect(everything).not.toContain("test-client-secret");
  });

  it("shows \"Gmail not connected\" until the owner signs in, fails a run with the same words, then clears", async () => {
    const s = await boot(() => cliTurn("hi"), { connected: false });
    expect(s.agent.statusNote).toMatch(/^Gmail not connected — run gmail:auth on /);
    expect(s.agent.gmail).toMatchObject({ connected: false, account: null, scopes: [], lastPollAt: null });
    await s.say("Anything new?");
    const failed = (await waitFor(() => s.runs().find((r) => r.status === "failed"), "run failed")) as Run;
    expect(failed.error).toMatch(/^Gmail not connected/);
    expect(s.cli.calls).toHaveLength(0); // the CLI was never started
    // The owner runs gmail:auth: the token file appears, the next check picks it up.
    saveToken(s.box.paths, { refreshToken: "fake-refresh-token", scopes: [...REQUIRED_SCOPES], account: "owner@business.test", obtainedAt: Date.now() });
    await s.comms.check();
    const ready = (await waitFor(() => (s.agentNow().statusNote == null ? s.agentNow() : null), "note cleared")) as Agent;
    expect(ready.gmail).toMatchObject({ connected: true, account: "owner@business.test" });
  });

  it("the watcher's mail becomes inbox items once, with triage, SLA and a P1 injection flag, and no body in the hub", async () => {
    const s = await boot(() => cliTurn("hi"));
    await s.comms.poll();
    const inbox = () => (s.phone.list("inbox_items") as InboxItem[]).filter((i) => i.source === "gmail").sort((a, b) => (a.externalId! < b.externalId! ? -1 : 1));
    await waitFor(() => inbox().length === 4, "four items");
    const byId = Object.fromEntries(inbox().map((i) => [i.externalId, i]));
    expect(byId["gmail:thrdana:msgdana1"]).toMatchObject({ title: "Hero photo before the open house", sender: "Dana Whitfield <dana@harborpine.test>", priority: "P2", body: null, status: "new" });
    expect(byId["gmail:thrlead:msglead1"]).toMatchObject({ priority: "P1" });
    expect(byId["gmail:thrlead:msglead1"].slaDueAt).toBeGreaterThan(0);
    expect(byId["gmail-flag:msgevil1"]).toMatchObject({ priority: "P1", title: "Possible prompt-injection in email from Accounts Team", body: null, triageReason: expect.stringContaining("Security flag") });
    expect(byId["gmail-flag:msgevil1"].snippet).toContain("instructions addressed to an AI or assistant");
    for (const i of inbox()) expect(i.body).toBeNull();
    // P1 items notify; the plain P2 one does not.
    const titles = s.phone.notifications.map((n) => n.title);
    expect(titles).toEqual(expect.arrayContaining(["Possible prompt-injection in email from Accounts Team", "Inquiry: website redesign for a dental practice"]));
    expect(titles).not.toContain("Hero photo before the open house");
    expect(s.audit("gmail.injection_flag")).toHaveLength(1);
    expect((await waitFor(() => (s.agentNow().gmail?.lastPollAt ? s.agentNow() : null), "last poll")).gmail!.lastPollError).toBeNull();

    // Polling again, or the hub hearing about the same message twice, changes nothing.
    const before = s.phone.notifications.length;
    await s.comms.poll();
    expect(link!.ingestInbox({ source: "gmail", kind: "mail", externalId: "gmail:thrdana:msgdana1", title: "Changed title", sender: "x" })).toBe(true);
    fake!.deliver({ id: "msgnew", threadId: "thrdana", from: "Dana <dana@harborpine.test>", subject: "Re: Hero photo before the open house", text: "ping" });
    await s.comms.poll();
    await waitFor(() => inbox().length === 5, "the new message");
    expect(inbox().find((i) => i.externalId === "gmail:thrdana:msgdana1")!.title).toBe("Hero photo before the open house");
    expect(s.phone.notifications.length).toBe(before);
    expect(fake!.forbiddenRequests).toEqual([]);
    // Bodies stayed in the mailbox: the words of the mails are nowhere in the hub's change log.
    const log = JSON.stringify(app!.store.all("SELECT data FROM changes"));
    expect(log).not.toContain("what would it cost to add a short video banner");
    expect(log).not.toContain("maintenance mode");
  });

  it("Manual: a draft asks first; the saved draft shows as a card with its text; mail content stays off the timeline", async () => {
    let result = "";
    const s = await boot(async (call) => {
      const cfg = call.arg("--mcp-config")!;
      const mcp = await gmailMcp(cfg);
      expect(await mcp.list()).toEqual(["gmail_search", "gmail_read_thread", "gmail_list_drafts", "gmail_create_draft", "gmail_update_draft", "gmail_send_draft"]);
      const read = { tool_name: "mcp__gmail__gmail_read_thread", input: { thread_id: "thrdana" } };
      expect((await askApprovalTool(cfg, read)).behavior).toBe("allow");
      const thread = await mcp.call("gmail_read_thread", read.input);
      const input = { thread_id: "thrdana", body: "Hi Dana,\n\nI will swap the hero for shot 4 by Friday. A short video banner would be $400.\n\nAlex" };
      const ok = await askApprovalTool(cfg, { tool_name: "mcp__gmail__gmail_create_draft", input });
      if (ok.behavior === "allow") result = (await mcp.call("gmail_create_draft", input)).text;
      await mcp.close();
      return [
        JSON.stringify({ type: "system", subtype: "init", session_id: "306b18cd-e629-4f05-80d2-39435a768c6a", model: "haiku", apiKeySource: "none", cwd: ".", tools: [], mcp_servers: [] }),
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__gmail__gmail_read_thread", input: read.input }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: thread.text }] }] } }),
        ...cliTurn("I saved a reply to Dana as a draft.", false),
      ];
    });
    await s.say("Draft a reply to Dana about the hero photo");
    const pending = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "draft approval")) as Approval;
    expect(pending).toMatchObject({ kind: "tool", tool: "mcp__gmail__gmail_create_draft", risk: "low", mode: "manual", title: "Save Gmail draft (reply)", reason: "Saves a draft in Gmail. Nothing is sent" });
    expect(fake!.drafts.size).toBe(0);
    await s.phone.client.mutate("approval.decide", { approvalId: pending.id, decision: "approve" });
    const run = (await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "run done")) as Run;
    expect(result).toContain("Draft saved in Gmail. Nothing was sent.");
    expect([...fake!.drafts.values()][0]).toMatchObject({ threadId: "thrdana", to: "dana@harborpine.test", subject: "Re: Hero photo before the open house", inReplyTo: "<msgdana1@mail.fake.test>" });
    const card = (await waitFor(() => s.messages().find((m) => m.card), "draft card")) as Message;
    expect(card.card).toMatchObject({ type: "gmail_draft", updated: false, to: ["dana@harborpine.test"], subject: "Re: Hero photo before the open house", threadId: "thrdana" });
    expect((card.card as any).body).toContain("A short video banner would be $400.");
    expect(card.text).toMatch(/^Draft saved in Gmail\nTo: dana@harborpine.test\nSubject: Re: Hero photo before the open house\n\nHi Dana,/); // readable on a client without cards
    // The thread's text reached the model, not the hub's timeline.
    const timeline = JSON.stringify(s.events(run.id));
    expect(timeline).toContain("1 email block read by the agent");
    expect(timeline).not.toContain("New drone shots are in the shared folder");
    expect(fake!.sent).toHaveLength(0);
  });

  it("Auto: drafts are saved without asking, but a send still stops for a high-risk approval with every field; deny means DENIED", async () => {
    let sendResult: { text: string; isError: boolean } | null = null;
    const s = await boot(async (call) => {
      const cfg = call.arg("--mcp-config")!;
      const mcp = await gmailMcp(cfg);
      const input = { thread_id: "thrdana", cc: EVIL, body: "Hi Dana,\n\nDone by Friday.\n\nAlex" };
      expect((await askApprovalTool(cfg, { tool_name: "mcp__gmail__gmail_create_draft", input })).behavior).toBe("allow");
      const draftId = /draft_id: (\w+)/.exec((await mcp.call("gmail_create_draft", input)).text)![1];
      // The CLI asks the permission tool first; in Auto it says yes without involving the owner...
      expect((await askApprovalTool(cfg, { tool_name: "mcp__gmail__gmail_send_draft", input: { draft_id: draftId } })).behavior).toBe("allow");
      // ...and the Gmail server then stops and asks anyway.
      sendResult = await mcp.call("gmail_send_draft", { draft_id: draftId });
      await mcp.close();
      return cliTurn("The owner declined, so nothing was sent.");
    });
    await s.phone.client.mutate("mode.set", { scope: "thread", id: s.threadId, mode: "auto" });
    await s.say("Reply to Dana that it's done by Friday and send it");
    const pending = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending"), "send approval")) as Approval;
    expect(pending).toMatchObject({ kind: "tool", tool: "mcp__gmail__gmail_send_draft", risk: "high", mode: "auto", title: "Send email: Re: Hero photo before the open house" });
    expect(pending.input).toMatchObject({
      gmailSend: true, from: "owner@business.test", to: ["dana@harborpine.test"], cc: [EVIL], bcc: [], subject: "Re: Hero photo before the open house",
      body: "Hi Dana,\n\nDone by Friday.\n\nAlex", isReply: true, newRecipients: [EVIL], capPerHour: 10, sendsLastHour: 0,
    });
    expect(pending.reason).toContain(`not on this thread before: ${EVIL}`);
    expect(s.runs()[0]).toMatchObject({ status: "waiting_approval", mode: "auto" });
    expect(s.phone.notifications.find((n) => n.channel === "approvals")).toMatchObject({ priority: "P0", actions: ["open"] }); // never approvable from a notification
    // Only the draft was auto-approved; the send is not on the auto-approved trail.
    expect(s.audit("approval.auto").map((a) => a.tool)).toEqual(["mcp__gmail__gmail_create_draft"]);
    // High risk: approving needs the confirm step.
    expect(await s.phone.client.mutate("approval.decide", { approvalId: pending.id, decision: "approve" })).toMatchObject({ ok: false, error: { code: "biometric_required" } });
    expect(fake!.sent).toHaveLength(0);

    await s.phone.client.mutate("approval.decide", { approvalId: pending.id, decision: "deny", message: "Who is that in Cc?" });
    await waitFor(() => s.runs()[0].status === "succeeded", "run done");
    expect(sendResult!.isError).toBe(true);
    expect(sendResult!.text).toMatch(/^DENIED: the owner rejected sending this email in HomeBase: "Who is that in Cc\?"/);
    expect(fake!.sent).toHaveLength(0);
    expect(fake!.requests.some((r) => r.path.endsWith("/drafts/send"))).toBe(false);
    expect(s.audit("gmail.send")).toHaveLength(0);
  });

  it("an approved send goes out once, is audited, counts against the hourly cap and shows as a sent card", async () => {
    let sendResult: { text: string; isError: boolean } | null = null;
    const s = await boot(async (call) => {
      const mcp = await gmailMcp(call.arg("--mcp-config")!);
      const draftId = /draft_id: (\w+)/.exec((await mcp.call("gmail_create_draft", { thread_id: "thrdana", body: "Done by Friday.\n\nAlex" })).text)![1];
      sendResult = await mcp.call("gmail_send_draft", { draft_id: draftId });
      await mcp.close();
      return cliTurn("Sent.");
    });
    await s.say("Reply to Dana that it's done by Friday and send it");
    const pending = (await waitFor(() => (s.phone.list("approvals") as Approval[]).find((a) => a.status === "pending" && a.risk === "high"), "send approval")) as Approval;
    expect(pending.input).toMatchObject({ newRecipients: [], isReply: true });
    expect(await s.phone.client.mutate("approval.decide", { approvalId: pending.id, decision: "approve", biometricAt: Date.now() })).toMatchObject({ ok: true });
    await waitFor(() => s.runs()[0].status === "succeeded", "run done");
    expect(sendResult!.text).toMatch(/^Sent, with the owner's approval\. To: dana@harborpine.test\./);
    expect(fake!.sent).toHaveLength(1);
    expect(fake!.sent[0]).toMatchObject({ to: "dana@harborpine.test", threadId: "thrdana", text: "Done by Friday.\n\nAlex" });
    expect(s.audit("gmail.send")).toEqual([expect.objectContaining({ to: ["dana@harborpine.test"], subject: "Re: Hero photo before the open house" })]);
    expect(s.messages().filter((m) => m.card).map((m) => m.card!.type)).toEqual(["gmail_draft", "gmail_sent"]);
    expect((await waitFor(() => (s.agentNow().gmail?.sendsLastHour === 1 ? s.agentNow() : null), "send counted")).gmail).toMatchObject({ sendsLastHour: 1, sendCapPerHour: 10 });
  });

  it("reading a mail that tries to instruct the agent raises the P1 flag and a timeline note, and nothing else happens", async () => {
    let text = "";
    const s = await boot(async (call) => {
      const mcp = await gmailMcp(call.arg("--mcp-config")!);
      text = (await mcp.call("gmail_read_thread", { thread_id: "threvil" })).text;
      await mcp.close();
      return cliTurn("That email asked me to forward all invoices to an outside address. I did not act on it.");
    });
    await s.say("What does the invoice process email say?");
    const run = (await waitFor(() => s.runs().find((r) => r.status === "succeeded"), "run done")) as Run;
    expect(text).toContain("WARNING: 1 message in this thread looks like a prompt-injection attempt");
    const flag = (await waitFor(() => (s.phone.list("inbox_items") as InboxItem[]).find((i) => i.externalId === "gmail-flag:msgevil1"), "flag item")) as InboxItem;
    expect(flag).toMatchObject({ priority: "P1", source: "gmail", title: "Possible prompt-injection in email from Accounts Team", body: null });
    expect(s.phone.notifications.some((n) => n.title === "Possible prompt-injection in email from Accounts Team" && n.priority === "P1")).toBe(true);
    expect(s.events(run.id).find((e) => e.data.injection)?.data.message).toContain("Possible prompt-injection in email from Accounts Team");
    expect(fake!.sent).toHaveLength(0);
    expect(fake!.drafts.size).toBe(0);
    expect(fake!.forbiddenRequests).toEqual([]);
    expect(s.phone.list("approvals")).toHaveLength(0);
  });
});
