import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { Platform } from "react-native";
import type { Notification as HbNotification } from "@homebase/protocol";
import { mutate, showToast, syncStore } from "../sync/session";
import { color } from "../theme";
import { getPresence } from "./presence";
import { deliver, isAppLink } from "./rules";

const isWeb = Platform.OS === "web";

/** What the desktop shell (apps/desktop/preload.cjs) offers the web app. Missing in a browser and in an older shell. */
interface DesktopBridge {
  notify?(n: { key: string; title: string; body: string; link: string | null; silent: boolean }): Promise<boolean>;
  dismissNotification?(key: string): void;
  onOpenLink?(cb: (link: string) => void): () => void;
}
const desktop = (): DesktopBridge | undefined => (isWeb && typeof window !== "undefined" ? (window as any).homebaseDesktopNotify : undefined);

/** System notifications this device is showing, by subject key, with the route each one opens. */
const raised = new Map<string, { link: string | null; web?: { close(): void } }>();

// Channel IDs and importance from ARCHITECTURE.md 11.1. The owner tunes sound and DND per channel in Android settings.
const CHANNELS: Array<{ id: string; name: string; importance: Notifications.AndroidImportance; description: string; sound?: boolean }> = [
  { id: "approvals", name: "Approvals", importance: Notifications.AndroidImportance.HIGH, description: "An agent is waiting for your decision", sound: true },
  { id: "p0_urgent", name: "Urgent (P0)", importance: Notifications.AndroidImportance.HIGH, description: "P0 inbox items and SLA breaches", sound: true },
  { id: "p1_today", name: "Today (P1)", importance: Notifications.AndroidImportance.DEFAULT, description: "P1 items, SLA warnings, failed runs" },
  { id: "agent_updates", name: "Agent updates", importance: Notifications.AndroidImportance.LOW, description: "Runs finished and progress milestones" },
  { id: "digest", name: "Digests", importance: Notifications.AndroidImportance.LOW, description: "Scheduled summaries" },
];

let setup: Promise<void> | null = null;
let askedPermission = false;

export function setupNotifications(): Promise<void> {
  if (isWeb) {
    // Desktop: a click on a native notification brings the window forward (the shell does that) and opens what it was about.
    setup ??= Promise.resolve().then(() => {
      desktop()?.onOpenLink?.((link) => {
        if (isAppLink(link)) router.push(link as any);
      });
    }).catch(() => {});
    return setup;
  }
  setup ??= (async () => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
    });
    for (const c of CHANNELS) {
      await Notifications.setNotificationChannelAsync(c.id, {
        name: c.name, importance: c.importance, description: c.description, lightColor: color.accent,
        vibrationPattern: c.sound ? [0, 180, 120, 180] : undefined, enableVibrate: !!c.sound,
      });
    }
    // Approve / Deny straight from the notification for low and medium risk only.
    await Notifications.setNotificationCategoryAsync("approval_actions", [
      { identifier: "approve", buttonTitle: "Approve", options: { opensAppToForeground: false } },
      { identifier: "deny", buttonTitle: "Deny", options: { opensAppToForeground: false, isDestructive: true } },
    ]);
    Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = (resp.notification.request.content.data ?? {}) as { link?: string; approvalId?: string };
      const action = resp.actionIdentifier;
      if ((action === "approve" || action === "deny") && data.approvalId) {
        void mutate("approval.decide", { approvalId: data.approvalId, decision: action });
        void Notifications.dismissNotificationAsync(resp.notification.request.identifier).catch(() => {});
        return;
      }
      if (data.link) router.push(data.link as any);
    });
  })().catch(() => {});
  return setup;
}

/** POST_NOTIFICATIONS is requested at first use, not at launch. */
export async function ensureNotificationPermission(interactive = true): Promise<boolean> {
  if (isWeb) {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") return true;
    if (!interactive || Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  }
  const cur = await Notifications.getPermissionsAsync();
  if (cur.granted) return true;
  if (!interactive || (!cur.canAskAgain && askedPermission)) return false;
  askedPermission = true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** True when this device can show a system notification right now without asking for anything. */
function canRaiseOs(): boolean {
  if (!isWeb) return true;
  if (desktop()?.notify) return true;
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/**
 * A hub `notify` frame arrives on every connected device; each device decides here what to do with it
 * (rules.ts): nothing when the owner is looking at its subject, an in-app toast when the app is in
 * front on another screen, a system notification when it is not in front.
 *
 * There is no push service yet (ROADMAP 1b): a phone only hears about anything while the app is still
 * alive in the background with its socket open. Once Android stops it, nothing arrives until it is opened.
 */
export async function presentNotification(n: HbNotification) {
  const e = syncStore.getState().entities;
  const how = deliver(n, getPresence(), { approvals: e.approvals, runs: e.runs }, canRaiseOs());
  if (how === "none") return;
  if (how === "toast") {
    showToast(n.title, n.body, n.priority === "P0" ? "error" : undefined, n.link ?? null);
    // POST_NOTIFICATIONS is asked for at first use, while the app is in front, so the background path can work later.
    if (!isWeb) void setupNotifications().then(() => ensureNotificationPermission(true)).catch(() => {});
    return;
  }
  const key = n.collapseKey ?? n.id; // one notification per subject; a newer one replaces it
  const link = isAppLink(n.link) ? n.link : null;
  const silent = n.channel === "agent_updates" || n.channel === "digest";
  if (isWeb) {
    const bridge = desktop();
    if (bridge?.notify) {
      // Electron: a native notification from the main process. Clicking it focuses the window and opens the link.
      raised.set(key, { link });
      const shown = await bridge.notify({ key, title: n.title, body: n.body, link, silent }).catch(() => false);
      if (!shown) {
        raised.delete(key);
        showToast(n.title, n.body, n.priority === "P0" ? "error" : undefined, link);
      }
      return;
    }
    try {
      const w = new Notification(n.title, { body: n.body, tag: key, silent });
      raised.set(key, { link, web: w });
      w.onclick = () => {
        window.focus();
        w.close();
        if (link) router.push(link as any);
      };
      w.onclose = () => void (raised.get(key)?.web === w && raised.delete(key));
    } catch {}
    return;
  }
  await setupNotifications();
  if (!(await ensureNotificationPermission(true))) return;
  const approvalId = n.channel === "approvals" && n.collapseKey?.startsWith("apr_") ? n.collapseKey : undefined;
  const canActInline = approvalId && n.actions?.includes("approve");
  raised.set(key, { link });
  await Notifications.scheduleNotificationAsync({
    identifier: key,
    content: {
      title: n.title, body: n.body, data: { link, approvalId: approvalId ?? null },
      categoryIdentifier: canActInline ? "approval_actions" : undefined,
      color: n.priority === "P0" ? color.p0 : color.accent,
      priority: n.channel === "approvals" || n.channel === "p0_urgent" ? Notifications.AndroidNotificationPriority.MAX : Notifications.AndroidNotificationPriority.DEFAULT,
    },
    trigger: { channelId: n.channel },
  }).catch(() => {});
}

/** "Cancel on all devices when handled anywhere": drop the notification once its subject is settled. */
export function dismissNotification(collapseKey: string) {
  const r = raised.get(collapseKey);
  raised.delete(collapseKey);
  if (isWeb) {
    desktop()?.dismissNotification?.(collapseKey);
    try {
      r?.web?.close();
    } catch {}
    return;
  }
  void Notifications.dismissNotificationAsync(collapseKey).catch(() => {});
}

/** Drops every system notification this device raised that opens `link`: the owner has now seen it, here or elsewhere. */
export function dismissNotificationsFor(link: string) {
  for (const [key, r] of [...raised]) if (r.link === link) dismissNotification(key);
}
