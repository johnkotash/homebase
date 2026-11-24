// Electron wiring for desktop dictation. The logic is in sttCore.mjs (tested without Electron) and the
// model runs in its own process (sttWorker.mjs). Why Whisper and not the Web Speech API: docs/DESKTOP-DICTATION.md.
import { BrowserWindow, app, ipcMain, utilityProcess } from "electron";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowsMicrophone, createSttBroker } from "./sttCore.mjs";

export { allowsMicrophone };

const here = dirname(fileURLToPath(import.meta.url));

/** Where the speech model is kept: outside the source tree and outside the app data that holds the pairing. */
export function sttModelDir() {
  if (process.env.HB_STT_MODEL_DIR) return process.env.HB_STT_MODEL_DIR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "HomeBase", "models");
  return join(homedir(), ".cache", "homebase", "models");
}

/** Call once, after the app is ready. */
export function setupDesktopStt() {
  const send = (ownerId, event) => {
    const wc = BrowserWindow.getAllWindows().map((w) => w.webContents).find((c) => c.id === ownerId);
    if (wc && !wc.isDestroyed()) wc.send("hb:stt-event", event);
  };
  const broker = createSttBroker({
    send,
    log: (...args) => console.error(...args),
    engine: { profile: process.env.HB_STT_PROFILE, device: process.env.HB_STT_DEVICE },
    fork: () => {
      const child = utilityProcess.fork(join(here, "sttWorker.mjs"), [], {
        serviceName: "HomeBase speech", stdio: "pipe",
        env: { ...process.env, HB_STT_MODEL_DIR: sttModelDir() },
      });
      child.stdout?.on("data", (d) => process.stdout.write(d));
      child.stderr?.on("data", (d) => process.stderr.write(d));
      return child;
    },
  });

  // Only the app's own window (its top frame) may dictate.
  const owner = (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || event.senderFrame !== event.sender.mainFrame) return null;
    return event.sender;
  };
  const watched = new WeakSet();
  const watch = (wc) => {
    if (watched.has(wc)) return;
    watched.add(wc);
    const gone = () => broker.ownerGone(wc.id);
    wc.on("destroyed", gone);
    wc.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) gone(); // a reload drops the page that was recording
    });
  };

  ipcMain.handle("hb:stt-start", (event, opts) => {
    const wc = owner(event);
    if (!wc) throw new Error("Dictation is only available in the HomeBase window");
    watch(wc);
    return broker.start(wc.id, { profile: typeof opts?.profile === "string" ? opts.profile : undefined });
  });
  ipcMain.on("hb:stt-audio", (event, id, data) => {
    const wc = owner(event);
    if (wc) broker.audio(wc.id, id, data);
  });
  ipcMain.on("hb:stt-stop", (event, id) => {
    const wc = owner(event);
    if (wc) broker.stop(wc.id, id);
  });
  ipcMain.on("hb:stt-cancel", (event, id) => {
    const wc = owner(event);
    if (wc) broker.cancel(wc.id, id);
  });
  app.on("before-quit", () => broker.dispose());
  return broker;
}
