import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_CAPABILITY, ATTACHMENT_MAX_BYTES, newId, type Message, type MessageAttachment, type Thread } from "@homebase/protocol";
import { openStore } from "../src/app";
import { ORPHAN_MAX_AGE_MS, sweepOrphanAttachments } from "../src/attachments";
import { createHttpApp } from "../src/http";
import { NodeSqlStore } from "../src/hub/SqlStore";
import { readEntity } from "../src/hub/tables";
import { assertValid, connectConnector, connectDevice, makeHub, mid, pairDevice } from "./helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 3, ...Array(9).fill(0), 0xff, 0xd9]);
const CLAUDE = { key: "claude", name: "Claude agent", kind: "claude" as const, capabilities: ["code", ATTACHMENT_CAPABILITY], workspaces: [{ label: "sandbox", cwd: "/srv/sandbox" }] };
const MOCK = { key: "dev", name: "Dev agent", kind: "mock" as const, capabilities: ["code"] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const ctx = makeHub();
  const { hub, directory, store } = ctx;
  const dir = mkdtempSync(join(tmpdir(), "hb-att-test-"));
  dirs.push(dir);
  const app = createHttpApp(hub, directory, { attachmentsDir: dir });
  const device = pairDevice(directory, "device", "Desktop");
  const phone = connectDevice(hub, directory);
  const con = connectConnector(hub, directory, [CLAUDE, MOCK] as any);
  const idOf = (key: string) => store.get<{ id: string }>("SELECT id FROM agents WHERE key = ? AND connector_id IS NOT NULL", key)!.id;
  const put = (id: string, body: Uint8Array | string, opts: { token?: string | null; mime?: string; name?: string } = {}) =>
    app.request(`/v1/attachments/${id}`, {
      method: "PUT",
      headers: {
        ...(opts.token === null ? {} : { Authorization: `Bearer ${opts.token ?? device.token}` }), "Content-Type": opts.mime ?? "image/png",
        ...(opts.name ? { "X-File-Name": encodeURIComponent(opts.name) } : {}),
      },
      body: typeof body === "string" ? body : new Uint8Array(body),
    });
  const get = (id: string, token: string | null) => app.request(`/v1/attachments/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const upload = async (body: Uint8Array = PNG, name?: string) => {
    const id = newId("att");
    const res = await put(id, body, { name });
    expect(res.status).toBe(200);
    return ((await res.json()) as { attachment: MessageAttachment }).attachment;
  };
  const send = (threadId: string, text: string, attachments?: MessageAttachment[]) =>
    hub.mutate({ id: phone.id, canApprove: true }, mid(), "message.send", { threadId, messageId: newId("msg"), text, source: "text", ...(attachments ? { attachments } : {}) });
  const newThread = (agentKey: string | null = "claude") => {
    const threadId = newId("thr");
    const r = hub.mutate({ id: phone.id, canApprove: true }, mid(), "thread.create", { threadId, title: "New session", agentId: agentKey ? idOf(agentKey) : null });
    expect(r.ok).toBe(true);
    return threadId;
  };
  const messages = (threadId: string) =>
    store.all<{ id: string }>("SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id", threadId).map((r) => readEntity<Message>(store, "messages", r.id)!);
  return { ...ctx, app, dir, device, phone, con, put, get, upload, send, newThread, messages, idOf };
}

describe("uploading a picture", () => {
  it("a paired device uploads once; the hub keeps the file under its id and says what it really is", async () => {
    const s = setup();
    const a = await s.upload(JPEG, "Screenshot 2026-11-23.png");
    // The bytes are a JPEG whatever the device called them: the hub reads the type and size from the file.
    expect(a).toMatchObject({ kind: "image", mime: "image/jpeg", bytes: JPEG.length, width: 1920, height: 1080, name: "Screenshot 2026-11-23.png" });
    expect(existsSync(join(s.dir, a.id))).toBe(true);
    expect(s.store.get<any>("SELECT message_id FROM attachments WHERE id = ?", a.id).message_id).toBeNull();
  });

  it("needs a device token, an attachment id and a real image under the size limit", async () => {
    const s = setup();
    expect((await s.put(newId("att"), PNG, { token: null })).status).toBe(401);
    expect((await s.put(newId("att"), PNG, { token: "nope-not-a-token" })).status).toBe(401);
    expect((await s.put(newId("art"), PNG)).status).toBe(400);
    expect((await s.put("att_..%2F..%2Fsecrets", PNG)).status).toBe(400);
    const fake = await s.put(newId("att"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", { mime: "image/png" });
    expect(fake.status).toBe(400);
    expect(((await fake.json()) as any).error.code).toBe("unsupported_type");
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    big.set(PNG);
    expect((await s.put(newId("att"), big)).status).toBe(413);
    expect(readdirSync(s.dir)).toEqual([]);
  });

  it("a retry with the same bytes is fine; other bytes under a known id are refused", async () => {
    const s = setup();
    const id = newId("att");
    expect((await s.put(id, PNG)).status).toBe(200);
    expect((await s.put(id, PNG)).status).toBe(200);
    expect((await s.put(id, JPEG)).status).toBe(409);
  });

  it("devices and the connector read it back with their own token; nobody else does", async () => {
    const s = setup();
    const a = await s.upload();
    const asDevice = await s.get(a.id, s.device.token);
    expect(asDevice.status).toBe(200);
    expect(asDevice.headers.get("content-type")).toBe("image/png");
    expect(asDevice.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await asDevice.arrayBuffer())).toEqual(PNG);
    const c = pairDevice(s.directory, "connector", "second-connector");
    expect((await s.get(a.id, c.token)).status).toBe(200);
    expect((await s.get(a.id, null)).status).toBe(401);
    expect((await s.get(newId("att"), s.device.token)).status).toBe(404);
  });
});

describe("sending a message with pictures", () => {
  it("the message carries the hub's facts (not the bytes), and the run gets them", async () => {
    const s = setup();
    const t = s.newThread();
    const a = await s.upload();
    const b = await s.upload(JPEG);
    // What the device says about a picture is not trusted: the hub writes what it stored.
    const r = s.send(t, "What is wrong on this page?", [{ ...a, bytes: 1, width: 9999 }, b]);
    expect(r.ok).toBe(true);
    const m = s.messages(t).at(-1)!;
    assertValid("messages", m);
    expect(m.attachments).toEqual([a, b]);
    const start = s.con.of("cmd").filter((c) => c.name === "run.start").at(-1)!.run;
    expect(start.prompt).toBe("What is wrong on this page?");
    expect(start.attachments).toEqual([a, b]);
    // The command and the change carry ids and facts only, never base64.
    expect(JSON.stringify(start).length).toBeLessThan(2000);
    expect(s.store.all<any>("SELECT message_id FROM attachments").map((x) => x.message_id)).toEqual([m.id, m.id]);
  });

  it("a picture alone is a message; the session keeps its placeholder title", async () => {
    const s = setup();
    const t = s.newThread();
    const a = await s.upload();
    expect(s.send(t, "", [a]).ok).toBe(true);
    expect(s.messages(t).at(-1)!.text).toBe("");
    expect(readEntity<Thread>(s.store, "threads", t)!.title).toBe("New session");
    expect(s.send(t, "   ").ok).toBe(false);
  });

  it("a follow-up into a live run carries its pictures", async () => {
    const s = setup();
    const t = s.newThread();
    expect(s.send(t, "start").ok).toBe(true);
    const a = await s.upload();
    expect(s.send(t, "and this one", [a]).ok).toBe(true);
    const input = s.con.of("cmd").filter((c) => c.name === "run.input").at(-1)!;
    expect(input).toMatchObject({ text: "and this one", attachments: [a] });
  });

  it("is refused, with the agent's name, for an agent that cannot look at pictures; nothing is dropped quietly", async () => {
    const s = setup();
    const t = s.newThread("dev");
    const a = await s.upload();
    const r = s.send(t, "look", [a]) as any;
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/Dev agent can't take images/);
    expect(s.messages(t)).toEqual([]);
    expect(s.send(t, "text still works").ok).toBe(true);
  });

  it("an id the hub does not hold is refused", async () => {
    const s = setup();
    const t = s.newThread();
    const r = s.send(t, "look", [{ id: newId("att"), kind: "image", mime: "image/png", bytes: 10, width: 1, height: 1 }]) as any;
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/has not reached the hub/);
  });

  it("a thread with no agent keeps pictures too", async () => {
    const s = setup();
    const t = s.newThread(null);
    const a = await s.upload();
    expect(s.send(t, "for later", [a]).ok).toBe(true);
    expect(s.messages(t).at(-1)!.attachments).toEqual([a]);
  });
});

describe("keeping pictures", () => {
  it("uploads never sent are cleared after a week; sent pictures are kept", async () => {
    const s = setup();
    const t = s.newThread();
    const sent = await s.upload();
    const unsent = await s.upload(JPEG);
    s.send(t, "keep", [sent]);
    expect(sweepOrphanAttachments(s.store, s.dir, s.clock.now + 1000)).toBe(0);
    expect(sweepOrphanAttachments(s.store, s.dir, s.clock.now + ORPHAN_MAX_AGE_MS + 1000)).toBe(1);
    expect(existsSync(join(s.dir, sent.id))).toBe(true);
    expect(existsSync(join(s.dir, unsent.id))).toBe(false);
    expect(s.store.all<any>("SELECT id FROM attachments").map((r) => r.id)).toEqual([sent.id]);
  });

  it("an existing database gets the attachments table and the message column, and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-att-db-"));
    dirs.push(dir);
    const path = join(dir, "old.db");
    // A database from before pictures: its messages table has no attachments column and there is no attachments table.
    const old = new NodeSqlStore(path);
    old.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, run_id TEXT, author_device_id TEXT, created_at INTEGER NOT NULL, card TEXT)");
    old.run("INSERT INTO messages (id, thread_id, role, text, source, created_at) VALUES ('m1', 't1', 'user', 'hello', 'text', 1)");
    old.close();
    const store = openStore(path);
    expect(store.all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name)).toContain("attachments");
    expect(store.all("SELECT * FROM attachments")).toEqual([]);
    expect(readEntity<Message>(store, "messages", "m1")).toMatchObject({ text: "hello", attachments: null });
    store.close();
  });
});
