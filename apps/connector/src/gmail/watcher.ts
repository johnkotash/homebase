import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InboxIngestFrame } from "@homebase/protocol";
import { GmailApiError, header, parseAddresses, type GmailClient, type GmailMessage } from "./client";
import { cleanLine, cleanText, detectInjection, type InjectionHit } from "./sanitize";
import type { InjectionFlag } from "./tools";

/**
 * Turns new INBOX mail into HomeBase inbox items (ARCHITECTURE.md 8.4).
 *
 * Read-only by construction: it lists history, reads message metadata (sender, subject, date, snippet)
 * and nothing else. It never marks mail read and never labels it; the two granted scopes could not do
 * that anyway. Bodies are not fetched here and never go to the hub.
 */

export type IngestItem = InboxIngestFrame["item"];

export interface WatcherState {
  historyId: string | null;
  /** Message ids already handed to the hub, newest last. */
  seen: string[];
}

const MAX_SEEN = 3000;
const SKIP_LABELS = ["SENT", "DRAFT", "SPAM", "TRASH", "CHAT"];

const decodeSnippet = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** "Dana Whitfield <dana@x.example>" → "Dana Whitfield"; a bare address stays an address. */
export function senderName(from: string): string {
  const name = from.replace(/<[^<>]*>/g, "").replace(/["']/g, "").trim();
  return name || parseAddresses(from)[0] || from.trim() || "unknown sender";
}

export const mailExternalId = (threadId: string, messageId: string) => `gmail:${threadId}:${messageId}`;
export const flagExternalId = (messageId: string) => `gmail-flag:${messageId}`;
export const threadUrl = (threadId: string) => `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

/** The P1 inbox item raised when mail looks like it is trying to instruct an agent. */
export function flagItem(f: InjectionFlag, receivedAt?: number): IngestItem {
  const who = cleanLine(senderName(f.from), 80);
  return {
    source: "gmail", kind: "flag", externalId: flagExternalId(f.messageId),
    title: `Possible prompt-injection in email from ${who}`.slice(0, 500),
    snippet: `Subject: ${cleanLine(f.subject, 150) || "(no subject)"}. Looks like: ${f.hits.map((h: InjectionHit) => h.label).join("; ")}. The Comms agent was told not to act on it.`.slice(0, 500),
    sender: cleanLine(f.from, 300) || null,
    externalUrl: f.threadId ? threadUrl(f.threadId) : null,
    ...(receivedAt ? { receivedAt } : {}),
  };
}

export interface WatcherOptions {
  client: GmailClient;
  /** Where the cursor is kept between polls and restarts. Null keeps it in memory (tests). */
  statePath?: string | null;
  /** Hands an item to the hub. False means it did not go out (link down): the poll stops and is retried. */
  emit(item: IngestItem): boolean;
  log?: (...a: unknown[]) => void;
  /** Search used on the first poll and whenever the history cursor is too old. */
  recentQuery?: string;
  recentMax?: number;
}

export interface PollResult {
  mode: "history" | "recent";
  /** Messages turned into inbox items by this poll. */
  added: number;
  flagged: number;
}

class Undelivered extends Error {}

export class InboxWatcher {
  private state: WatcherState = { historyId: null, seen: [] };
  private running: Promise<PollResult> | null = null;

  constructor(private o: WatcherOptions) {
    if (o.statePath && existsSync(o.statePath)) {
      try {
        const j = JSON.parse(readFileSync(o.statePath, "utf8"));
        this.state = { historyId: typeof j?.historyId === "string" ? j.historyId : null, seen: Array.isArray(j?.seen) ? j.seen.map(String).slice(-MAX_SEEN) : [] };
      } catch {
        // an unreadable cursor falls back to the recent-message query; the hub de-duplicates
      }
    }
  }

  get cursor(): WatcherState {
    return { historyId: this.state.historyId, seen: [...this.state.seen] };
  }

  /** One pass. Concurrent calls share the pass that is already running. */
  poll(): Promise<PollResult> {
    return (this.running ??= this.pollOnce().finally(() => (this.running = null)));
  }

  private save() {
    if (!this.o.statePath) return;
    try {
      mkdirSync(dirname(this.o.statePath), { recursive: true });
      writeFileSync(this.o.statePath, JSON.stringify(this.state), { mode: 0o600 });
    } catch (err) {
      this.o.log?.("gmail watcher: could not save its cursor:", (err as Error).message);
    }
  }

  private async pollOnce(): Promise<PollResult> {
    let mode: PollResult["mode"] = "history";
    let ids: string[] = [];
    let nextHistoryId: string | null = this.state.historyId;

    if (this.state.historyId) {
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < 20; page++) {
          const r = await this.o.client.listHistory(this.state.historyId, pageToken);
          for (const h of r.history ?? []) {
            for (const a of h.messagesAdded ?? []) {
              const labels = a.message.labelIds;
              if (labels && (!labels.includes("INBOX") || labels.some((l) => SKIP_LABELS.includes(l)))) continue;
              ids.push(a.message.id);
            }
          }
          if (r.historyId) nextHistoryId = r.historyId;
          pageToken = r.nextPageToken;
          if (!pageToken) break;
        }
      } catch (err) {
        // Gmail forgets history after about a week (404). Start again from recent mail.
        if (!(err instanceof GmailApiError && err.status === 404)) throw err;
        mode = "recent";
      }
    } else mode = "recent";

    if (mode === "recent") {
      // Take the cursor before listing, so mail that arrives during the listing is seen by the next history poll.
      nextHistoryId = (await this.o.client.profile()).historyId;
      const r = await this.o.client.listMessages(this.o.recentQuery ?? "in:inbox newer_than:1d", this.o.recentMax ?? 15, ["INBOX"]);
      ids = (r.messages ?? []).map((m) => m.id).reverse(); // oldest first
    }

    const seen = new Set(this.state.seen);
    const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
    let added = 0;
    let flagged = 0;
    try {
      for (const id of fresh) {
        let m: GmailMessage;
        try {
          m = await this.o.client.getMessageMetadata(id, ["From", "Subject", "Date"]);
        } catch (err) {
          if (err instanceof GmailApiError && err.status === 404) continue; // deleted in the meantime
          throw err;
        }
        const labels = m.labelIds ?? [];
        if (labels.includes("INBOX") && !labels.some((l) => SKIP_LABELS.includes(l))) {
          const r = this.report(m);
          added++;
          if (r.flagged) flagged++;
        }
        this.state.seen.push(id);
      }
    } catch (err) {
      // Keep what was delivered, leave the history cursor where it was, and try the rest on the next poll.
      this.state.seen = this.state.seen.slice(-MAX_SEEN);
      this.save();
      if (err instanceof Undelivered) return { mode, added, flagged };
      throw err;
    }
    this.state.historyId = nextHistoryId;
    this.state.seen = this.state.seen.slice(-MAX_SEEN);
    this.save();
    return { mode, added, flagged };
  }

  private report(m: GmailMessage): { flagged: boolean } {
    const from = cleanLine(header(m, "From"), 300);
    const subject = cleanLine(header(m, "Subject"), 480) || "(no subject)";
    const snippet = cleanText(decodeSnippet(m.snippet ?? ""), { maxLength: 400 }).text;
    const receivedAt = Number(m.internalDate) || undefined;
    const send = (item: IngestItem) => {
      if (!this.o.emit(item)) throw new Undelivered();
    };
    send({
      source: "gmail", kind: "mail", externalId: mailExternalId(m.threadId, m.id), title: subject, snippet: snippet || null, sender: from || null,
      externalUrl: threadUrl(m.threadId), ...(receivedAt ? { receivedAt } : {}),
    });
    const hits = detectInjection([from, subject, snippet].join("\n"));
    if (hits.length) send(flagItem({ messageId: m.id, threadId: m.threadId, from, subject, hits }, receivedAt));
    return { flagged: hits.length > 0 };
  }
}
