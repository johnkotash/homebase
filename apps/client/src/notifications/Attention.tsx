import { usePathname } from "expo-router";
import { useEffect, useRef } from "react";
import { isUnread } from "@homebase/protocol";
import { useSync } from "../sync/hooks";
import { mutate, syncStore } from "../sync/session";
import { dismissNotificationsFor } from "./index";
import { setPresencePath, usePresence, watchPresence } from "./presence";
import { sessionInView } from "./rules";

/**
 * Mounted once in the root layout; renders nothing. It keeps track of what the owner is looking at
 * (route + whether the app is in front) and does the two things that follow from it:
 *
 *  1. A session that is on screen while the app is in front is read. The hub is told (`thread.read`),
 *     so the unread dot and the Sessions badge clear on every device, not only this one.
 *  2. A session that became read, here or on another device, loses its system notification here.
 *
 * A session open in a window that is not in front is NOT read: its reply raises a notification and
 * stays unread until the owner comes back to it.
 */
export function Attention() {
  const path = usePathname();
  useEffect(() => setPresencePath(path), [path]);
  useEffect(() => watchPresence(), []);

  const presence = usePresence();
  const viewing = sessionInView(presence);
  const thread = useSync((s) => (viewing ? s.entities.threads[viewing] : undefined));
  const lastAgentAt = thread?.lastAgentAt ?? null;
  const readAt = thread?.readAt ?? null;
  // Never asks twice for the same reply, even if the hub refuses (an older hub does not know `thread.read`).
  const sent = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!thread || lastAgentAt == null || !isUnread(thread)) return;
    if ((sent.current[thread.id] ?? 0) >= lastAgentAt) return;
    sent.current[thread.id] = lastAgentAt;
    void mutate("thread.read", { threadId: thread.id, at: lastAgentAt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewing, lastAgentAt, readAt]);

  useEffect(() => {
    let prev = syncStore.getState().entities.threads;
    return syncStore.subscribe((s) => {
      const next = s.entities.threads;
      if (next === prev) return;
      for (const t of Object.values(next)) {
        const before = prev[t.id];
        if (before && isUnread(before) && !isUnread(t)) dismissNotificationsFor(`/chats/${t.id}`);
      }
      prev = next;
    });
  }, []);

  return null;
}
