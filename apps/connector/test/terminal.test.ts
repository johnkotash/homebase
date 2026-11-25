import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalService, cleanEnv, defaultShell, loadPty, terminalEnabled, terminalGraceMs, type Pty, type SpawnPty } from "../src/terminal";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakePty() {
  const spawned: Array<{ file: string; args: string[]; cwd: string; cols: number; rows: number; env: Record<string, string>; pty: Pty & { emit(d: string): void; exit(c: number): void; written: string[]; size: number[]; killed: boolean } }> = [];
  const spawn: SpawnPty = (file, args, opts) => {
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const pty = {
      written: [] as string[], size: [opts.cols, opts.rows], killed: false,
      onData: (cb: (d: string) => void) => (onData = cb),
      onExit: (cb: (e: { exitCode: number }) => void) => (onExit = cb),
      write: (d: string) => void pty.written.push(d),
      resize: (c: number, r: number) => void (pty.size = [c, r]),
      kill: () => {
        pty.killed = true;
        onExit({ exitCode: 0 });
      },
      emit: (d: string) => onData(d),
      exit: (c: number) => onExit({ exitCode: c }),
    };
    spawned.push({ file, args, ...opts, pty });
    return pty;
  };
  return { spawn, spawned };
}

function setup(over: Partial<ConstructorParameters<typeof TerminalService>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), "hb-term-"));
  dirs.push(home);
  const fake = fakePty();
  const sent: any[] = [];
  const svc = new TerminalService({ home, enabled: true, root: false, spawn: fake.spawn, env: { SHELL: "/bin/zsh", HB_PAIR_CODE: "ABCD-EFGH", PATH: "/usr/bin" }, graceMs: 50, platform: "linux", ...over });
  svc.attach((f) => {
    sent.push(f);
    return true;
  });
  const of = (t: string) => sent.filter((f) => f.t === t);
  return { home, svc, sent, of, ...fake };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("the terminal service", () => {
  it("opens the user's shell in the asked folder (home by default) and passes keys, size and output through", async () => {
    const s = setup();
    s.svc.onFrame({ t: "pty.open", termId: "t1", cwd: null, cols: 100, rows: 30, deviceId: "dev_1" });
    expect(s.of("pty.opened")[0]).toMatchObject({ termId: "t1", ok: true, shell: "/bin/zsh", cwd: s.home });
    const sh = s.spawned[0];
    expect(sh).toMatchObject({ file: "/bin/zsh", args: ["-l"], cwd: s.home, cols: 100, rows: 30 });
    // The pairing code never reaches the shell; the shell knows it runs in a colour terminal.
    expect(sh.env.HB_PAIR_CODE).toBeUndefined();
    expect(sh.env).toMatchObject({ TERM: "xterm-256color", PATH: "/usr/bin" });
    s.svc.onFrame({ t: "pty.input", termId: "t1", data: "ls\r" });
    s.svc.onFrame({ t: "pty.resize", termId: "t1", cols: 50, rows: 10 });
    expect(sh.pty.written).toEqual(["ls\r"]);
    expect(sh.pty.size).toEqual([50, 10]);
    sh.pty.emit("a");
    sh.pty.emit("b");
    await tick();
    expect(s.of("pty.output")).toEqual([{ t: "pty.output", termId: "t1", data: "ab" }]);
    sh.pty.exit(3);
    expect(s.of("pty.exit").at(-1)).toEqual({ t: "pty.exit", termId: "t1", code: 3, reason: "exit" });
    expect(s.svc.count).toBe(0);
  });

  it("refuses a folder that does not exist, and refuses everything when off or running as root", () => {
    const s = setup();
    s.svc.onFrame({ t: "pty.open", termId: "t1", cwd: join(s.home, "nope"), cols: 80, rows: 24 });
    expect(s.of("pty.opened")[0]).toMatchObject({ ok: false, code: "not_found" });
    const off = setup({ enabled: false });
    off.svc.onFrame({ t: "pty.open", termId: "t2", cwd: null, cols: 80, rows: 24 });
    expect(off.of("pty.opened")[0]).toMatchObject({ ok: false, code: "disabled", error: expect.stringMatching(/HB_TERMINAL/) });
    const root = setup({ root: true });
    expect(root.svc.available).toBe(false);
    root.svc.onFrame({ t: "pty.open", termId: "t3", cwd: null, cols: 80, rows: 24 });
    expect(root.of("pty.opened")[0]).toMatchObject({ ok: false, error: expect.stringMatching(/root/) });
    expect(root.spawned).toHaveLength(0);
    const none = setup({ spawn: null });
    expect(none.svc.available).toBe(false);
  });

  it("keeps a shell through a short disconnect and replays what was missed", async () => {
    const s = setup({ graceMs: 1000 });
    s.svc.onFrame({ t: "pty.open", termId: "t1", cwd: null, cols: 80, rows: 24 });
    const sh = s.spawned[0];
    sh.pty.emit("before ");
    await tick();
    s.svc.onFrame({ t: "pty.detach", termId: "t1" });
    sh.pty.emit("during");
    await tick();
    expect(s.of("pty.output").map((f) => f.data)).toEqual(["before "]);
    s.svc.onFrame({ t: "pty.attach", termId: "t1", cols: 90, rows: 20 });
    expect(s.of("pty.opened").at(-1)).toMatchObject({ ok: true, reattached: true });
    expect(s.of("pty.output").at(-1)!.data).toBe("before during");
    expect(sh.pty.size).toEqual([90, 20]);
    expect(sh.pty.killed).toBe(false);
  });

  it("ends a shell nobody came back to after the grace time, and on close", async () => {
    const s = setup({ graceMs: 30 });
    s.svc.onFrame({ t: "pty.open", termId: "t1", cwd: null, cols: 80, rows: 24 });
    s.svc.onFrame({ t: "pty.detach", termId: "t1" });
    await tick(60);
    expect(s.spawned[0].pty.killed).toBe(true);
    s.svc.onFrame({ t: "pty.attach", termId: "t1", cols: 80, rows: 24 });
    expect(s.of("pty.opened").at(-1)).toMatchObject({ ok: false, code: "not_found" });
    s.svc.onFrame({ t: "pty.open", termId: "t2", cwd: null, cols: 80, rows: 24 });
    s.svc.onFrame({ t: "pty.close", termId: "t2" });
    expect(s.of("pty.exit").at(-1)).toMatchObject({ termId: "t2", reason: "closed" });
  });

  it("settings: HB_TERMINAL on by default, the grace time, and the shell", () => {
    expect(terminalEnabled({})).toBe(true);
    expect(terminalEnabled({ HB_TERMINAL: "0" })).toBe(false);
    expect(terminalGraceMs({})).toBe(15 * 60_000);
    expect(terminalGraceMs({ HB_TERMINAL_GRACE_MIN: "2" })).toBe(2 * 60_000);
    expect(terminalGraceMs({ HB_TERMINAL_GRACE_MIN: "x" })).toBe(15 * 60_000);
    expect(defaultShell({ SHELL: "/usr/bin/fish" }, "linux")).toEqual({ file: "/usr/bin/fish", args: ["-l"] });
    expect(defaultShell({}, "linux").file).toBe("/bin/bash");
    expect(defaultShell({}, "win32").file).toBe("powershell.exe");
    expect(defaultShell({ HB_TERMINAL_SHELL: "/bin/sh" }, "linux")).toEqual({ file: "/bin/sh", args: [] });
    expect(cleanEnv({ HB_PAIR_CODE: "x", A: "1" })).toMatchObject({ A: "1", TERM: "xterm-256color" });
  });
});

describe("node-pty on this platform", () => {
  // Proves the prebuilt PTY installs and runs from a clean `npm ci` (CI runs this on Linux).
  it("loads and runs a real command in a PTY", async () => {
    const spawn = loadPty();
    expect(spawn).toBeTypeOf("function");
    const win = process.platform === "win32";
    const pty = spawn!(win ? process.env.COMSPEC ?? "cmd.exe" : "/bin/sh", win ? ["/c", "echo pty-ok"] : ["-c", "echo pty-ok"], { cols: 80, rows: 24, cwd: tmpdir(), env: cleanEnv(process.env) });
    let out = "";
    pty.onData((d) => (out += d));
    const code = await new Promise<number>((res) => pty.onExit((e) => res(e.exitCode)));
    expect(code).toBe(0);
    expect(out).toContain("pty-ok");
    try {
      pty.kill();
    } catch {
      // already gone
    }
  });
});
