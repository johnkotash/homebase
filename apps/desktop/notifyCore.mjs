// Native OS notifications for the HomeBase window, without a direct dependency on Electron so the
// logic can be tested (apps/desktop/test). notifications.mjs wires it to the real ipcMain/Notification.
//
// The web app decides WHEN a notification is due (apps/client/src/notifications/rules.ts: the session
// is not on screen, or the window is not in front). This file only shows it, and on a click brings the
// window forward and tells the web app which route to open.
//
// Channels:
//   hb:notify          renderer -> main (invoke)  { key, title, body, link, silent }  -> true when shown
//   hb:notify-dismiss  renderer -> main (send)    key: the subject was handled or read; take it down
//   hb:open            main -> renderer (send)    link: an in-app route to open after a click

const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Only routes inside the app: one leading slash, no scheme, no host. */
export const isAppLink = (link) => typeof link === "string" && /^\/(?![/\\])/.test(link) && link.length <= 500;

/**
 * `windowFor(sender)` returns the app window that hosts the web contents asking (or null): the
 * notification belongs to that window, and a click brings that same window forward.
 *
 * @param {{ ipcMain: any, Notification: any, windowFor: (sender: any) => any, log?: (...a: any[]) => void }} deps
 * @returns {{ live: Map<string, any>, dispose(): void }}
 */
export function registerNotifications({ ipcMain, Notification, windowFor, log = () => {} }) {
  /** One notification per subject: a newer one about the same thing replaces the old one. */
  const live = new Map();
  const drop = (key, n) => {
    if (live.get(key) === n) live.delete(key);
  };
  const windowOf = (event) => {
    const win = event?.sender ? windowFor(event.sender) : null;
    return win && !win.isDestroyed?.() ? win : null;
  };

  const onNotify = (event, raw) => {
    const win = windowOf(event);
    if (!win) return false;
    if (typeof Notification.isSupported === "function" && !Notification.isSupported()) return false;
    const title = text(raw?.title, 120) || "HomeBase";
    const key = text(raw?.key, 200) || `${title}:${Date.now()}`;
    const link = isAppLink(raw?.link) ? raw.link : null;
    try {
      live.get(key)?.close();
      const n = new Notification({ title, body: text(raw?.body, 400), silent: !!raw?.silent });
      n.on("click", () => {
        drop(key, n);
        if (win.isDestroyed?.()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (link) win.webContents.send("hb:open", link);
      });
      n.on("close", () => drop(key, n));
      n.on("failed", (_e, error) => {
        drop(key, n);
        log("[desktop] notification failed:", error);
      });
      live.set(key, n);
      n.show();
      return true;
    } catch (err) {
      log("[desktop] notification failed:", err?.message ?? err);
      return false;
    }
  };

  const onDismiss = (event, key) => {
    if (!windowOf(event) || typeof key !== "string") return;
    const n = live.get(key);
    if (!n) return;
    live.delete(key);
    try {
      n.close();
    } catch {}
  };

  ipcMain.handle("hb:notify", onNotify);
  ipcMain.on("hb:notify-dismiss", onDismiss);
  return {
    live,
    dispose() {
      ipcMain.removeHandler?.("hb:notify");
      ipcMain.removeListener?.("hb:notify-dismiss", onDismiss);
      for (const n of live.values()) {
        try {
          n.close();
        } catch {}
      }
      live.clear();
    },
  };
}
