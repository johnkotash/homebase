import { describe, expect, it } from "vitest";
import { isUnread, unreadCount, type Thread } from "@homebase/protocol";
import { applyOptimistic, emptyMaps } from "../src";

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id, title: id, agentId: "agt_1", lastMessageAt: 1000, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 1, ...extra,
});

function server() {
  const maps = emptyMaps();
  maps.threads = {
    thr_unread: thread("thr_unread", { lastAgentAt: 3000, readAt: 1000 }),
    thr_read: thread("thr_read", { lastAgentAt: 3000, readAt: 3000 }),
    thr_old: thread("thr_old"),
  };
  return maps;
}
const m = (args: unknown, at: number) => ({ id: `m${at}`, name: "thread.read" as const, args, at });

describe("thread.read, predicted on the device", () => {
  it("the dot and the badge clear at once, before the hub answers", () => {
    const s = server();
    expect(unreadCount(Object.values(s.threads))).toBe(1);
    const out = applyOptimistic(s, [m({ threadId: "thr_unread", at: 3000 }, 5)], "dev_1");
    expect(out.threads.thr_unread).toMatchObject({ readAt: 3000, lastAgentAt: 3000 });
    expect(unreadCount(Object.values(out.threads))).toBe(0);
    // The server copy is untouched: the hub's row replaces the prediction when it arrives.
    expect(s.threads.thr_unread.readAt).toBe(1000);
  });

  it("predicts what the hub will do: up to the time named, never past what the agent said", () => {
    const part = applyOptimistic(server(), [m({ threadId: "thr_unread", at: 2000 }, 5)], "dev_1");
    expect(part.threads.thr_unread.readAt).toBe(2000);
    expect(isUnread(part.threads.thr_unread)).toBe(true);
    const fast = applyOptimistic(server(), [m({ threadId: "thr_unread", at: 9_999_999 }, 5)], "dev_1");
    expect(fast.threads.thr_unread.readAt).toBe(3000);
    const all = applyOptimistic(server(), [m({ threadId: "thr_unread" }, 5)], "dev_1");
    expect(all.threads.thr_unread.readAt).toBe(3000);
  });

  it("leaves a read session, a session from before read state and an unknown one alone", () => {
    const s = server();
    const out = applyOptimistic(s, [m({ threadId: "thr_read", at: 3000 }, 5), m({ threadId: "thr_old" }, 6), m({ threadId: "thr_gone" }, 7)], "dev_1");
    expect(out.threads.thr_read).toBe(s.threads.thr_read);
    expect(out.threads.thr_old).toBe(s.threads.thr_old);
    expect(out.threads.thr_gone).toBeUndefined();
  });
});
