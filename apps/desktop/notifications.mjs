// Electron wiring for native notifications. The logic is in notifyCore.mjs (tested without Electron).
import { BrowserWindow, ipcMain, Notification } from "electron";
import { registerNotifications } from "./notifyCore.mjs";

/** Call once, after the app is ready. */
export function setupDesktopNotifications() {
  return registerNotifications({
    ipcMain,
    Notification,
    windowFor: (sender) => BrowserWindow.fromWebContents(sender),
    log: (...args) => console.error(...args),
  });
}
