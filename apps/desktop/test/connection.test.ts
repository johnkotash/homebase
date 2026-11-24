import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-ignore plain ESM, shared with the Electron main process
import { DEFAULT_CONFIG, classifySshFailure, describeTarget, loadConnectionConfig, normalizeHubUrl, saveConnectionConfig, sshArgs, validateConfig } from "../connection.mjs";
// @ts-ignore plain ESM, shared with the Electron main process
import { findSshBinary } from "../connection.mjs";

describe("desktop connection settings", () => {
  it("defaults to an SSH tunnel to homebase-server's hub on 8787", () => {
    expect(DEFAULT_CONFIG).toMatchObject({ mode: "ssh", sshHost: "homebase-server", remotePort: 8787 });
    const v = validateConfig({});
    expect(v.ok && v.config).toMatchObject({ mode: "ssh", sshHost: "homebase-server", remotePort: 8787, localPort: 18787, directUrl: "" });
  });

  it("accepts host aliases and user@host, refuses anything ssh would read as an option or a second argument", () => {
    for (const h of ["homebase-server", "user@homebase-server", "my-server.example.ts.net", "192.168.1.20", "u_1@host-2"]) expect(validateConfig({ sshHost: h }).ok, h).toBe(true);
    for (const h of ["-oProxyCommand=calc", "homebase-server -L 1:2:3", "a b", "host;rm", "@host", "-", "homebase-server\n"]) {
      const v = validateConfig({ mode: "ssh", sshHost: h });
      // a trailing newline is trimmed, which is fine; everything else must be refused
      if (h === "homebase-server\n") expect(v.ok).toBe(true);
      else expect(v.ok, h).toBe(false);
    }
  });

  it("checks ports", () => {
    expect(validateConfig({ remotePort: "8787" }).ok).toBe(true);
    expect(validateConfig({ remotePort: 0 }).ok).toBe(false);
    expect(validateConfig({ remotePort: 70000 }).ok).toBe(false);
    expect(validateConfig({ localPort: 80 }).ok).toBe(false);
  });

  it("direct mode needs an http(s) hub address without a path", () => {
    const ok = validateConfig({ mode: "direct", directUrl: "http://100.101.102.103:8787/" });
    expect(ok.ok && ok.config.directUrl).toBe("http://100.101.102.103:8787");
    expect(validateConfig({ mode: "direct", directUrl: "https://my-server.example.ts.net" }).ok).toBe(true);
    for (const u of ["", "100.101.102.103:8787", "ftp://x", "http://x/v1/health", "http://user:pw@x:8787", "http://x?a=1"]) {
      const v = validateConfig({ mode: "direct", directUrl: u });
      expect(v.ok, u).toBe(false);
      if (!v.ok) expect(v.errors.directUrl, u).toBeTruthy();
    }
    expect(normalizeHubUrl("HTTP://Homebase-server:8787").ok).toBe(true);
    expect(validateConfig({ mode: "telnet" }).ok).toBe(false);
  });

  it("keeps a valid direct address while in SSH mode, drops a broken one", () => {
    const a = validateConfig({ mode: "ssh", directUrl: "http://100.101.102.103:8787" });
    expect(a.ok && a.config.directUrl).toBe("http://100.101.102.103:8787");
    const b = validateConfig({ mode: "ssh", directUrl: "junk" });
    expect(b.ok && b.config.directUrl).toBe("");
  });

  it("saves and loads; no file is the first run; a broken file falls back to the defaults without locking the user out", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-conn-"));
    const file = join(dir, "connection.json");
    try {
      expect(loadConnectionConfig(file, fs)).toMatchObject({ configured: false, config: { mode: "ssh", sshHost: "homebase-server" } });
      const v = validateConfig({ mode: "direct", directUrl: "http://100.101.102.103:8787" });
      if (!v.ok) throw new Error("invalid");
      saveConnectionConfig(file, v.config, fs, dir);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, mode: "direct" });
      expect(loadConnectionConfig(file, fs)).toMatchObject({ configured: true, config: { mode: "direct", directUrl: "http://100.101.102.103:8787" } });
      writeFileSync(file, "{not json");
      const broken = loadConnectionConfig(file, fs);
      expect(broken).toMatchObject({ configured: true, config: { mode: "ssh", sshHost: "homebase-server" } });
      expect(broken.warning).toMatch(/could not be read/);
      writeFileSync(file, JSON.stringify({ mode: "ssh", sshHost: "-oProxyCommand=x" }));
      expect(loadConnectionConfig(file, fs)).toMatchObject({ configured: true, config: { sshHost: "homebase-server" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds the ssh command line: batch mode, forward on loopback only, exit if the port is taken, keep-alives", () => {
    const args = sshArgs({ ...DEFAULT_CONFIG }, 18787);
    expect(args).toEqual([
      "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
      "-o", "ConnectTimeout=15", "-L", "127.0.0.1:18787:127.0.0.1:8787", "homebase-server",
    ]);
    expect(args.join(" ")).not.toMatch(/password|StrictHostKeyChecking=no/i);
    expect(describeTarget(DEFAULT_CONFIG)).toBe("homebase-server (SSH)");
  });

  it("prefers Windows' own OpenSSH, honours HB_SSH", () => {
    expect(findSshBinary({ SystemRoot: "C:\\Windows" }, "win32", () => true)).toBe(join("C:\\Windows", "System32", "OpenSSH", "ssh.exe"));
    expect(findSshBinary({ SystemRoot: "C:\\Windows" }, "win32", () => false)).toBe("ssh.exe");
    expect(findSshBinary({ HB_SSH: "C:\\tools\\ssh.exe" }, "win32", () => true)).toBe("C:\\tools\\ssh.exe");
    expect(findSshBinary({}, "linux", () => false)).toBe("ssh");
  });
});

describe("ssh failures, in words", () => {
  const c = (stderr: string, extra: object = {}) => classifySshFailure({ stderr, exitCode: 255, host: "homebase-server", ...extra });

  it("no ssh on the PC: stop and say how to install it", () => {
    const e = classifySshFailure({ spawnError: Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" }) });
    expect(e).toMatchObject({ code: "ssh_missing", retry: false });
    expect(e.message).toMatch(/OpenSSH Client/);
  });

  it("key refused or needs a passphrase: stop, never ask for a password", () => {
    for (const s of ["user@192.168.1.20: Permission denied (publickey).", "Enter passphrase for key '/c/Users/x/.ssh/id': ", "Too many authentication failures"]) {
      const e = c(s);
      expect(e.code, s).toBe("auth");
      expect(e.retry).toBe(false);
      expect(e.message).toMatch(/never asks for a password/);
    }
  });

  it("unknown or changed host key: stop and say to accept it once", () => {
    expect(c("Host key verification failed.")).toMatchObject({ code: "host_key", retry: false });
    expect(c("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@")).toMatchObject({ code: "host_key" });
  });

  it("network trouble: try again", () => {
    for (const s of [
      "ssh: connect to host 192.168.1.20 port 22: Connection timed out",
      "ssh: connect to host 192.168.1.20 port 22: Connection refused",
      "ssh: Could not resolve hostname homebase-server: No such host is known.",
      "Timeout, server 192.168.1.20 not responding.",
      "kex_exchange_identification: read: Connection reset",
    ]) {
      const e = c(s);
      expect(e.code, s).toBe("unreachable");
      expect(e.retry, s).toBe(true);
    }
  });

  it("local port taken: try again (with another port)", () => {
    expect(c("bind [127.0.0.1]:18787: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 18787\nCould not request local forwarding."))
      .toMatchObject({ code: "port_in_use", retry: true });
  });

  it("anything else: try again, and keep the last lines for the window", () => {
    const e = c("line 1\nline 2\nsomething odd\n");
    expect(e).toMatchObject({ code: "ssh_exited", retry: true, detail: "line 1\nline 2\nsomething odd" });
    expect(e.message).toMatch(/exit 255/);
  });
});
