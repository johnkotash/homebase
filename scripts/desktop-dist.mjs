#!/usr/bin/env node
// `npm run desktop:dist`: builds the Windows installer dist-desktop\HomeBase-Setup-<version>.exe.
//   1. the web export (apps/client/dist), without a baked-in hub address (the installed app gets the hub from
//      its own connection setting; a browser that opens the hub's page uses that address);
//   2. a staging folder (dist-desktop/stage) with the shell's files, the web export in ./web and the speech
//      engine's packages (production only; the ~280 MB speech model is NOT included: it is downloaded on the
//      first dictation into %LOCALAPPDATA%\HomeBase\models, or reused when it is already there);
//   3. electron-builder: an unsigned, per-user NSIS installer (no admin), Start menu entry and desktop shortcut.
// Flags: --skip-web (reuse apps/client/dist), --dir (unpacked app only, no installer).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appId, loadLocalEnv } from "./local-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
// HOMEBASE_APP_ID and HOMEBASE_PUBLISHER (from the environment or .env.local) brand the installer.
const APP_ID = appId();
const PUBLISHER = process.env.HOMEBASE_PUBLISHER?.trim() || "HomeBase contributors";
const desktop = join(root, "apps", "desktop");
const client = join(root, "apps", "client");
const out = join(root, "dist-desktop");
const stage = join(out, "stage");
const args = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: "inherit", shell: isWin, ...opts });

const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const rootLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const lockVersion = (name) => rootLock.packages?.[`node_modules/${name}`]?.version;

// 1. Web export
if (!args.has("--skip-web")) {
  console.log("[desktop:dist] building the web export (expo export -p web)…");
  const env = { ...process.env, NODE_ENV: "production" };
  delete env.EXPO_PUBLIC_HUB_URL;
  run("npx", ["expo", "export", "-p", "web"], { cwd: client, env });
}
if (!existsSync(join(client, "dist", "index.html"))) throw new Error("No web export in apps/client/dist (run without --skip-web)");

// 2. Staging folder
console.log("[desktop:dist] staging…");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const SHELL_FILES = ["main.mjs", "preload.cjs", "notifications.mjs", "notifyCore.mjs", "stt.mjs", "sttCore.mjs", "sttWorker.mjs", "connection.mjs", "tunnel.mjs", "hubConnection.mjs"];
for (const f of SHELL_FILES) cpSync(join(desktop, f), join(stage, f));
cpSync(join(client, "dist"), join(stage, "web"), { recursive: true });
// The exact versions the repo is tested with.
const deps = { "@huggingface/transformers": pkg.dependencies["@huggingface/transformers"] };
const overrides = Object.fromEntries(["sharp", "onnxruntime-node", "onnxruntime-web", "onnxruntime-common"].map((n) => [n, lockVersion(n)]).filter(([, v]) => v));
writeFileSync(join(stage, "package.json"), JSON.stringify({
  name: "homebase-desktop", productName: "HomeBase", version: pkg.version, private: true,
  description: "HomeBase: a command center for AI agents (desktop)", author: PUBLISHER,
  main: "main.mjs", dependencies: deps, overrides,
  // main.mjs reads this for the Windows AppUserModelId (it must match appId below for notifications).
  homebase: { appId: APP_ID },
}, null, 2));
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts=false"], { cwd: stage });

// 3. Installer
const config = {
  appId: APP_ID,
  productName: "HomeBase",
  copyright: PUBLISHER,
  directories: { app: stage, output: out, buildResources: join(desktop, "build") },
  electronVersion: JSON.parse(readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8")).version,
  electronDist: join(root, "node_modules", "electron", "dist"),
  // Plain files (no asar): the speech engine's native modules and the ES modules load as they do from source.
  asar: false,
  npmRebuild: false,
  nodeGypRebuild: false,
  files: [
    "**/*",
    // The web build of onnxruntime and other platforms' binaries are never loaded on Windows x64.
    "!node_modules/onnxruntime-web/**",
    "!node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
    "!node_modules/onnxruntime-node/bin/napi-v6/linux/**",
    "!node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/**",
    "!**/*.map",
  ],
  win: {
    target: [{ target: args.has("--dir") ? "dir" : "nsis", arch: ["x64"] }],
    icon: join(desktop, "build", "icon.ico"),
    // Unsigned on purpose (no certificate): Windows SmartScreen warns on first run ("More info" → "Run anyway").
    signAndEditExecutable: true,
  },
  nsis: {
    oneClick: true,
    perMachine: false, // %LOCALAPPDATA%\Programs\HomeBase, no admin
    allowElevation: false,
    createDesktopShortcut: "always",
    createStartMenuShortcut: true,
    shortcutName: "HomeBase",
    runAfterFinish: true,
    deleteAppDataOnUninstall: false, // the pairing and connection setting survive a reinstall
    installerIcon: join(desktop, "build", "icon.ico"),
    uninstallerIcon: join(desktop, "build", "icon.ico"),
    artifactName: "HomeBase-Setup-${version}.${ext}",
  },
};
const cfgFile = join(out, "electron-builder.json");
writeFileSync(cfgFile, JSON.stringify(config, null, 2));
console.log("[desktop:dist] electron-builder…");
run("npx", ["electron-builder", "--win", "--x64", "--config", cfgFile, "--publish", "never"], {
  cwd: root, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});
const exe = join(out, `HomeBase-Setup-${pkg.version}.exe`);
console.log(existsSync(exe) ? `[desktop:dist] done: ${exe}` : `[desktop:dist] done: ${join(out, "win-unpacked")}`);
