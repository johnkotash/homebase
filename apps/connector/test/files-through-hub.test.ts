import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FILES_CAPABILITY, TERMINAL_CAPABILITY, type FileListing, type FileRead } from "@homebase/protocol";
import type { TermEvent } from "@homebase/sync-client";
import type { HubApp } from "../../server/src/app";
import { createMockAdapter } from "../src/adapters/mock";
import { FileService } from "../src/files";
import { HubLink } from "../src/HubLink";
import { TerminalService, type Pty, type SpawnPty } from "../src/terminal";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

let app: HubApp | null = null;
const stops: Array<() => void> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) s();
  await app?.close();
  app = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A shell that echoes what it is sent, so the test sees keys go one way and output the other. */
const echoPty: SpawnPty = () => {
  let out: (d: string) => void = () => {};
  let exit: (e: { exitCode: number }) => void = () => {};
  const p: Pty = {
    onData: (cb) => (out = cb), onExit: (cb) => (exit = cb),
    write: (d) => setTimeout(() => out(`echo:${d}`), 1), resize: () => {}, kill: () => setTimeout(() => exit({ exitCode: 0 }), 1),
  };
  return p;
};

async function setup() {
  app = await bootHub();
  const home = mkdtempSync(join(tmpdir(), "hb-e2e-files-"));
  dirs.push(home);
  mkdirSync(join(home, "proj"));
  writeFileSync(join(home, "proj", "main.py"), "print(1)\n");
  const files = new FileService({ home, enabled: true, root: false });
  const terminal = new TerminalService({ home, enabled: true, root: false, spawn: echoPty, graceMs: 5000 });
  const { token } = pairToken(app, "connector", "test-connector");
  const link = new HubLink({
    hubUrl: app.url, token, name: "test-connector", log: () => {},
    agents: [{ key: "dev", name: "Dev agent", kind: "mock", description: "", capabilities: [], workspaces: [], adapter: createMockAdapter({ speed: 0.01 }) }],
    hostCapabilities: [FILES_CAPABILITY, TERMINAL_CAPABILITY],
    onFilesRequest: (op, args) => files.handle(op, args),
    onTerminal: (f) => terminal.onFrame(f),
    onDisconnect: () => terminal.closeAll(),
  });
  terminal.attach((f) => link.sendTerminal(f));
  link.start();
  stops.push(() => link.stop());
  await link.whenReady();
  const phone = await connectDevice(app, "Phone");
  stops.push(() => phone.client.stop());
  const agent = await waitFor(() => phone.list("agents").find((a) => a.key === "dev" && a.capabilities.includes(FILES_CAPABILITY)), "agent with files");
  return { home, phone, agentId: agent.id as string, terminal };
}

describe("files and the terminal, device to connector through the hub", () => {
  it("lists, opens and saves a file, and refuses a save over a newer version on disk", async () => {
    const s = await setup();
    const c = s.phone.client;
    const l = await c.files<FileListing>(s.agentId, "list", { path: join(s.home, "proj") });
    expect(l.entries.map((e) => e.name)).toEqual(["main.py"]);
    const r = await c.files<FileRead>(s.agentId, "read", { path: join(s.home, "proj", "main.py") });
    expect(r.content).toBe("print(1)\n");
    await c.files(s.agentId, "write", { path: r.path, content: "print(2)\n", baseHash: r.hash });
    expect(readFileSync(r.path, "utf8")).toBe("print(2)\n");
    // Saving again from the old version: the file changed since (by us, or by an agent).
    await expect(c.files(s.agentId, "write", { path: r.path, content: "print(3)\n", baseHash: r.hash })).rejects.toMatchObject({ code: "conflict" });
    expect(readFileSync(r.path, "utf8")).toBe("print(2)\n");
    const audit = app!.hub.store.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'files.%'");
    expect(audit.map((a) => a.action)).toEqual(["files.write"]);
  });

  it("runs a terminal, and takes it up again after the device's connection drops", async () => {
    const s = await setup();
    const c = s.phone.client;
    const events: TermEvent[] = [];
    const t = await c.termOpen(s.agentId, join(s.home, "proj"), { cols: 80, rows: 24 }, (e) => events.push(e));
    expect(t.cwd).toBe(join(s.home, "proj"));
    c.termInput(t.termId, "ls\r");
    await waitFor(() => events.some((e) => e.type === "output" && e.data.includes("echo:ls")), "echoed output");

    // A network blip: the socket closes, the client reconnects by itself and takes the terminal up again.
    (c as any).ws.close();
    await waitFor(() => events.some((e) => e.type === "reattached"), "reattached", 5000);
    await waitFor(() => events.filter((e) => e.type === "output" && e.data.includes("echo:ls")).length >= 2, "replayed output");
    c.termInput(t.termId, "pwd\r");
    await waitFor(() => events.some((e) => e.type === "output" && e.data.includes("echo:pwd")), "input after reattach");

    c.termClose(t.termId);
    await waitFor(() => events.some((e) => e.type === "exit"), "exit");
    expect(s.terminal.count).toBe(0);
    const audit = app!.hub.store.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'terminal.%' ORDER BY at");
    expect(audit.map((a) => a.action)).toEqual(["terminal.open", "terminal.close"]);
  });
});
