import { AccessTokens, GmailAuthError, type GmailEndpoints } from "./auth";

/**
 * A deliberately small Gmail REST client: plain fetch, and a fixed table of the calls HomeBase is
 * allowed to make. There is no generic "request" escape hatch for callers, so a delete, trash, label,
 * filter, forwarding or settings call cannot be made through this class even by mistake. Google
 * enforces the same thing again on its side through the two OAuth scopes.
 */

export class GmailApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Every Gmail call this connector can make. Method + path pattern, relative to /gmail/v1/users/me. */
export const ALLOWED_CALLS: ReadonlyArray<{ method: "GET" | "POST" | "PUT"; path: RegExp; what: string }> = [
  { method: "GET", path: /^\/profile$/, what: "read the account address" },
  { method: "GET", path: /^\/messages$/, what: "search messages" },
  { method: "GET", path: /^\/messages\/[\w-]+$/, what: "read a message" },
  { method: "GET", path: /^\/threads\/[\w-]+$/, what: "read a thread" },
  { method: "GET", path: /^\/history$/, what: "list mailbox changes" },
  { method: "GET", path: /^\/drafts$/, what: "list drafts" },
  { method: "GET", path: /^\/drafts\/[\w-]+$/, what: "read a draft" },
  { method: "POST", path: /^\/drafts$/, what: "create a draft" },
  { method: "PUT", path: /^\/drafts\/[\w-]+$/, what: "update a draft" },
  { method: "POST", path: /^\/drafts\/send$/, what: "send a draft (only after the owner approves)" },
];

export const isAllowedCall = (method: string, path: string) => ALLOWED_CALLS.some((c) => c.method === method.toUpperCase() && c.path.test(path));

export interface GmailHeader { name: string; value: string }
export interface GmailPart { mimeType?: string; filename?: string; headers?: GmailHeader[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: GmailPart[] }
export interface GmailMessage { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; historyId?: string; payload?: GmailPart }
export interface GmailThread { id: string; historyId?: string; messages?: GmailMessage[] }
export interface GmailDraft { id: string; message: GmailMessage }

export const header = (m: { payload?: GmailPart } | GmailPart | undefined, name: string): string => {
  const headers = (m && "payload" in m ? m.payload?.headers : (m as GmailPart | undefined)?.headers) ?? [];
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
};

const b64urlDecode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

export interface MessageContent {
  /** The body to show: text/plain when there is one, otherwise the HTML part. */
  body: string;
  isHtml: boolean;
  /** The HTML alternative when the plain part was chosen. Scanned for hidden content only. */
  htmlAlternative: string | null;
  attachments: string[];
}

/** Walks a MIME tree for the readable body and the attachment names. Attachments are never downloaded. */
export function messageContent(m: GmailMessage): MessageContent {
  let plain: string | null = null;
  let html: string | null = null;
  const attachments: string[] = [];
  const walk = (p: GmailPart | undefined, depth: number) => {
    if (!p || depth > 12) return;
    if (p.filename) attachments.push(p.filename);
    const type = (p.mimeType ?? "").toLowerCase();
    if (!p.filename && p.body?.data) {
      if (type === "text/plain" && plain == null) plain = b64urlDecode(p.body.data);
      else if (type === "text/html" && html == null) html = b64urlDecode(p.body.data);
    }
    for (const c of p.parts ?? []) walk(c, depth + 1);
  };
  walk(m.payload, 0);
  if (plain != null) return { body: plain, isHtml: false, htmlAlternative: html, attachments };
  if (html != null) return { body: html, isHtml: true, htmlAlternative: null, attachments };
  return { body: "", isHtml: false, htmlAlternative: null, attachments };
}

// ---------------------------------------------------------------- addresses and MIME

const ADDR = /^[^\s<>@,;:"()\[\]\\]+@[^\s<>@,;:"()\[\]\\]+\.[^\s<>@,;:"()\[\]\\.]+$/;

/** "Name <a@b.c>, d@e.f" → ["a@b.c", "d@e.f"], lower-cased. Anything that is not an address is dropped. */
export function parseAddresses(value: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  const out: string[] = [];
  // Quoted display names may contain commas; take them out before splitting.
  for (const piece of raw.replace(/"(?:[^"\\]|\\.)*"/g, " ").split(/[,;]/)) {
    const m = /<([^<>]+)>/.exec(piece);
    const a = (m ? m[1] : piece).trim().toLowerCase();
    if (ADDR.test(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

/** Recipients a tool call asked for. Throws on anything that is not a plain address, so nothing odd reaches a header. */
export function requireAddresses(value: unknown, field: string): string[] {
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value.map(String) : String(value).split(/[,;]/);
  const out: string[] = [];
  for (const item of list) {
    const t = item.trim();
    if (!t) continue;
    if (/[\r\n]/.test(t)) throw new Error(`${field}: an address contains a line break`);
    const parsed = parseAddresses(t);
    if (parsed.length !== 1) throw new Error(`${field}: "${t.slice(0, 80)}" is not an email address`);
    if (!out.includes(parsed[0])) out.push(parsed[0]);
  }
  if (out.length > 50) throw new Error(`${field}: too many recipients`);
  return out;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const msgIds = (s: string) => (oneLine(s).match(/<[^<>\s]+>/g) ?? []).join(" ");

export interface OutgoingMail {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Message-ID of the mail being answered, with its angle brackets. */
  inReplyTo?: string | null;
  references?: string | null;
}

/** RFC 5322 text for a plain-text mail. Header values are single lines; the body is base64, so it cannot add headers. */
export function buildMime(m: OutgoingMail): string {
  const lines: string[] = [];
  if (m.to.length) lines.push(`To: ${m.to.join(", ")}`);
  if (m.cc.length) lines.push(`Cc: ${m.cc.join(", ")}`);
  if (m.bcc.length) lines.push(`Bcc: ${m.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeader(oneLine(m.subject))}`);
  const irt = m.inReplyTo ? msgIds(m.inReplyTo) : "";
  if (irt) {
    lines.push(`In-Reply-To: ${irt}`);
    const refs = [...new Set(`${m.references ? msgIds(m.references) : ""} ${irt}`.trim().split(/\s+/))].join(" ");
    lines.push(`References: ${refs}`);
  }
  lines.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "");
  const b64 = Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64");
  lines.push(...(b64.match(/.{1,76}/g) ?? [""]));
  return lines.join("\r\n");
}

export const toRaw = (mime: string) => Buffer.from(mime, "utf8").toString("base64url");

// ---------------------------------------------------------------- client

export interface GmailClientOptions {
  tokens: AccessTokens;
  endpoints: GmailEndpoints;
  fetchFn?: typeof fetch;
}

export class GmailClient {
  private fetchFn: typeof fetch;
  constructor(private o: GmailClientOptions) {
    this.fetchFn = o.fetchFn ?? fetch;
  }

  /** The only place a request is made. Refuses anything outside ALLOWED_CALLS before it touches the network. */
  private async call<T>(method: "GET" | "POST" | "PUT", path: string, query?: Record<string, string | string[] | number | undefined>, body?: unknown): Promise<T> {
    if (!isAllowedCall(method, path)) throw new GmailApiError(`HomeBase does not make this Gmail call: ${method} ${path}`, 0);
    const url = new URL(`${this.o.endpoints.api}/gmail/v1/users/me${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      for (const x of Array.isArray(v) ? v : [String(v)]) url.searchParams.append(k, x);
    }
    for (let attempt = 0; ; attempt++) {
      const token = await this.o.tokens.get();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        throw new GmailAuthError(`Could not reach Gmail: ${(err as Error).message}`, "network");
      }
      if (res.status === 401 && attempt === 0) {
        this.o.tokens.reset(); // an access token that expired early: refresh once
        continue;
      }
      if (!res.ok) {
        let message = "";
        try {
          message = String(((await res.json()) as any)?.error?.message ?? "");
        } catch {
          // no JSON body
        }
        if (res.status === 403 && /scope|permission/i.test(message)) throw new GmailApiError("Gmail refused: this action is outside the access HomeBase was granted (read and drafts only).", 403);
        throw new GmailApiError(`Gmail API ${res.status}${message ? `: ${message.slice(0, 200)}` : ""}`, res.status);
      }
      return (await res.json()) as T;
    }
  }

  profile() {
    return this.call<{ emailAddress: string; historyId: string }>("GET", "/profile");
  }

  listMessages(q: string, maxResults: number, labelIds?: string[]) {
    return this.call<{ messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number }>("GET", "/messages", { q: q || undefined, maxResults, labelIds });
  }

  getMessageMetadata(id: string, headers = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "References", "Reply-To"]) {
    return this.call<GmailMessage>("GET", `/messages/${id}`, { format: "metadata", metadataHeaders: headers });
  }

  getThread(id: string, format: "full" | "metadata" = "full") {
    return this.call<GmailThread>("GET", `/threads/${id}`, format === "metadata"
      ? { format, metadataHeaders: ["From", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID", "References", "Reply-To"] } : { format });
  }

  listHistory(startHistoryId: string, pageToken?: string) {
    return this.call<{ history?: Array<{ id: string; messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds?: string[] } }> }>; historyId?: string; nextPageToken?: string }>(
      "GET", "/history", { startHistoryId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: 100, pageToken },
    );
  }

  listDrafts(maxResults: number) {
    return this.call<{ drafts?: Array<{ id: string; message: { id: string; threadId: string } }> }>("GET", "/drafts", { maxResults });
  }

  getDraft(id: string) {
    return this.call<GmailDraft>("GET", `/drafts/${id}`, { format: "full" });
  }

  createDraft(raw: string, threadId?: string | null) {
    return this.call<GmailDraft>("POST", "/drafts", undefined, { message: { raw, ...(threadId ? { threadId } : {}) } });
  }

  updateDraft(id: string, raw: string, threadId?: string | null) {
    return this.call<GmailDraft>("PUT", `/drafts/${id}`, undefined, { message: { raw, ...(threadId ? { threadId } : {}) } });
  }

  /** Sends an existing draft. Called from exactly one place: the approved branch of gmail_send_draft. */
  sendDraft(id: string) {
    return this.call<GmailMessage>("POST", "/drafts/send", undefined, { id });
  }
}
