#!/usr/bin/env node
// Builds the Android development build, installs it on the running emulator/device and opens it.
//
// Why not plain `expo run:android`? On Windows, React Native's CMake/ninja step embeds the absolute
// node_modules path in object file names. Under a deep repo path those names pass 260 characters and
// ninja refuses them. Junctions and `subst` do not help because Node resolves both to the real path.
// So on Windows this script mirrors the files the native build needs to a short real directory
// (HB_BUILD_DIR, default C:\hb), runs Gradle there, and installs the resulting APK. JavaScript is
// still served by Metro from this repo, so the mirror is only a native build cache.
//
// Flags: --no-build (install + launch only), --no-launch, --no-metro, --direct (skip the mirror).
//
// --release builds a standalone APK instead: JS bundle embedded (no Metro), phone and emulator ABIs,
// signed with the debug keystore, written to dist-apk/HomeBase.apk. Nothing is installed unless
// --install is also given. --hub-url <url> bakes the pair screen's default server address in.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appId, loadLocalEnv } from "./local-env.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadLocalEnv(root);
const args = new Set(process.argv.slice(2));
const release = args.has("--release");
const variant = release ? "release" : "debug";
const hubUrlAt = process.argv.indexOf("--hub-url");
const hubUrl = hubUrlAt > 0 ? process.argv[hubUrlAt + 1] : process.env.EXPO_PUBLIC_HUB_URL;
const isWin = process.platform === "win32";
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (isWin ? join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk") : join(process.env.HOME ?? "", "Android", "Sdk"));
const adb = join(sdk, "platform-tools", isWin ? "adb.exe" : "adb");
const env = { ...process.env, ANDROID_HOME: sdk, ...(release ? { NODE_ENV: "production", ...(hubUrl ? { EXPO_PUBLIC_HUB_URL: hubUrl } : {}) } : {}) };
const PKG = appId(); // HOMEBASE_APP_ID (apps/client/app.config.js uses the same value)

function run(cmd, cmdArgs, opts = {}) {
  console.log(`> ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", env, shell: false, ...opts });
  return r.status ?? 1;
}
function must(status, what) {
  if (status !== 0) {
    console.error(`\n${what} failed (exit ${status}).`);
    process.exit(status);
  }
}
function robocopy(from, to, extra = []) {
  // robocopy exit codes below 8 mean success
  const r = spawnSync("robocopy", [from, to, "/MIR", "/MT:32", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1", ...extra], { stdio: "inherit" });
  if ((r.status ?? 16) >= 8) must(r.status ?? 16, `robocopy ${from}`);
}
const portOpen = (port) =>
  new Promise((res) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });

const needDevice = !release || args.has("--install");
const devices = needDevice ? spawnSync(adb, ["devices"], { encoding: "utf8" }).stdout ?? "" : "";
if (needDevice && !/\tdevice/.test(devices)) {
  console.error("No Android device or emulator is connected. Start one first:\n  emulator -avd Pixel_10_Pro");
  process.exit(1);
}

// Build only the ABI of the connected device (x86_64 on the emulator, arm64-v8a on phones).
// A release APK is for real phones (arm64-v8a) and is also checked on the emulator (x86_64).
const abi = release ? "arm64-v8a,x86_64" : (spawnSync(adb, ["shell", "getprop", "ro.product.cpu.abi"], { encoding: "utf8" }).stdout ?? "").trim() || "x86_64";
const clientDir = join(root, "apps", "client");
if (!existsSync(join(clientDir, "android"))) {
  must(run(process.execPath, [join(root, "node_modules", "expo", "bin", "cli"), "prebuild", "-p", "android", "--no-install"], { cwd: clientDir }), "expo prebuild");
}

let buildRoot = root;
if (!args.has("--no-build")) {
  const useMirror = isWin && !args.has("--direct") && root.length > 12;
  if (useMirror) {
    buildRoot = process.env.HB_BUILD_DIR || "C:\\hb";
    console.log(`Mirroring native build inputs to ${buildRoot} (Windows path-length workaround)...`);
    mkdirSync(buildRoot, { recursive: true });
    cpSync(join(root, "package.json"), join(buildRoot, "package.json"));
    // Workspace packages are junctions in node_modules; robocopy skips them (/XJ). The release bundle is
    // made inside the mirror, so re-create them there, pointing at the mirrored packages.
    const scope = join(buildRoot, "node_modules", "@homebase");
    for (const name of readdirSync(join(root, "packages"))) rmSync(join(scope, name), { recursive: true, force: true });
    robocopy(join(root, "node_modules"), join(buildRoot, "node_modules"), ["/XJ", "/XD", ".cache"]);
    robocopy(join(root, "packages"), join(buildRoot, "packages"));
    mkdirSync(scope, { recursive: true });
    for (const name of readdirSync(join(root, "packages"))) {
      const pkg = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8")).name ?? "";
      if (pkg.startsWith("@homebase/")) symlinkSync(join(buildRoot, "packages", name), join(scope, pkg.slice(10)), "junction");
    }
    robocopy(clientDir, join(buildRoot, "apps", "client"), ["/XD", "build", ".gradle", ".cxx", ".expo", "dist", "node_modules"]);
  }
  const androidDir = join(buildRoot, "apps", "client", "android");
  const gradle = isWin ? "gradlew.bat" : "./gradlew";
  must(
    run(isWin ? "cmd" : gradle, [...(isWin ? ["/c", join(androidDir, gradle)] : []), release ? "app:assembleRelease" : "app:assembleDebug", `-PreactNativeArchitectures=${abi}`, "--console=plain"], {
      cwd: androidDir, env: { ...env, HB_CXX_DIR: process.env.HB_CXX_DIR || (useMirror ? join(buildRoot, "x").replace(/\\/g, "/") : "off") },
    }),
    "Gradle build",
  );
  if (useMirror) {
    const out = join(clientDir, "android", "app", "build", "outputs", "apk", variant);
    mkdirSync(out, { recursive: true });
    cpSync(join(androidDir, "app", "build", "outputs", "apk", variant, `app-${variant}.apk`), join(out, `app-${variant}.apk`));
  }
}

let apk = join(clientDir, "android", "app", "build", "outputs", "apk", variant, `app-${variant}.apk`);
if (release && existsSync(apk)) {
  const dist = join(root, "dist-apk");
  mkdirSync(dist, { recursive: true });
  cpSync(apk, join(dist, "HomeBase.apk"));
  apk = join(dist, "HomeBase.apk");
  console.log(`\nStandalone APK: ${apk}${hubUrl ? `  (default hub ${hubUrl})` : ""}`);
  if (!args.has("--install")) process.exit(0);
}
if (!existsSync(apk)) {
  console.error(`No APK at ${apk}. Run without --no-build first.`);
  process.exit(1);
}
if (run(adb, ["install", "-r", apk]) !== 0) {
  // Most often INSTALL_FAILED_INSUFFICIENT_STORAGE on an emulator whose /data is nearly full.
  const installed = (spawnSync(adb, ["shell", "pm", "path", PKG], { encoding: "utf8" }).stdout ?? "").includes("package:");
  if (!installed) must(1, "adb install");
  console.warn("WARNING: the new APK could not be installed (see the adb error above; free some space on the device).");
  console.warn("Launching the build that is already installed. Native changes since that build are NOT on the device.");
}
if (release) {
  if (!args.has("--no-launch")) run(adb, ["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"]);
  process.exit(0);
}
run(adb, ["reverse", "tcp:8081", "tcp:8081"]);

if (!args.has("--no-metro") && !(await portOpen(8081))) {
  console.log("Starting Metro (expo start --dev-client) in the background...");
  const child = spawn(process.execPath, [join(root, "node_modules", "expo", "bin", "cli"), "start", "--dev-client", "--port", "8081"], {
    cwd: clientDir, env: { ...env, CI: "1" }, stdio: "ignore", detached: true,
  });
  child.unref();
  for (let i = 0; i < 60 && !(await portOpen(8081)); i++) await new Promise((r) => setTimeout(r, 500));
}

if (!args.has("--no-launch")) {
  const url = `homebase://expo-development-client/?url=${encodeURIComponent("http://localhost:8081")}`;
  must(run(adb, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `"${url}"`, PKG]), "launch");
  console.log("\nHomeBase is opening on the device. Pair it against http://10.0.2.2:8787 with a code from the hub.");
}
