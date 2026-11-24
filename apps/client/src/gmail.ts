import type { Agent, AgentGmailStatus, Approval, InboxItem } from "@homebase/protocol";

/** An email as the owner should see it before deciding: who it is from, everyone it goes to, and all of the text. */
export interface EmailView {
  from: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Recipients who were not on the thread before. */
  newRecipients: string[];
  isReply: boolean;
  attachments: string[];
  /** "2 of 10 sends used this hour", when the connector reported it. */
  capNote: string | null;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");

export const isGmailSend = (a: Pick<Approval, "tool" | "input">) => /gmail_send_draft$/.test(a.tool ?? "") && !!a.input && typeof a.input === "object" && (a.input as any).gmailSend === true;
export const isGmailDraft = (a: Pick<Approval, "tool" | "input">) => /gmail_(create|update)_draft$/.test(a.tool ?? "") && !!a.input && typeof a.input === "object";

/** The fields of a send approval, or of a "save this draft?" approval. Null for every other approval. */
export function emailOfApproval(a: Pick<Approval, "tool" | "input">): EmailView | null {
  const i = (a.input ?? {}) as Record<string, unknown>;
  if (isGmailSend(a)) {
    const cap = Number(i.capPerHour);
    return {
      from: str(i.from) || null, to: list(i.to), cc: list(i.cc), bcc: list(i.bcc), subject: str(i.subject), body: str(i.body),
      newRecipients: list(i.newRecipients), isReply: i.isReply === true, attachments: list(i.attachments),
      capNote: Number.isFinite(cap) && cap > 0 ? `${Number(i.sendsLastHour) || 0} of ${cap} sends used this hour` : null,
    };
  }
  if (isGmailDraft(a)) {
    return {
      from: null, to: list(i.to), cc: list(i.cc), bcc: list(i.bcc), subject: str(i.subject), body: str(i.body), newRecipients: [],
      isReply: !!(i.thread_id || i.reply_to_message_id), attachments: [], capNote: null,
    };
  }
  return null;
}

const SCOPE_WORDS: Record<string, string> = {
  "gmail.readonly": "read mail",
  "gmail.compose": "create and send drafts",
};

/** The Gmail connection as label/value rows for the agent page. No token is ever part of this. */
export function gmailFacts(g: AgentGmailStatus, fmtTime: (ts: number) => string): Array<{ label: string; value: string; note?: string; ok?: boolean }> {
  const extra = g.scopes.filter((s) => !(s in SCOPE_WORDS));
  return [
    { label: "Gmail", value: g.connected ? "Connected" : "Not connected", ok: g.connected },
    { label: "Account", value: g.account ?? "None" },
    {
      label: "Scopes", value: g.scopes.length ? g.scopes.join(", ") : "None granted",
      note: extra.length ? `Unexpected scope: ${extra.join(", ")}. HomeBase should hold only gmail.readonly and gmail.compose.`
        : g.scopes.length ? `${g.scopes.map((s) => SCOPE_WORDS[s]).join("; ")}. No delete, label, filter, forwarding or settings access.` : undefined,
      ok: g.scopes.length ? extra.length === 0 : undefined,
    },
    {
      label: "Last inbox poll", value: g.lastPollAt ? fmtTime(g.lastPollAt) : g.connected ? "Not yet" : "Not polling",
      note: g.lastPollError ? `Last error: ${g.lastPollError}` : g.connected ? "New mail is checked every 3 minutes. Mail is never marked read or labelled." : undefined,
      ok: g.lastPollError ? false : undefined,
    },
    { label: "Sends this hour", value: `${g.sendsLastHour} of ${g.sendCapPerHour}`, note: "Every send waits for your approval on this app, in every mode." },
  ];
}

/** Thread and message id of an inbox item the Gmail watcher made. Null for simulated items and flags. */
export function gmailRef(item: Pick<InboxItem, "source" | "externalId">): { threadId: string; messageId: string } | null {
  if (item.source !== "gmail") return null;
  const m = /^gmail(?:-flag)?:([\w-]+)(?::([\w-]+))?$/.exec(item.externalId ?? "");
  if (!m || !m[2]) return null;
  return { threadId: m[1], messageId: m[2] };
}

export const isInjectionFlag = (item: Pick<InboxItem, "source" | "externalId">) => item.source === "gmail" && /^gmail-flag:/.test(item.externalId ?? "");

/** The agent that works in the mailbox: the one that reports a Gmail status. */
export const commsAgent = (agents: Agent[]): Agent | undefined => agents.find((a) => a.gmail != null) ?? agents.find((a) => a.key === "comms" && a.kind === "claude");

/** What the Comms agent is asked when the owner taps "Draft reply" on a mail item. Ids only; the agent reads the mail itself. */
export function draftReplyPrompt(item: Pick<InboxItem, "title" | "sender">, ref: { threadId: string }): string {
  return [
    `Draft a reply to this email. Read Gmail thread ${ref.threadId} first, then save the reply as a draft in that thread. Do not send it.`,
    `Subject: ${item.title}`,
    item.sender ? `From: ${item.sender}` : "",
  ].filter(Boolean).join("\n");
}
