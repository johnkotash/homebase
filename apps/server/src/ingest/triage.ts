import type { InboxSource, Priority } from "@homebase/protocol";

export interface InboxItemDraft {
  source: InboxSource;
  externalId?: string | null;
  externalUrl?: string | null;
  title: string;
  snippet?: string | null;
  body?: string | null;
  sender?: string | null;
  clientLabel?: string | null;
  receivedAt?: number;
  /** A caller-chosen priority skips triage (manual capture, trusted bots). */
  priority?: Priority;
  /** Why the caller chose that priority, shown as the triage reason. */
  reason?: string;
  /** Source-specific hints used by rules, e.g. { state: "down" } for monitors. */
  meta?: Record<string, unknown>;
}

export interface TriageResult { priority: Priority; reason: string }

export interface TriageConfig {
  vipSenders: string[];
  mutedSenders: string[];
}

export const DEFAULT_TRIAGE: TriageConfig = {
  vipSenders: [],
  mutedSenders: ["noreply@", "no-reply@", "newsletter@", "digest@"],
};

const P0_WORDS = /\b(down|outage|offline|urgent|asap|emergency|security|breach|hacked|defaced|payment failed|chargeback|data loss|ssl (certificate )?expired|site is broken)\b/i;
const P1_WORDS = /\b(invoice|refund|overdue|deadline|today|proposal|quote|estimate|new lead|contact form|contract|launch|blocked|approval needed)\b/i;

/** Mail only: a possible new customer, or something that broke. Checked after the P0 and P1 words above. */
const LEAD_WORDS = /\b(inquiry|enquiry|new (customer|client|submission|message from)|form submission|request(ing)? (a |for )?(quote|proposal|estimate|call|meeting|demo)|interested in|looking for (a |an )?(web|website|developer|designer|agency)|pricing|referred (by|me))\b/i;
const FAILURE_WORDS = /\b(fail(ed|ure|ing)?|bounced|undeliverable|could ?n[o']t be delivered|delivery status notification|expir(ed|es|ing)|suspended|declined|not working|broken)\b/i;

/** Deterministic rules. Always runs first; the LLM classifier (MVP) may only nudge the result by one level. */
export function triage(d: InboxItemDraft, cfg: TriageConfig = DEFAULT_TRIAGE): TriageResult {
  const text = `${d.title} ${d.snippet ?? ""}`;
  const sender = (d.sender ?? "").toLowerCase();
  const state = String(d.meta?.state ?? "");

  if (d.source === "monitor") {
    if (/recover|resolved|\bup\b|passing/i.test(state) || /recovered|back up|passing again/i.test(text)) {
      return { priority: "P3", reason: "Monitor recovered" };
    }
    if (/down|fail|error|timeout/i.test(state) || /fail|down|error|timeout|5\d\d/i.test(text)) {
      return { priority: "P0", reason: "Monitor failure: a client site or form is not working" };
    }
    return { priority: "P1", reason: "Monitor alert" };
  }
  if (P0_WORDS.test(text)) {
    const m = text.match(P0_WORDS)![0].toLowerCase();
    return { priority: "P0", reason: `Keyword "${m}" signals something that needs you now` };
  }
  if (cfg.vipSenders.some((v) => sender.includes(v.toLowerCase()))) {
    return { priority: "P1", reason: "Sender is on your priority client list" };
  }
  if (P1_WORDS.test(text)) {
    const m = text.match(P1_WORDS)![0].toLowerCase();
    return { priority: "P1", reason: `Keyword "${m}" means it should be handled today` };
  }
  if (d.source === "gmail") {
    const lead = text.match(LEAD_WORDS);
    if (lead) return { priority: "P1", reason: `Looks like a lead ("${lead[0].toLowerCase()}"): answer today` };
    const failure = text.match(FAILURE_WORDS);
    if (failure) return { priority: "P1", reason: `Something may have failed ("${failure[0].toLowerCase()}")` };
  }
  if (cfg.mutedSenders.some((v) => sender.includes(v.toLowerCase()))) {
    return { priority: "P3", reason: "Automated sender" };
  }
  switch (d.source) {
    case "resend":
      return { priority: "P2", reason: "Email delivery event (source default)" };
    case "calendar":
      return { priority: "P3", reason: "Calendar FYI (source default)" };
    case "clickup":
      return { priority: "P2", reason: "Task update (source default)" };
    case "gmail":
      return { priority: "P2", reason: "Client email with no urgency signals" };
    default:
      return { priority: "P2", reason: "No rule matched; default priority" };
  }
}
