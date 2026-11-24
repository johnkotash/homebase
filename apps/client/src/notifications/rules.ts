import type { Notification } from "@homebase/protocol";

/**
 * When a hub notification should interrupt, and how. Pure rules, shared by the phone, the browser and
 * the desktop window, so all three behave the same:
 *
 *   in front, and its subject is already on screen   nothing: the owner is looking at it
 *   in front, on another screen                      an in-app toast
 *   not in front (unfocused, minimized, backgrounded) a system notification; clicking it opens the subject
 *
 * "In front" is `Presence.focused`: the window has focus and is visible, or the phone app is in the
 * foreground. Nothing here touches React, the DOM or storage.
 */

export interface Presence {
  /** The route on screen, for example "/chats/thr_1". */
  path: string;
  /** The window has focus and is visible (desktop, browser), or the app is in the foreground (phone). */
  focused: boolean;
}

/** What the rules need to know about approvals and runs: where each one is shown. */
export interface SubjectLookup {
  approvals: Record<string, { runId: string } | undefined>;
  runs: Record<string, { threadId: string | null } | undefined>;
}

export type Delivery = "none" | "toast" | "os";

const clean = (path: string) => path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";

/** The session the owner is looking at right now, or null: another screen, or the app is not in front. */
export function sessionInView(p: Presence): string | null {
  if (!p.focused) return null;
  const m = /^\/chats\/([^/]+)$/.exec(clean(p.path));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Every route on which the thing a notification is about is already on screen: the route it links
 * to, and the session where the same reply, failure or approval card appears inline.
 */
export function routesShowing(n: Pick<Notification, "link" | "collapseKey">, look: SubjectLookup): string[] {
  if (!n.link) return [];
  const link = clean(n.link);
  // Only a notification about one particular thing (a session, a run, an approval, an inbox item) can be
  // "on screen". Anything else, like the test notification that links to Settings, always shows.
  const [, kind, id] = /^\/(chats|runs|approvals|inbox)\/([^/]+)$/.exec(link) ?? [];
  if (!kind) return [];
  const out = new Set([link]);
  const sessionOf = (runId: string | undefined) => {
    const threadId = runId ? look.runs[runId]?.threadId : null;
    if (threadId) out.add(`/chats/${threadId}`);
  };
  if (kind === "runs") sessionOf(id);
  if (kind === "approvals") {
    out.add("/approvals"); // the queue lists it
    sessionOf(look.approvals[id]?.runId);
  }
  // "Agent finished" links to the session; the run's own timeline shows the same ending.
  if (kind === "chats" && n.collapseKey && look.runs[n.collapseKey]?.threadId === id) out.add(`/runs/${n.collapseKey}`);
  return [...out];
}

/** True when the owner is already looking at what the notification is about. */
export function inView(n: Pick<Notification, "link" | "collapseKey">, presence: Presence, look: SubjectLookup): boolean {
  return presence.focused && routesShowing(n, look).includes(clean(presence.path));
}

/**
 * How to deliver a notification on this device right now. `canRaiseOs` is false where no system
 * notification can be shown (a browser tab without the permission): the toast is the fallback there.
 */
export function deliver(n: Pick<Notification, "link" | "collapseKey">, presence: Presence, look: SubjectLookup, canRaiseOs: boolean): Delivery {
  if (presence.focused) return inView(n, presence, look) ? "none" : "toast";
  return canRaiseOs ? "os" : "toast";
}

/** Only routes inside the app are opened from a notification: one leading slash, no scheme, no host. */
export function isAppLink(link: unknown): link is string {
  return typeof link === "string" && /^\/(?![/\\])/.test(link) && link.length <= 500;
}
