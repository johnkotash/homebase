import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@homebase/protocol";
import type { HubApp } from "../../../apps/server/src/app";
import { bootHub, connectDevice, waitFor } from "../../../apps/connector/test/harness";
import { MemoryStore, SYNC_CURSOR_KEY, SyncClient, applyOptimistic, emptyMaps } from "../src";

let app: HubApp | null = null;
const clients: Array<{ client: SyncClient }> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.client.stop();
  await app?.close();
  app = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function pair(names = ["Phone", "Desktop"]) {
  const out = [];
  for (const n of names) {
    const c = await connectDevice(app!, n);
    clients.push(c);
    out.push(c);
  }
  return out;
}

describe("two devices in sync", () => {
  it("a message sent on one device appears on the other within a second, with no refresh", async () => {
    app = await bootHub();
    const [phone, desktop] = await pair();
    const threadId = newId("thr");
    const messageId = newId("msg");
    await phone.client.mutate("thread.create", { threadId, title: "Scratch" });
    const t0 = Date.now();
    const sent = phone.client.mutate("message.send", { threadId, messageId, text: "hello from the phone", source: "text" });
    // Optimistic: visible locally before the hub answers.
    expect(phone.state().entities.messages[messageId]?.text).toBe("hello from the phone");
    await waitFor(() => desktop.state().entities.messages[messageId], "message on desktop", 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await sent).ok).toBe(true);
    expect(desktop.state().entities.messages[messageId]).toMatchObject({ role: "user", authorDeviceId: phone.state().deviceId });
    expect(phone.state().outbox).toHaveLength(0);
    expect(phone.state().lastSeq).toBe(desktop.state().lastSeq);
  });

  it("notes, inbox triage and settings converge on both devices", async () => {
    app = await bootHub({ seed: { demo: true } });
    const [phone, desktop] = await pair();
    const noteId = newId("note");
    await desktop.client.mutate("note.upsert", { noteId, title: "Call notes", body: "v1" });
    await waitFor(() => phone.state().entities.notes[noteId], "note on phone");
    await phone.client.mutate("note.upsert", { noteId, title: "Call notes", body: "v2 from phone", baseRev: 1 });
    await waitFor(() => desktop.state().entities.notes[noteId]?.body === "v2 from phone", "edit on desktop");
    expect(desktop.state().entities.notes[noteId].rev).toBe(2);

    const item = Object.values(phone.state().entities.inbox_items).find((i) => i.slaState === "running")!;
    await phone.client.mutate("inbox.update", { itemId: item.id, status: "responded" });
    await waitFor(() => desktop.state().entities.inbox_items[item.id]?.status === "responded", "triage on desktop");
    expect(desktop.state().entities.inbox_items[item.id]).toMatchObject({ slaState: "met" });

    await desktop.client.mutate("note.delete", { noteId });
    await waitFor(() => !phone.state().entities.notes[noteId], "delete on phone");
  });

  it("a rejected mutation is rolled back locally and reported", async () => {
    app = await bootHub();
    const [phone] = await pair(["Phone"]);
    const r = await phone.client.mutate("thread.update", { threadId: "thr_missing", title: "x" });
    expect(r).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(phone.errors).toHaveLength(1);
    expect(phone.state().lastError).toMatchObject({ name: "thread.update", code: "not_found" });
    expect(phone.state().outbox).toHaveLength(0);

    const messageId = newId("msg");
    const p = phone.client.mutate("message.send", { threadId: "thr_missing", messageId, text: "into the void", source: "text" });
    expect(phone.state().entities.messages[messageId]).toBeDefined(); // shown optimistically
    expect((await p).ok).toBe(false);
    expect(phone.state().entities.messages[messageId]).toBeUndefined(); // rolled back
  });
});

describe("offline tolerance", () => {
  it("hub stopped, three changes made, hub restarted: all three applied exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-test-"));
    dirs.push(dir);
    const dbPath = join(dir, "homebase.db");
    app = await bootHub({ dbPath });
    const port = app.port;
    const [phone, desktop] = await pair();
    const threadId = newId("thr");
    await phone.client.mutate("thread.create", { threadId, title: "Offline test" });
    await waitFor(() => desktop.state().entities.threads[threadId], "thread on desktop");
    const seqBefore = phone.state().lastSeq;

    await app.close();
    app = null;
    await waitFor(() => phone.state().status !== "online", "phone notices the hub is gone");

    const noteId = newId("note");
    const messageId = newId("msg");
    const results = [
      phone.client.mutate("message.send", { threadId, messageId, text: "written offline", source: "text" }),
      phone.client.mutate("note.upsert", { noteId, title: "Offline note", body: "queued" }),
      phone.client.mutate("thread.update", { threadId, title: "Renamed offline" }),
    ];
    // Cached read + optimistic writes while offline.
    expect(phone.state().outbox).toHaveLength(3);
    expect(phone.state().entities.threads[threadId].title).toBe("Renamed offline");
    expect(phone.state().entities.notes[noteId].body).toBe("queued");
    expect(phone.state().server.notes[noteId]).toBeUndefined();

    app = await bootHub({ dbPath, port });
    const acks = await Promise.all(results);
    expect(acks.every((a) => a.ok)).toBe(true);
    await waitFor(() => phone.state().status === "online" && phone.state().outbox.length === 0, "outbox drained");
    await waitFor(() => desktop.state().entities.notes[noteId] && desktop.state().entities.threads[threadId]?.title === "Renamed offline", "desktop caught up", 8000);

    const store = app.store;
    expect(store.all("SELECT id FROM messages WHERE id = ?", messageId)).toHaveLength(1);
    expect(store.all("SELECT id FROM notes WHERE id = ?", noteId)).toHaveLength(1);
    expect(store.get<{ title: string }>("SELECT title FROM threads WHERE id = ?", threadId)!.title).toBe("Renamed offline");
    const muts = store.all<{ name: string }>("SELECT name FROM mutations WHERE at >= 0 AND name IN ('message.send','note.upsert','thread.update')");
    expect(muts.map((m) => m.name).sort()).toEqual(["message.send", "note.upsert", "thread.update"]);
    // Exactly one change-log entry per row written: nothing was applied twice.
    const changes = store.all<{ entity: string; entity_id: string }>("SELECT entity, entity_id FROM changes WHERE seq > ? AND entity IN ('messages','notes')", seqBefore);
    expect(changes.filter((c) => c.entity_id === messageId)).toHaveLength(1);
    expect(changes.filter((c) => c.entity_id === noteId)).toHaveLength(1);
    expect(desktop.state().entities.messages[messageId].text).toBe("written offline");
  });

  it("restores the cache and the outbox from storage after an app restart", async () => {
    app = await bootHub({ seed: { demo: true } });
    const storage = new MemoryStore();
    const first = await connectDevice(app, "Phone", { storage });
    const seq = first.state().lastSeq;
    const inboxCount = Object.keys(first.state().entities.inbox_items).length;
    expect(inboxCount).toBeGreaterThan(5);
    first.client.stop(); // flushes the cache

    // Queue a write while the app is "closed", through a client that never connects.
    const offline = new SyncClient({ url: "http://127.0.0.1:9", token: first.token, storage, client: { platform: "test", app: "0", name: "Phone" }, minBackoffMs: 50 });
    await offline.start();
    expect(offline.store.getState().hydrated).toBe(true);
    expect(Object.keys(offline.store.getState().entities.inbox_items)).toHaveLength(inboxCount); // cached read
    const noteId = newId("note");
    void offline.mutate("note.upsert", { noteId, title: "Made offline", body: "" });
    await new Promise((r) => setTimeout(r, 20));
    offline.stop();

    const other = await connectDevice(app, "Desktop");
    clients.push(other);
    await other.client.mutate("note.upsert", { noteId: newId("note"), title: "Meanwhile", body: "" });

    const again = await connectDevice(app, "Phone", { storage, token: first.token });
    clients.push(again);
    await waitFor(() => again.state().outbox.length === 0 && again.state().server.notes[noteId], "queued note applied");
    expect(again.state().lastSeq).toBeGreaterThan(seq);
    expect(Object.values(again.state().entities.notes).map((n) => n.title)).toEqual(expect.arrayContaining(["Made offline", "Meanwhile"]));
    expect(app.store.all("SELECT id FROM notes WHERE id = ?", noteId)).toHaveLength(1);
  });

  it("stops and reports when the token is revoked", async () => {
    app = await bootHub();
    const [phone, desktop] = await pair();
    await phone.client.mutate("device.update", { deviceId: desktop.state().deviceId!, revoked: true });
    await waitFor(() => desktop.state().status === "unauthorized", "desktop unauthorized");
    expect(phone.state().entities.devices[desktop.state().deviceId!].revokedAt).not.toBeNull();
  });
});

describe("resync", () => {
  const vaultFile = (n: number) => ({
    id: `vf_${n}`, path: `Notes/n${n}.md`, title: `Note ${n}`, type: null, tags: [], summary: null, mtime: 1_700_000_000_000 + n, size: 10, hash: `h${n}`, folder: "Notes",
  });
  const addVaultFiles = (count: number) => app!.hub.commit("test", null, (tx) => {
    for (let i = 1; i <= count; i++) tx.upsert("vault_files", vaultFile(i));
  });

  /** Writes the cache an older build would have left: cursor already past the vault_files changes, no rows for them. */
  async function oldBuildCache(storage: MemoryStore, cursorKey: string | undefined) {
    const raw = JSON.parse((await storage.getItem("homebase:cache"))!);
    const { vault_files: _dropped, ...entities } = raw.entities;
    const cache: Record<string, unknown> = { ...raw, lastSeq: app!.hub.currentSeq(), entities };
    if (cursorKey === undefined) delete cache.cursorKey;
    else cache.cursorKey = cursorKey;
    await storage.setItem("homebase:cache", JSON.stringify(cache));
  }

  async function phoneWithCache() {
    app = await bootHub({ seed: { demo: true } });
    const storage = new MemoryStore();
    const first = await connectDevice(app, "Phone", { storage });
    first.client.stop(); // flushes the cache
    expect(JSON.parse((await storage.getItem("homebase:cache"))!).cursorKey).toBe(SYNC_CURSOR_KEY);
    addVaultFiles(5);
    return { storage, token: first.token };
  }

  it("a cursor saved without the entity-set marker (older build) triggers a full resync", async () => {
    const { storage, token } = await phoneWithCache();
    await oldBuildCache(storage, undefined);
    // A change queued before the upgrade survives the resync.
    const outbox = [{ id: newId("mut"), name: "note.upsert", args: { noteId: newId("note"), title: "Queued before upgrade", body: "" }, at: Date.now() }];
    await storage.setItem("homebase:outbox", JSON.stringify(outbox));

    const again = await connectDevice(app!, "Phone", { storage, token });
    clients.push(again);
    await waitFor(() => Object.keys(again.state().server.vault_files).length === 5 && again.state().outbox.length === 0, "vault_files backfilled");
    expect(again.state().lastSeq).toBe(app!.hub.currentSeq());
    expect(Object.values(again.state().entities.notes).map((n) => n.title)).toContain("Queued before upgrade");
    again.client.flushCache();
    expect(JSON.parse((await storage.getItem("homebase:cache"))!).cursorKey).toBe(SYNC_CURSOR_KEY);
  });

  it("a cursor built with a different entity set triggers a full resync; a matching one resumes with a delta", async () => {
    const { storage, token } = await phoneWithCache();
    await oldBuildCache(storage, "1:agents,approvals,connectors,devices,inbox_items,integrations,messages,notes,runs,settings,sla_policies,threads,workspace");
    const again = await connectDevice(app!, "Phone", { storage, token });
    await waitFor(() => Object.keys(again.state().server.vault_files).length === 5, "vault_files backfilled");
    again.client.stop();

    // Control: same key, so the cursor is trusted and only newer changes arrive.
    await oldBuildCache(storage, SYNC_CURSOR_KEY);
    const third = await connectDevice(app!, "Phone", { storage, token });
    clients.push(third);
    expect(third.state().lastSeq).toBe(app!.hub.currentSeq());
    expect(Object.keys(third.state().server.vault_files)).toHaveLength(0);
  });

  it("resync() fetches everything again and keeps pairing and the outbox", async () => {
    app = await bootHub({ seed: { demo: true } });
    const storage = new MemoryStore();
    const [phone] = [await connectDevice(app, "Phone", { storage })];
    clients.push(phone);
    addVaultFiles(3);
    await waitFor(() => Object.keys(phone.state().server.vault_files).length === 3, "vault_files synced");
    const deviceId = phone.state().deviceId;
    // Lose rows locally, as if a change had been dropped.
    phone.client.store.setState({ server: { ...phone.state().server, vault_files: {} } });

    const noteId = newId("note");
    const sent = phone.client.mutate("note.upsert", { noteId, title: "During resync", body: "" });
    phone.client.resync();
    expect(phone.state().lastSeq).toBe(0);
    expect(JSON.parse((await storage.getItem("homebase:cache"))!).lastSeq).toBe(0);
    await waitFor(() => phone.state().status === "online" && Object.keys(phone.state().server.vault_files).length === 3, "resynced");
    expect((await sent).ok).toBe(true);
    await waitFor(() => phone.state().outbox.length === 0 && phone.state().server.notes[noteId], "queued note applied");
    expect(app.store.all("SELECT id FROM notes WHERE id = ?", noteId)).toHaveLength(1);
    expect(phone.state().deviceId).toBe(deviceId);
    expect(phone.state().lastSeq).toBe(app.hub.currentSeq());
  });
});

describe("gateway", () => {
  it("closes sockets that never say hello, and rejects bad tokens", async () => {
    app = await bootHub({ helloTimeoutMs: 150 });
    const silent = new WebSocket(app.wsUrl);
    const code = await new Promise<number>((resolve) => (silent.onclose = (e) => resolve(e.code)));
    expect(code).toBe(4001);

    const bad = new WebSocket(app.wsUrl);
    bad.onopen = () => bad.send(JSON.stringify({ t: "hello", v: 1, token: "hb_dev_not-a-real-token", role: "device" }));
    expect(await new Promise<number>((resolve) => (bad.onclose = (e) => resolve(e.code)))).toBe(4003);

    expect((await fetch(`${app.url}/v1/health`).then((r) => r.json())) as any).toMatchObject({ ok: true });
    expect((await fetch(`${app.url}/v1/pairing-codes`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(`${app.url}/v1/pair`, { method: "POST", body: JSON.stringify({ code: "NOPE-NOPE", kind: "device", name: "x", platform: "t" }) })).status).toBe(400);
  });

  it("pairs over HTTP, creates more codes from a paired device, and simulates inbox items in dev mode", async () => {
    app = await bootHub({ seed: { demo: true } });
    const boot = app.directory.createPairingCode("device", null);
    const res = await fetch(`${app.url}/v1/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: boot.code, kind: "device", name: "Pixel 10 Pro", platform: "android" }) });
    const paired = (await res.json()) as { token: string; deviceId: string; workspaceId: string };
    expect(res.status).toBe(200);
    expect(paired.token).toMatch(/^hb_dev_/);
    const auth = { Authorization: `Bearer ${paired.token}`, "Content-Type": "application/json" };
    const code = (await fetch(`${app.url}/v1/pairing-codes`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "connector" }) }).then((r) => r.json())) as { code: string; expiresAt: number };
    expect(code.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(code.expiresAt - Date.now()).toBeLessThanOrEqual(10 * 60_000);

    const phone = await connectDevice(app, "Pixel 10 Pro", { token: paired.token });
    clients.push(phone);
    const sim = (await fetch(`${app.url}/v1/dev/simulate`, { method: "POST", headers: auth, body: JSON.stringify({ kind: "monitor" }) }).then((r) => r.json())) as { item: { id: string } };
    await waitFor(() => phone.state().entities.inbox_items[sim.item.id], "simulated item synced");
    expect(phone.state().entities.inbox_items[sim.item.id]).toMatchObject({ priority: "P0", slaState: "running" });
    await waitFor(() => phone.notifications.some((n) => n.channel === "p0_urgent"), "P0 notification");
  });
});

describe("optimistic reducers", () => {
  it("leaves hub-confirmed maps untouched (copy on write)", () => {
    const server = emptyMaps();
    const out = applyOptimistic(server, [{ id: "m1", name: "note.upsert", args: { noteId: "note_1", title: "t", body: "b" }, at: 5 }], "dev_1");
    expect(server.notes).toEqual({});
    expect(out.notes.note_1).toMatchObject({ title: "t", rev: 1, createdAt: 5 });
    expect(out.threads).toBe(server.threads); // untouched maps are shared, not copied
    expect(applyOptimistic(server, [], "dev_1")).toBe(server);
  });

  it("predicts projects and filing: create, move a session in, rename, delete back to Unsorted", () => {
    const server = emptyMaps();
    const m = (name: string, args: unknown, at: number) => ({ id: `m${at}`, name: name as any, args, at });
    const box = [
      m("project.create", { projectId: "prj_1", name: "  Notetaker  ", description: "the app" }, 1),
      m("thread.create", { threadId: "thr_1", title: "New session with Claude agent", agentId: null, projectId: "prj_1" }, 2),
      m("thread.create", { threadId: "thr_2", title: "Loose", agentId: null }, 3),
      m("thread.create", { threadId: "thr_3", title: "Ghost", agentId: null, projectId: "prj_unknown" }, 4),
    ];
    let out = applyOptimistic(server, box, "dev_1");
    expect(out.projects.prj_1).toMatchObject({ name: "Notetaker", description: "the app", pinned: false, archived: false, defaultAgentId: null, createdAt: 1 });
    expect(out.threads.thr_1.projectId).toBe("prj_1");
    expect(out.threads.thr_2.projectId).toBeNull();
    expect(out.threads.thr_3.projectId).toBeNull(); // a project this device does not know: Unsorted until the hub answers

    out = applyOptimistic(server, [
      ...box,
      m("thread.update", { threadId: "thr_2", projectId: "prj_1", note: "  left here  " }, 5),
      m("thread.update", { threadId: "thr_1", projectId: "prj_unknown" }, 6), // would be refused: no local change
      m("message.send", { threadId: "thr_1", messageId: "msg_1", text: "Fix the sync cursor\nplease", source: "text" }, 7),
      m("project.update", { projectId: "prj_1", name: "Notetaker app", pinned: true }, 8),
    ], "dev_1");
    expect(out.threads.thr_2).toMatchObject({ projectId: "prj_1", note: "left here" });
    expect(out.threads.thr_1).toMatchObject({ projectId: "prj_1", title: "Fix the sync cursor", lastMessageAt: 7 }); // named after the first message
    expect(out.projects.prj_1).toMatchObject({ name: "Notetaker app", pinned: true, description: "the app" });

    out = applyOptimistic(server, [...box, m("thread.update", { threadId: "thr_2", projectId: "prj_1" }, 5), m("project.delete", { projectId: "prj_1" }, 9)], "dev_1");
    expect(out.projects.prj_1).toBeUndefined();
    expect([out.threads.thr_1.projectId, out.threads.thr_2.projectId]).toEqual([null, null]);
    expect(Object.keys(out.threads)).toHaveLength(3); // no session is ever removed with its project
    expect(server.projects).toEqual({});
  });
});

describe("projects and sessions across devices", () => {
  it("a project made on the phone and a session filed into it appear on the desktop, and survive a full resync", async () => {
    app = await bootHub();
    const [phone, desktop] = await pair();
    const projectId = newId("prj");
    const threadId = newId("thr");
    await phone.client.mutate("project.create", { projectId, name: "Notetaker", description: "The app I maintain" });
    await phone.client.mutate("thread.create", { threadId, title: "New scratch thread" });
    const moved = phone.client.mutate("thread.update", { threadId, projectId, note: "Next: ship the fix" });
    expect(phone.state().entities.threads[threadId]).toMatchObject({ projectId, note: "Next: ship the fix" }); // at once, before the hub answers
    expect((await moved).ok).toBe(true);
    await waitFor(() => desktop.state().entities.threads[threadId]?.projectId === projectId, "filed on desktop");
    expect(desktop.state().entities.projects[projectId]).toMatchObject({ name: "Notetaker", description: "The app I maintain" });
    expect(desktop.state().entities.threads[threadId].note).toBe("Next: ship the fix");

    await desktop.client.mutate("message.send", { threadId, messageId: newId("msg"), text: "Remember the changelog", source: "text" });
    await waitFor(() => phone.state().entities.threads[threadId]?.title === "Remember the changelog", "auto title on phone");

    desktop.client.resync();
    await waitFor(() => desktop.state().status === "online" && desktop.state().lastSeq === app!.hub.currentSeq(), "resynced");
    expect(desktop.state().server.projects[projectId].name).toBe("Notetaker");
    expect(desktop.state().server.threads[threadId]).toMatchObject({ projectId, title: "Remember the changelog" });

    await phone.client.mutate("project.delete", { projectId });
    await waitFor(() => !desktop.state().entities.projects[projectId], "project gone on desktop");
    expect(desktop.state().entities.threads[threadId]).toMatchObject({ projectId: null, note: "Next: ship the fix" });
  });

  it("this build's cursor covers projects, so a build from before them does a full resync on its own", () => {
    expect(SYNC_CURSOR_KEY.split(":")[1].split(",")).toContain("projects");
    expect(SYNC_CURSOR_KEY).not.toBe("1:agents,approvals,connectors,devices,inbox_items,integrations,messages,notes,runs,settings,sla_policies,threads,vault_files,workspace");
  });
});
