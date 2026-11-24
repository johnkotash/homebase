import { countsAsAgentOutput, readUpTo, type Message, type MutationArgs } from "@homebase/protocol";
import type { Tx } from "./WorkspaceHub";

/**
 * Unread state for sessions, kept on the thread so every device shows the same thing:
 *   lastAgentAt  when the agent last put something in the session (a reply, a mail card, a failed run)
 *   readAt       up to when the owner has seen that, on any device
 * A session is unread while lastAgentAt is later than readAt (`isUnread` in the protocol package).
 * Sessions from before these columns existed have neither, which reads as "nothing unread": no backfill.
 */

/** Called for every message row the hub writes, whoever wrote it. */
export function onMessageWritten(tx: Tx, m: Message) {
  const th = tx.get("threads", m.threadId);
  if (!th) return;
  if (m.role === "user") {
    // Whoever writes in a session has it in front of them: everything before their message is read.
    const upTo = readUpTo(th);
    if (upTo != null) tx.upsert("threads", { ...th, readAt: upTo });
    return;
  }
  if (countsAsAgentOutput(m) && m.createdAt > (th.lastAgentAt ?? 0)) tx.upsert("threads", { ...th, lastAgentAt: m.createdAt });
}

/** `thread.read`: a device has the session in view. Never moves `readAt` back, never past what the agent has said. */
export function markRead(tx: Tx, a: MutationArgs<"thread.read">) {
  const th = tx.get("threads", a.threadId);
  if (!th) return; // archived away or deleted meanwhile: there is nothing left to mark
  const upTo = readUpTo(th, a.at);
  if (upTo != null) tx.upsert("threads", { ...th, readAt: upTo });
}
