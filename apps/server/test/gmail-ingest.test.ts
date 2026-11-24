import { describe, expect, it } from "vitest";
import { InboundFrame, MessageCard } from "@homebase/protocol";
import { triage } from "../src/ingest/triage";

describe("mail from a connector's Gmail watcher", () => {
  const item = { source: "gmail", kind: "mail", externalId: "gmail:t1:m1", title: "Hello", snippet: "short", sender: "Dana <d@x.test>" };

  it("the frame carries metadata only: a body field is not part of it and is dropped", () => {
    const parsed = InboundFrame.parse({ t: "inbox.ingest", item: { ...item, body: "the full text of the email" } });
    expect(parsed.t).toBe("inbox.ingest");
    expect(JSON.stringify(parsed)).not.toContain("the full text");
    // Only Gmail, only mail or a flag, and bounded sizes.
    expect(InboundFrame.safeParse({ t: "inbox.ingest", item: { ...item, source: "monitor" } }).success).toBe(false);
    expect(InboundFrame.safeParse({ t: "inbox.ingest", item: { ...item, kind: "other" } }).success).toBe(false);
    expect(InboundFrame.safeParse({ t: "inbox.ingest", item: { ...item, snippet: "x".repeat(501) } }).success).toBe(false);
    // A connector cannot pick a priority for ordinary mail: there is no such field.
    expect(JSON.stringify(InboundFrame.parse({ t: "inbox.ingest", item: { ...item, priority: "P0" } }))).not.toContain("P0");
  });

  it("a chat card is a Gmail draft or a sent mail, nothing else", () => {
    const card = { type: "gmail_draft", draftId: "r1", threadId: "t1", to: ["a@b.test"], cc: [], bcc: [], subject: "Re: x", body: "hi" };
    expect(MessageCard.safeParse(card).success).toBe(true);
    expect(MessageCard.safeParse({ ...card, type: "gmail_sent" }).success).toBe(true);
    expect(MessageCard.safeParse({ ...card, type: "html" }).success).toBe(false);
  });
});

describe("default triage for mail: leads, clients and failures", () => {
  const cfg = { vipSenders: ["harborpine.test"], mutedSenders: ["noreply@", "no-reply@", "newsletter@"] };
  const p = (title: string, sender = "someone@new.test", snippet = "") => triage({ source: "gmail", title, sender, snippet }, cfg);

  it("leads are P1", () => {
    expect(p("Inquiry: website redesign for a dental practice")).toMatchObject({ priority: "P1" });
    expect(p("Hello", "priya@x.test", "We are interested in a new site and wondered about pricing")).toMatchObject({ priority: "P1", reason: expect.stringContaining("lead") });
    expect(p("New form submission from your website", "noreply@forms.test")).toMatchObject({ priority: "P1" });
    expect(p("Referred by Dana", "sam@x.test", "Dana said you build sites")).toMatchObject({ priority: "P1" });
  });

  it("known clients are P1, and anything urgent from anyone is P0", () => {
    expect(p("Photos from the weekend", "dana@harborpine.test")).toMatchObject({ priority: "P1", reason: "Sender is on your priority client list" });
    expect(p("Our site is down", "dana@harborpine.test").priority).toBe("P0");
    expect(p("Payment failed for your subscription", "billing@host.test").priority).toBe("P0");
  });

  it("failures are P1 even from automated senders; ordinary and bulk mail are not", () => {
    expect(p("Build failed: harbor-pine-site", "noreply@ci.test")).toMatchObject({ priority: "P1", reason: expect.stringContaining("failed") });
    expect(p("Delivery Status Notification (Failure)", "mailer-daemon@googlemail.test").priority).toBe("P1");
    expect(p("Your domain expires in 7 days", "no-reply@registrar.test").priority).toBe("P1");
    expect(p("Lunch on Friday?").priority).toBe("P2");
    expect(p("Weekly tips", "newsletter@vendor.test").priority).toBe("P3");
    // The lead and failure words are for mail only.
    expect(triage({ source: "clickup", title: "Task failed review" }, cfg).priority).toBe("P2");
  });
});
