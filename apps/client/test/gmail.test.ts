import { describe, expect, it } from "vitest";
import type { Agent, AgentGmailStatus } from "@homebase/protocol";
import { commsAgent, draftReplyPrompt, emailOfApproval, gmailFacts, gmailRef, isGmailSend, isInjectionFlag } from "../src/gmail";

describe("send approval card", () => {
  const input = {
    gmailSend: true, draftId: "r1", threadId: "t1", from: "owner@business.test", to: ["dana@harborpine.test"], cc: ["x@evil.test"], bcc: [],
    subject: "Re: Hero photo", body: "Hi Dana,\n\nDone.\n\nAlex", newRecipients: ["x@evil.test"], isReply: true, sendsLastHour: 2, capPerHour: 10, attachments: [],
  };

  it("shows from, to, cc, bcc, subject, the full body, new recipients and the cap", () => {
    const a = { tool: "mcp__gmail__gmail_send_draft", input };
    expect(isGmailSend(a)).toBe(true);
    expect(emailOfApproval(a)).toEqual({
      from: "owner@business.test", to: ["dana@harborpine.test"], cc: ["x@evil.test"], bcc: [], subject: "Re: Hero photo", body: "Hi Dana,\n\nDone.\n\nAlex",
      newRecipients: ["x@evil.test"], isReply: true, attachments: [], capNote: "2 of 10 sends used this hour",
    });
  });

  it("is only used for the Gmail tools; a draft approval shows the draft's fields", () => {
    expect(emailOfApproval({ tool: "Bash", input: { command: "ls" } })).toBeNull();
    expect(isGmailSend({ tool: "mcp__gmail__gmail_send_draft", input: { draft_id: "r1" } })).toBe(false); // not the connector's own request
    expect(emailOfApproval({ tool: "mcp__gmail__gmail_create_draft", input: { thread_id: "t1", to: "a@b.test, c@d.test", body: "hi" } }))
      .toMatchObject({ from: null, to: ["a@b.test", "c@d.test"], subject: "", body: "hi", isReply: true, newRecipients: [] });
  });
});

describe("Gmail status on the agent page", () => {
  const g: AgentGmailStatus = { connected: true, account: "owner@business.test", scopes: ["gmail.readonly", "gmail.compose"], lastPollAt: 1000, lastPollError: null, sendCapPerHour: 10, sendsLastHour: 1, checkedAt: 2000 };
  const fmt = (t: number) => `t${t}`;

  it("lists the account, the scopes and the last poll", () => {
    const facts = gmailFacts(g, fmt);
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ["Gmail", "Connected"], ["Account", "owner@business.test"], ["Scopes", "gmail.readonly, gmail.compose"], ["Last inbox poll", "t1000"], ["Sends this hour", "1 of 10"],
    ]);
    expect(facts[2]).toMatchObject({ ok: true, note: expect.stringContaining("No delete, label, filter, forwarding or settings access") });
    expect(JSON.stringify(facts)).not.toMatch(/token/i);
  });

  it("says so when it is not connected, and warns about a scope that should not be there", () => {
    const off = gmailFacts({ ...g, connected: false, account: null, scopes: [], lastPollAt: null }, fmt);
    expect(off.slice(0, 4).map((f) => f.value)).toEqual(["Not connected", "None", "None granted", "Not polling"]);
    expect(off[0].ok).toBe(false);
    const wide = gmailFacts({ ...g, scopes: ["gmail.readonly", "gmail.compose", "gmail.modify"] }, fmt)[2];
    expect(wide).toMatchObject({ ok: false, note: expect.stringContaining("Unexpected scope: gmail.modify") });
  });
});

describe("inbox item → draft reply", () => {
  it("finds the thread of a watcher item; simulated items and flags have none", () => {
    expect(gmailRef({ source: "gmail", externalId: "gmail:18f3a:18f3b" })).toEqual({ threadId: "18f3a", messageId: "18f3b" });
    expect(gmailRef({ source: "gmail", externalId: "sim-gmail-abc-1" })).toBeNull();
    expect(gmailRef({ source: "gmail", externalId: "gmail-flag:18f3b" })).toBeNull();
    expect(gmailRef({ source: "monitor", externalId: "gmail:a:b" })).toBeNull();
    expect(isInjectionFlag({ source: "gmail", externalId: "gmail-flag:18f3b" })).toBe(true);
    expect(isInjectionFlag({ source: "gmail", externalId: "gmail:a:b" })).toBe(false);
  });

  it("asks the Comms agent for a draft, by thread id, and says not to send", () => {
    const prompt = draftReplyPrompt({ title: "Hero photo", sender: "Dana <d@x.test>" }, { threadId: "18f3a" });
    expect(prompt).toContain("Read Gmail thread 18f3a first");
    expect(prompt).toContain("Do not send it.");
    const agents = [{ key: "dev", kind: "mock", gmail: null }, { key: "comms", kind: "claude", gmail: { connected: false } }] as unknown as Agent[];
    expect(commsAgent(agents)?.key).toBe("comms");
    expect(commsAgent([agents[0]])).toBeUndefined();
  });
});
