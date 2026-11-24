// HomeBase desktop shell. No UI of its own: it shows the Expo web app.
//   dev (default):  loads the Expo web dev server (HB_DEV_URL, default http://localhost:8081)
//   --static:       serves ../client/dist through app:// with SPA fallback (run `npm run build:web` first)
//   installed:      serves the web export bundled next to this file (./web), like --static
// With --static and in the installed app the shell also connects to the hub itself (hubConnection.mjs):
// an SSH tunnel to the hub's server or a direct address, chosen in the window and kept in userData/connection.json.
import { app, BrowserWindow, Menu, net, protocol, shell } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupHubConnection } from "./hubConnection.mjs";
import { setupDesktopNotifications } from "./notifications.mjs";
import { allowsMicrophone, setupDesktopStt } from "./stt.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The installed app carries the web export in ./web; from the source tree it is the client's own export.
const BUNDLED = join(here, "web");
const DIST = existsSync(join(BUNDLED, "index.html")) ? BUNDLED : resolve(here, "..", "client", "dist");
const useStatic = process.argv.includes("--static") || app.isPackaged;
const DEV_URL = process.env.HB_DEV_URL || "http://localhost:8081";

// Each profile keeps its own pairing; HB_PROFILE lets two desktop windows act as two devices.
// The installed app has a profile of its own (HomeBase-desktop), apart from the dev runs' folders.
const profile = process.env.HB_PROFILE || (app.isPackaged ? "desktop" : "");
if (profile) app.setPath("userData", join(app.getPath("appData"), `HomeBase-${profile}`));
app.setName("HomeBase");
// Needed for desktop notifications on Windows; must equal the installer's appId, which scripts/desktop-dist.mjs writes
// into the installed app's package.json ("homebase.appId"). From source: HOMEBASE_APP_ID or the default.
if (process.platform === "win32") app.setAppUserModelId(appId());
function appId() {
  try {
    const id = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).homebase?.appId;
    if (typeof id === "string" && id) return id;
  } catch {}
  return process.env.HOMEBASE_APP_ID || "com.kotashbuilds.homebase";
}

// One window per profile: opening the icon again brings the running window to the front (and never starts a second tunnel).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function serveStatic() {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    let file = normalize(join(DIST, rel));
    // Never serve anything outside the export directory.
    if (file !== DIST && !file.startsWith(DIST + sep)) return new Response("Forbidden", { status: 403 });
    const isFile = existsSync(file) && statSync(file).isFile();
    // SPA fallback: unknown paths without a file extension are client-side routes.
    if (!isFile) {
      if (extname(rel)) return new Response("Not found", { status: 404 });
      file = join(DIST, "index.html");
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 420,
    minHeight: 560,
    title: "HomeBase",
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      // Tells the preload that this shell runs the hub connection (installed app, --static), so the page asks it for the hub.
      additionalArguments: useStatic ? ["--hb-connection"] : [],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("page-title-updated", (e) => e.preventDefault()); // the window is always titled "HomeBase"

  // Desktop notifications for hub notify frames, and the microphone for dictation (audio only, and only
  // for the app's own pages: stt.mjs). Everything else is denied.
  const micOrigin = useStatic ? "app://homebase" : new URL(DEV_URL).origin;
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permission === "notifications" || allowsMicrophone(permission, details, micOrigin)));
  win.webContents.session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => permission === "notifications" || allowsMicrophone(permission, { ...details, requestingOrigin }, micOrigin));

  // The app never navigates away from itself; outside links open in the system browser.
  const appOrigin = useStatic ? "app://homebase" : new URL(DEV_URL).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(appOrigin)) e.preventDefault();
  });

  const target = useStatic ? "app://homebase/" : DEV_URL;
  win.loadURL(target).catch(() => {
    const hint = useStatic
      ? `No web build at ${DIST}. Run: npm run build:web`
      : `The web dev server is not running at ${DEV_URL}. Run: npm run web  (or use npm run desktop:static)`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<body style="background:#000000;color:#FAFAFA;font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:520px;padding:24px"><h2>HomeBase can't load its UI</h2><p style="color:#A3A3A3">${hint}</p></div></body>`,
    )}`);
  });
  return win;
}

app.whenReady().then(() => {
  if (useStatic) {
    if (!existsSync(join(DIST, "index.html"))) console.error(`[desktop] no web build at ${DIST}; run npm run build:web`);
    serveStatic();
  }
  Menu.setApplicationMenu(null);
  setupDesktopNotifications(); // native notifications asked for by the web app; a click focuses the window
  setupDesktopStt(); // dictation: the speech model runs in its own process, started on the first use
  if (useStatic) setupHubConnection(); // the SSH tunnel to the hub's server, or a direct hub address (the window asks on the first run)
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
