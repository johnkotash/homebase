import { describe, expect, it } from "vitest";
import {
  MUTATIONS, SESSION_FILTERS, Thread, buildSessionRows, countsAsAgentOutput, filterSessions, isUnread, readUpTo, unreadCount,
  type Thread as ThreadT,
} from "../src";

const thread = (id: string, extra: Partial<ThreadT> = {}): ThreadT => ({
  id, title: id, agentId: "agt_1", lastMessageAt: 1000, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 1, ...extra,
});

describe("unread sessions", () => {
  it("a session is unread while the agent's last output is later than what the owner has seen", () => {
    expect(isUnread({ lastAgentAt: 2000, readAt: 1000 })).toBe(true);
    expect(isUnread({ lastAgentAt: 2000, readAt: 2000 })).toBe(false);
    expect(isUnread({ lastAgentAt: 2000, readAt: 3000 })).toBe(false);
    // The agent spoke and the owner never looked.
    expect(isUnread({ lastAgentAt: 2000, readAt: null })).toBe(true);
    expect(isUnread({ lastAgentAt: 2000 })).toBe(true);
  });

  it("a session the agent never spoke in, or one from before read state existed, is not unread", () => {
    expect(isUnread({ lastAgentAt: null, readAt: null })).toBe(false);
    expect(isUnread({})).toBe(false);
    expect(isUnread({ readAt: 5000 })).toBe(false);
    // The fields are optional on the wire: a thread row from an older hub still parses.
    expect(Thread.safeParse(thread("thr_old")).success).toBe(true);
    expect(Thread.safeParse(thread("thr_new", { lastAgentAt: 5, readAt: null })).success).toBe(true);
  });

  it("counts sessions, not messages, and leaves archived sessions out", () => {
    const threads = [
      thread("a", { lastAgentAt: 3000, readAt: 1000 }),
      thread("b", { lastAgentAt: 3000, readAt: 3000 }),
      thread("c", { lastAgentAt: 9000 }),
      thread("d", { lastAgentAt: 9000, archived: true }),
      thread("e"),
    ];
    expect(unreadCount(threads)).toBe(2);
    expect(unreadCount([])).toBe(0);
  });

  it("reading moves readAt up to what the agent has said: never back, never past it", () => {
    // Everything the agent said, when the device names no time.
    expect(readUpTo({ lastAgentAt: 3000, readAt: 1000 })).toBe(3000);
    // The device saw the reply from 2000; one that landed at 3000 a moment later stays unread.
    expect(readUpTo({ lastAgentAt: 3000, readAt: 1000 }, 2000)).toBe(2000);
    expect(isUnread({ lastAgentAt: 3000, readAt: 2000 })).toBe(true);
    // A device with a fast clock cannot mark output it has not seen.
    expect(readUpTo({ lastAgentAt: 3000, readAt: 1000 }, 99_999)).toBe(3000);
    // Nothing to write: already read, an older time, or nothing was ever said.
    expect(readUpTo({ lastAgentAt: 3000, readAt: 3000 })).toBeNull();
    expect(readUpTo({ lastAgentAt: 3000, readAt: 3000 }, 2000)).toBeNull();
    expect(readUpTo({ lastAgentAt: null, readAt: null })).toBeNull();
    expect(readUpTo({})).toBeNull();
  });

  it("what counts as agent output: replies, mail cards and failures; not the owner, a dictation receipt or a switch marker", () => {
    expect(countsAsAgentOutput({ role: "assistant" })).toBe(true);
    expect(countsAsAgentOutput({ role: "assistant", card: null })).toBe(true);
    expect(countsAsAgentOutput({ role: "system" })).toBe(true); // "Run failed: …"
    expect(countsAsAgentOutput({ role: "assistant", card: { type: "gmail_draft" } as any })).toBe(true);
    expect(countsAsAgentOutput({ role: "user" })).toBe(false);
    expect(countsAsAgentOutput({ role: "assistant", card: { type: "vault_capture" } as any })).toBe(false);
    expect(countsAsAgentOutput({ role: "system", card: { type: "session_marker" } as any })).toBe(false);
  });

  it("session rows carry it, and the Unread filter shows only those (never archived ones)", () => {
    const rows = buildSessionRows({
      threads: [
        thread("a", { lastAgentAt: 3000, readAt: 1000 }),
        thread("b", { lastAgentAt: 3000, readAt: 3000 }),
        thread("c", { lastAgentAt: 9000, archived: true }),
      ],
      projects: {}, agents: {},
    });
    expect(Object.fromEntries(rows.map((r) => [r.thread.id, r.unread]))).toEqual({ a: true, b: false, c: true });
    expect(filterSessions(rows, { filter: "unread" }).map((r) => r.thread.id)).toEqual(["a"]);
    expect(filterSessions(rows, { filter: "open" }).map((r) => r.thread.id)).toEqual(["a", "b"]);
    expect(SESSION_FILTERS.map((f) => f.value)).toContain("unread");
  });

  it("thread.read takes a session and, optionally, the time the device had seen", () => {
    expect(MUTATIONS["thread.read"].safeParse({ threadId: "thr_1" }).success).toBe(true);
    expect(MUTATIONS["thread.read"].safeParse({ threadId: "thr_1", at: 1234 }).success).toBe(true);
    expect(MUTATIONS["thread.read"].safeParse({ at: 1234 }).success).toBe(false);
    expect(MUTATIONS["thread.read"].safeParse({ threadId: "thr_1", at: 1.5 }).success).toBe(false);
  });
});
