// Electron wiring for the hub connection. The logic is in connection.mjs (settings, ssh command line, error
// wording) and tunnel.mjs (the state machine), both tested without Electron. Active in the installed app and
// with --static; the dev setup (npm run desktop on the Expo dev server) keeps its own hub address.
import { BrowserWindow, app, ipcMain } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { findFreePort, findSshBinary, loadConnectionConfig, probeHub, saveConnectionConfig, validateConfig } from "./connection.mjs";
import { ConnectionManager, killStaleTunnel } from "./tunnel.mjs";

/** Whether `pid` is a running ssh (so a pid file left by a crash never kills something else). */
function isSshProcess(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      return /^"ssh\.exe"/im.test(out.trim());
    }
    return /(^|\/)ssh$/.test(execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 5000 }).trim());
  } catch {
    return false;
  }
}

/** Call once, after the app is ready. */
export function setupHubConnection() {
  const dir = app.getPath("userData");
  const file = join(dir, "connection.json");
  const pidFile = join(dir, "ssh-tunnel.pid");
  const log = (...a) => console.error(...a);

  if (killStaleTunnel({
    readPid: () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8").trim()) || null : null),
    isSsh: isSshProcess,
    kill: (pid) => process.kill(pid),
    clear: () => fs.rmSync(pidFile, { force: true }),
  })) log("[connection] ended an ssh tunnel left over from an earlier run");

  let loaded = loadConnectionConfig(file, fs);
  if (loaded.warning) log(`[connection] ${loaded.warning}`);

  const manager = new ConnectionManager({
    sshPath: findSshBinary(),
    spawn: (cmd, args) => spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }),
    probe: (url) => probeHub(url),
    findPort: findFreePort,
    onPid: (pid) => {
      try {
        if (pid) fs.writeFileSync(pidFile, String(pid));
        else fs.rmSync(pidFile, { force: true });
      } catch {}
    },
    log,
  });

  const snapshot = () => ({ config: loaded.config, configured: loaded.configured, state: manager.getState() });
  manager.onChange((state) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send("hb:conn-state", state);
  });

  // Only the app's own window (its top frame) may read or change the connection.
  const fromApp = (event) => !!BrowserWindow.fromWebContents(event.sender) && event.senderFrame === event.sender.mainFrame;
  ipcMain.on("hb:conn-snapshot", (event) => {
    event.returnValue = fromApp(event) ? snapshot() : null;
  });
  ipcMain.handle("hb:conn-get", (event) => (fromApp(event) ? snapshot() : null));
  ipcMain.handle("hb:conn-save", (event, input) => {
    if (!fromApp(event)) return { ok: false, errors: { mode: "Not allowed from this page." } };
    const v = validateConfig(input);
    if (!v.ok) return v;
    try {
      saveConnectionConfig(file, v.config, fs, dir);
    } catch (err) {
      return { ok: false, errors: { mode: `Could not save the setting: ${err.message}` } };
    }
    loaded = { config: v.config, configured: true };
    manager.start(v.config);
    return { ok: true, ...snapshot() };
  });
  ipcMain.handle("hb:conn-retry", (event) => {
    if (fromApp(event)) manager.retry();
    return snapshot();
  });

  if (loaded.configured) manager.start(loaded.config);

  // No ssh outlives the app: stopped on quit (ssh is killed at once), and again if the process exits some other way.
  app.on("will-quit", () => void manager.stop());
  process.on("exit", () => void manager.stop());
  return manager;
}
