// Runs in the sandboxed renderer before the web app. Exposes a tiny, read-only bridge.
// (MVP: add safeStorage-backed token storage here so the device token leaves localStorage.)
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("homebaseDesktop", {
  isDesktop: true,
  platform: process.platform,
});

// Native notifications (apps/desktop/notifyCore.mjs). The web app asks for one when its subject is not on
// screen or the window is not in front; a click focuses the window and hands back the route to open.
{
  const { ipcRenderer } = require("electron");
  contextBridge.exposeInMainWorld("homebaseDesktopNotify", {
    notify: (n) => ipcRenderer.invoke("hb:notify", n),
    dismissNotification: (key) => ipcRenderer.send("hb:notify-dismiss", key),
    onOpenLink: (cb) => {
      const handler = (_event, link) => cb(link);
      ipcRenderer.on("hb:open", handler);
      return () => ipcRenderer.removeListener("hb:open", handler);
    },
  });
}

// Dictation (apps/desktop/stt.mjs). The page records the microphone and sends 16 kHz mono audio; the shell
// runs the speech model in its own process and sends back the text, live and once more at the end.
{
  const { ipcRenderer } = require("electron");
  contextBridge.exposeInMainWorld("homebaseDesktopStt", {
    start: (opts) => ipcRenderer.invoke("hb:stt-start", opts),
    audio: (id, samples) => ipcRenderer.send("hb:stt-audio", id, samples),
    stop: (id) => ipcRenderer.send("hb:stt-stop", id),
    cancel: (id) => ipcRenderer.send("hb:stt-cancel", id),
    onEvent: (cb) => {
      const handler = (_event, e) => cb(e);
      ipcRenderer.on("hb:stt-event", handler);
      return () => ipcRenderer.removeListener("hb:stt-event", handler);
    },
  });
}

// The hub connection (apps/desktop/hubConnection.mjs): only in the installed app and with --static. The shell
// runs the SSH tunnel to the hub's server (or checks a direct address) and tells the page where the hub is.
if (process.argv.includes("--hb-connection")) {
  const { ipcRenderer } = require("electron");
  let initial = null;
  try {
    initial = ipcRenderer.sendSync("hb:conn-snapshot");
  } catch {}
  contextBridge.exposeInMainWorld("homebaseDesktopConnection", {
    /** { config, configured, state } when the page loaded. */
    initial,
    get: () => ipcRenderer.invoke("hb:conn-get"),
    /** Validates, saves and (re)connects. { ok: true, config, configured, state } or { ok: false, errors }. */
    save: (config) => ipcRenderer.invoke("hb:conn-save", config),
    retry: () => ipcRenderer.invoke("hb:conn-retry"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("hb:conn-state", handler);
      return () => ipcRenderer.removeListener("hb:conn-state", handler);
    },
  });
}
