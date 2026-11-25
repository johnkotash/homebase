import { describe, expect, it } from "vitest";
import { FILES_CAPABILITY, TERMINAL_CAPABILITY } from "@homebase/protocol";
import { MAX_TERMINALS_PER_DEVICE } from "../src/hub/files";
import { connectConnector, connectDevice, makeHub, pairDevice, peer } from "./helpers";

const HOST = [FILES_CAPABILITY, TERMINAL_CAPABILITY];

function setup(capabilities = HOST) {
  const ctx = makeHub();
  const device = connectDevice(ctx.hub, ctx.directory);
  const con = connectConnector(ctx.hub, ctx.directory, [
    { key: "claude", name: "Claude agent", kind: "claude" as const, capabilities } as any,
    { key: "old", name: "Old agent", kind: "mock" as const },
  ]);
  const idOf = (key: string) => ctx.store.get<{ id: string }>("SELECT id FROM agents WHERE key = ?", key)!.id;
  const agentId = idOf("claude");
  const audit = (action: string) => ctx.store.all<{ detail: string; actor_id: string }>("SELECT detail, actor_id FROM audit_log WHERE action = ? ORDER BY at", action)
    .map((r) => ({ ...JSON.parse(r.detail), by: r.actor_id }));
  const weakDevice = () => {
    const d = pairDevice(ctx.directory);
    const p = peer(d.deviceId, "device", false);
    ctx.hub.attachDevice(p, {});
    return p;
  };
  return { ...ctx, device, con, agentId, idOf, audit, weakDevice };
}

describe("the file relay", () => {
  it("relays a request to the agent's connector and the answer to the asking device only", () => {
    const s = setup();
    const other = connectDevice(s.hub, s.directory);
    s.hub.onFrame(s.device, { t: "files.req", id: "r1", agentId: s.agentId, op: "list", args: { path: "/home/me" } });
    const req = s.con.of("files.request").at(-1);
    expect(req).toMatchObject({ op: "list", args: { path: "/home/me" }, deviceId: s.device.id });
    s.hub.onFrame(s.con, { t: "files.response", id: req.id, ok: true, result: { entries: [] } });
    expect(s.device.of("files.res").at(-1)).toEqual({ t: "files.res", id: "r1", ok: true, result: { entries: [] } });
    expect(other.of("files.res")).toHaveLength(0);
    // Reading is not audited.
    expect(s.audit("files.list")).toHaveLength(0);
  });

  it("audits writes, creates, renames and deletes with the path and device, never the contents", () => {
    const s = setup();
    const ask = (id: string, op: any, args: Record<string, unknown>, result: unknown) => {
      s.hub.onFrame(s.device, { t: "files.req", id, agentId: s.agentId, op, args });
      s.hub.onFrame(s.con, { t: "files.response", id: s.con.of("files.request").at(-1).id, ok: true, result });
    };
    ask("w", "write", { path: "/home/me/a.py", content: "SECRET CONTENT", baseHash: null }, { path: "/home/me/a.py", size: 14, hash: "h" });
    ask("c", "create", { path: "/home/me/d", kind: "dir" }, { path: "/home/me/d", kind: "dir" });
    ask("r", "rename", { from: "/home/me/a.py", to: "/home/me/b.py" }, { path: "/home/me/b.py", from: "/home/me/a.py", to: "/home/me/b.py" });
    ask("d", "delete", { path: "/home/me/b.py" }, { path: "/home/me/b.py" });
    expect(s.audit("files.write")).toEqual([{ connectorId: s.con.id, path: "/home/me/a.py", size: 14, by: s.device.id }]);
    expect(s.audit("files.create")).toEqual([{ connectorId: s.con.id, path: "/home/me/d", kind: "dir", by: s.device.id }]);
    expect(s.audit("files.rename")).toEqual([{ connectorId: s.con.id, path: "/home/me/b.py", from: "/home/me/a.py", to: "/home/me/b.py", by: s.device.id }]);
    expect(s.audit("files.delete")).toEqual([{ connectorId: s.con.id, path: "/home/me/b.py", by: s.device.id }]);
    const all = s.store.all<{ detail: string }>("SELECT detail FROM audit_log").map((r) => r.detail).join("\n");
    expect(all).not.toContain("SECRET CONTENT");
  });

  it("does not audit a refused write and passes the connector's refusal on (a conflict, say)", () => {
    const s = setup();
    s.hub.onFrame(s.device, { t: "files.req", id: "w", agentId: s.agentId, op: "write", args: { path: "/x", content: "y" } });
    s.hub.onFrame(s.con, { t: "files.response", id: s.con.of("files.request").at(-1).id, ok: false, error: "x changed on disk since you opened it.", code: "conflict" });
    expect(s.device.of("files.res").at(-1)).toMatchObject({ id: "w", ok: false, error: { code: "conflict" } });
    expect(s.audit("files.write")).toHaveLength(0);
  });

  it("is for devices that may approve only, and for agents whose connector offers it", () => {
    const s = setup();
    const weak = s.weakDevice();
    s.hub.onFrame(weak, { t: "files.req", id: "a", agentId: s.agentId, op: "list", args: {} });
    expect(weak.of("files.res").at(-1)).toMatchObject({ id: "a", ok: false, error: { code: "forbidden" } });
    s.hub.onFrame(s.device, { t: "files.req", id: "b", agentId: s.idOf("old"), op: "list", args: {} });
    expect(s.device.of("files.res").at(-1)).toMatchObject({ id: "b", ok: false, error: { code: "unsupported" } });
    expect(s.con.of("files.request")).toHaveLength(0);
  });

  it("ignores answers from a connector that was not asked, and fails pending requests when the connector goes", () => {
    const s = setup();
    s.hub.onFrame(s.device, { t: "files.req", id: "a", agentId: s.agentId, op: "read", args: { path: "/x" } });
    const req = s.con.of("files.request").at(-1);
    const c2 = pairDevice(s.directory, "connector", "other");
    const stranger = peer(c2.deviceId, "connector", false);
    s.hub.attachConnector(stranger);
    s.hub.onFrame(stranger, { t: "files.response", id: req.id, ok: true, result: { content: "planted" } });
    expect(s.device.of("files.res")).toHaveLength(0);
    s.hub.detach(s.con);
    expect(s.device.of("files.res").at(-1)).toMatchObject({ id: "a", ok: false, error: { code: "offline" } });
    s.hub.onFrame(s.device, { t: "files.req", id: "b", agentId: s.agentId, op: "list", args: {} });
    expect(s.device.of("files.res").at(-1)).toMatchObject({ id: "b", error: { code: "offline" } });
  });
});

describe("the terminal relay", () => {
  function open(s: ReturnType<typeof setup>, id = "o1") {
    s.hub.onFrame(s.device, { t: "term.open", id, agentId: s.agentId, cwd: "/home/me/proj", cols: 80, rows: 24 });
    const req = s.con.of("pty.open").at(-1);
    s.hub.onFrame(s.con, { t: "pty.opened", termId: req.termId, ok: true, shell: "/bin/bash", cwd: "/home/me/proj" });
    return req.termId as string;
  }

  it("opens a shell on the connector, passes keys and output through, and audits open and close without keystrokes", () => {
    const s = setup();
    const termId = open(s);
    expect(s.con.of("pty.open").at(-1)).toMatchObject({ cwd: "/home/me/proj", cols: 80, rows: 24, deviceId: s.device.id });
    expect(s.device.of("term.opened").at(-1)).toMatchObject({ id: "o1", ok: true, termId, shell: "/bin/bash" });
    s.hub.onFrame(s.device, { t: "term.input", termId, data: "echo hunter2\r" });
    s.hub.onFrame(s.device, { t: "term.resize", termId, cols: 120, rows: 40 });
    expect(s.con.of("pty.input").at(-1)).toEqual({ t: "pty.input", termId, data: "echo hunter2\r" });
    expect(s.con.of("pty.resize").at(-1)).toMatchObject({ cols: 120, rows: 40 });
    s.hub.onFrame(s.con, { t: "pty.output", termId, data: "hunter2\r\n" });
    expect(s.device.of("term.output").at(-1)).toEqual({ t: "term.output", termId, data: "hunter2\r\n" });
    s.hub.onFrame(s.device, { t: "term.close", termId });
    expect(s.con.of("pty.close")).toHaveLength(1);
    s.hub.onFrame(s.con, { t: "pty.exit", termId, code: 0, reason: "closed" });
    expect(s.device.of("term.exit").at(-1)).toMatchObject({ termId, code: 0 });
    expect(s.audit("terminal.open")).toEqual([{ connectorId: s.con.id, termId, cwd: "/home/me/proj", shell: "/bin/bash", by: s.device.id }]);
    expect(s.audit("terminal.close")).toEqual([{ connectorId: s.con.id, termId, code: 0, reason: "closed", by: s.device.id }]);
    expect(s.store.all<{ detail: string }>("SELECT detail FROM audit_log").map((r) => r.detail).join()).not.toContain("hunter2");
    expect(s.hub.terminals.size).toBe(0);
  });

  it("refuses devices that may not approve, agents without the terminal, and too many at once", () => {
    const s = setup([FILES_CAPABILITY]);
    s.hub.onFrame(s.device, { t: "term.open", id: "x", agentId: s.agentId, cols: 80, rows: 24 });
    expect(s.device.of("term.opened").at(-1)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    const t = setup();
    const weak = t.weakDevice();
    t.hub.onFrame(weak, { t: "term.open", id: "y", agentId: t.agentId, cols: 80, rows: 24 });
    expect(weak.of("term.opened").at(-1)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    for (let i = 0; i < MAX_TERMINALS_PER_DEVICE; i++) open(t, `o${i}`);
    t.hub.onFrame(t.device, { t: "term.open", id: "z", agentId: t.agentId, cols: 80, rows: 24 });
    expect(t.device.of("term.opened").at(-1)).toMatchObject({ id: "z", ok: false, error: { code: "too_many" } });
    expect(t.con.of("pty.open")).toHaveLength(MAX_TERMINALS_PER_DEVICE);
  });

  it("does not let another device type into, resize, close or take up someone else's terminal", () => {
    const s = setup();
    const termId = open(s);
    const other = connectDevice(s.hub, s.directory);
    s.hub.onFrame(other, { t: "term.input", termId, data: "rm -rf ~\r" });
    s.hub.onFrame(other, { t: "term.close", termId });
    s.hub.onFrame(other, { t: "term.attach", id: "a", termId, cols: 80, rows: 24 });
    expect(s.con.of("pty.input")).toHaveLength(0);
    expect(s.con.of("pty.close")).toHaveLength(0);
    expect(s.con.of("pty.attach")).toHaveLength(0);
    expect(other.of("term.opened").at(-1)).toMatchObject({ ok: false, error: { code: "not_found" } });
    s.hub.onFrame(s.con, { t: "pty.output", termId, data: "secret" });
    expect(other.of("term.output")).toHaveLength(0);
  });

  it("keeps the shell when the device drops and lets the same device take it up again", () => {
    const s = setup();
    const termId = open(s);
    s.hub.detach(s.device);
    expect(s.con.of("pty.detach").at(-1)).toEqual({ t: "pty.detach", termId });
    // Output while away goes nowhere (the connector keeps it).
    s.hub.onFrame(s.con, { t: "pty.output", termId, data: "lost" });
    const again = peer(s.device.id);
    s.hub.attachDevice(again, {});
    s.hub.onFrame(again, { t: "term.attach", id: "re", termId, cols: 100, rows: 30 });
    expect(s.con.of("pty.attach").at(-1)).toMatchObject({ termId, cols: 100, rows: 30 });
    s.hub.onFrame(s.con, { t: "pty.opened", termId, ok: true, reattached: true });
    s.hub.onFrame(s.con, { t: "pty.output", termId, data: "replay" });
    expect(again.of("term.opened").at(-1)).toMatchObject({ id: "re", ok: true, reattached: true });
    expect(again.of("term.output").at(-1)).toMatchObject({ data: "replay" });
    // Only one open is audited.
    expect(s.audit("terminal.open")).toHaveLength(1);
  });

  it("ends every terminal of a connector that goes offline", () => {
    const s = setup();
    const termId = open(s);
    s.hub.detach(s.con);
    expect(s.device.of("term.exit").at(-1)).toMatchObject({ termId, reason: "offline" });
    expect(s.audit("terminal.close")).toHaveLength(1);
    expect(s.hub.terminals.size).toBe(0);
  });

  it("passes a failed start on and forgets the terminal", () => {
    const s = setup();
    s.hub.onFrame(s.device, { t: "term.open", id: "f", agentId: s.agentId, cwd: "/nope", cols: 80, rows: 24 });
    const req = s.con.of("pty.open").at(-1);
    s.hub.onFrame(s.con, { t: "pty.opened", termId: req.termId, ok: false, error: "There is no folder /nope on this machine.", code: "not_found" });
    expect(s.device.of("term.opened").at(-1)).toMatchObject({ id: "f", ok: false, error: { code: "not_found" } });
    expect(s.hub.terminals.size).toBe(0);
    expect(s.audit("terminal.open")).toHaveLength(0);
  });
});
