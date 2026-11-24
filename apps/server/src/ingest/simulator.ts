import type { SimKind } from "@homebase/protocol";
import type { InboxItemDraft } from "./triage";

type Fixture = Omit<InboxItemDraft, "source" | "externalId" | "receivedAt">;

/** Synthetic source events for a small web-dev agency. No real services are contacted. */
export const FIXTURES: Record<SimKind, Fixture[]> = {
  monitor: [
    {
      title: "Form check FAILED: harborpinerealty.example /contact",
      snippet: "Synthetic submission returned HTTP 500 after 2 retries. Last pass 6 h ago.",
      body: "Weekly + on-deploy synthetic form test.\n\nSite: harborpinerealty.example\nForm: /contact (lead form)\nResult: HTTP 500 from /api/contact after 2 retries\nLast passing run: 6 hours ago\nLast deploy: 41 minutes ago (commit a41c9e2 \"swap mail provider env\")\n\nLeads submitted since the failure are probably lost.",
      sender: "Form monitor", clientLabel: "Harbor & Pine Realty", meta: { state: "failed" },
      externalUrl: "https://monitor.example/checks/harbor-pine-contact",
    },
    {
      title: "Uptime DOWN: northwindsupply.example (3 of 3 regions)",
      snippet: "TLS handshake timeout from ORD, IAD and LAX for 4 minutes.",
      body: "Uptime monitor\n\nSite: northwindsupply.example\nState: DOWN\nRegions failing: ORD, IAD, LAX\nError: TLS handshake timeout\nDuration: 4 minutes and counting\n\nStorefront checkout is unreachable.",
      sender: "Uptime monitor", clientLabel: "Northwind Supply Co", meta: { state: "down" },
      externalUrl: "https://monitor.example/checks/northwind-home",
    },
    {
      title: "Form check FAILED: hilltopinspections.example /book",
      snippet: "reCAPTCHA token rejected; booking request never reached the inbox.",
      body: "Synthetic booking request did not arrive in the monitoring inbox within 5 minutes.\n\nSite: hilltopinspections.example\nForm: /book\nLikely cause: reCAPTCHA secret mismatch after key rotation.",
      sender: "Form monitor", clientLabel: "Hilltop Inspections", meta: { state: "failed" },
      externalUrl: "https://monitor.example/checks/hilltop-book",
    },
  ],
  gmail: [
    {
      title: "Quote request: redesign for a 3-location dental practice",
      snippet: "We found you through Harbor & Pine. Could you send a proposal this week?",
      body: "Hi,\n\nWe run Northside Dental (three offices) and our site is about eight years old. Harbor & Pine recommended you.\n\nCould you send a proposal for a redesign with online booking? We'd like to decide by the end of the month.\n\nThanks,\nDr. Priya Raman",
      sender: "Priya Raman <priya@northsidedental.example>", clientLabel: "Northside Dental (lead)",
      externalUrl: "https://mail.example/thread/quote-northside",
    },
    {
      title: "Re: October invoice — can we split it?",
      snippet: "Cash is tight until the 15th. Could we pay half now and half mid-month?",
      body: "Hey,\n\nGot the October invoice (#1047, $2,400). Cash is tight until the 15th. Could we pay half now and the other half mid-month?\n\nMarcus\nLakeside Outfitters",
      sender: "Marcus Bell <marcus@lakesideoutfitters.example>", clientLabel: "Lakeside Outfitters",
      externalUrl: "https://mail.example/thread/invoice-1047",
    },
    {
      title: "Can you swap the hero photo before the open house?",
      snippet: "New drone shots attached. No rush, sometime this week is fine.",
      body: "Hi! New drone shots are in the shared folder. Could you swap the homepage hero for shot 4? No rush, sometime this week is fine.\n\nDana\nHarbor & Pine Realty",
      sender: "Dana Whitfield <dana@harborpinerealty.example>", clientLabel: "Harbor & Pine Realty",
      externalUrl: "https://mail.example/thread/hero-swap",
    },
    {
      title: "URGENT: checkout is charging tax twice",
      snippet: "Two customers emailed screenshots this morning. Please look ASAP.",
      body: "Two customers emailed screenshots this morning showing sales tax applied twice at checkout. We've paused the promo email. Please look ASAP.\n\nRenee\nNorthwind Supply Co",
      sender: "Renee Okafor <renee@northwindsupply.example>", clientLabel: "Northwind Supply Co",
      externalUrl: "https://mail.example/thread/double-tax",
    },
  ],
  clickup: [
    {
      title: "Task moved to Review: Hilltop — booking form v2",
      snippet: "Contractor marked the task ready for review. 3 checklist items open.",
      body: "List: Client work / Hilltop Inspections\nTask: Booking form v2\nStatus: In progress → Review\nAssignee: contractor (Jo)\nChecklist: 5 of 8 done\n\nComment: \"Ready for a look. Validation on the date picker still needs your call.\"",
      sender: "ClickUp", clientLabel: "Hilltop Inspections", externalUrl: "https://tasks.example/t/86c2x1",
    },
    {
      title: "Comment on: Lakeside — product feed sync",
      snippet: "\"Feed is blocked until we get the new API key from the client.\"",
      body: "List: Client work / Lakeside Outfitters\nTask: Product feed sync\nNew comment from Jo: \"Feed is blocked until we get the new API key from the client. Can you ask Marcus?\"",
      sender: "ClickUp", clientLabel: "Lakeside Outfitters", externalUrl: "https://tasks.example/t/86c2x7",
    },
    {
      title: "Due tomorrow: Northside Dental — proposal draft",
      snippet: "Task is due tomorrow at 5:00 PM and has no time tracked.",
      body: "List: Sales\nTask: Northside Dental — proposal draft\nDue: tomorrow 5:00 PM\nTime tracked: 0h",
      sender: "ClickUp", clientLabel: "Northside Dental (lead)", externalUrl: "https://tasks.example/t/86c2y3",
    },
  ],
  resend: [
    {
      title: "Bounce: lead notification to dana@harborpinerealty.example",
      snippet: "Hard bounce (mailbox full). 1 contact-form notification was not delivered.",
      body: "Event: email.bounced\nType: hard bounce — mailbox full\nFrom: forms@harborpinerealty.example\nTo: dana@harborpinerealty.example\nSubject: New contact form submission\n\nThe lead was stored but the client was not notified.",
      sender: "Resend", clientLabel: "Harbor & Pine Realty", externalUrl: "https://email.example/emails/re_8f1c",
    },
    {
      title: "Delivery delayed: 14 order confirmations (northwindsupply.example)",
      snippet: "Receiving server is deferring mail. Oldest message has waited 22 minutes.",
      body: "Event: email.delivery_delayed × 14\nDomain: northwindsupply.example\nOldest: 22 minutes\nReceiving servers are returning 421 deferrals.",
      sender: "Resend", clientLabel: "Northwind Supply Co", externalUrl: "https://email.example/emails/re_22aa",
    },
  ],
  calendar: [
    {
      title: "Tomorrow 12:15 — Hilltop Inspections check-in (30 min)",
      snippet: "Overlaps your lunch block. Agenda: booking form v2 sign-off.",
      body: "Event: Hilltop Inspections check-in\nWhen: tomorrow 12:15–12:45\nWhere: video call\nAgenda: booking form v2 sign-off, December retainer.\n\nNote: overlaps your recurring lunch block.",
      sender: "Google Calendar", clientLabel: "Hilltop Inspections", externalUrl: "https://calendar.example/event/lv-checkin",
    },
    {
      title: "Daily agenda: 2 client calls, 1 deadline",
      snippet: "12:15 Hilltop check-in · 5:30 Northside intro · Proposal draft due 5:00 PM.",
      body: "Today\n12:15 Hilltop Inspections check-in\n17:30 Northside Dental intro call\n\nDeadlines\n17:00 Northside Dental proposal draft",
      sender: "Google Calendar", clientLabel: null, externalUrl: "https://calendar.example/agenda",
    },
  ],
};

const cursors: Record<string, number> = {};

export function simulate(kind: SimKind, now: number, salt = ""): InboxItemDraft {
  const list = FIXTURES[kind];
  const i = (cursors[kind] = ((cursors[kind] ?? -1) + 1) % list.length);
  const f = list[i];
  return { ...f, source: kind, externalId: `sim-${kind}-${now.toString(36)}-${i}${salt}`, receivedAt: now };
}

export function resetSimulator() {
  for (const k of Object.keys(cursors)) delete cursors[k];
}
