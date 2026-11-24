import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId } from "@homebase/protocol";
import { NodeSqlStore } from "../src/hub/SqlStore";
import { openStore } from "../src/app";
import { loadConfig } from "../src/config";
import { WorkspaceHub } from "../src/hub/WorkspaceHub";
import { seed } from "../src/seed";
import { ReadOnlyStore, applyDemoRemoval, databaseInUse, formatPlan, planDemoRemoval, planIsEmpty, tableCounts } from "../src/demo-cleanup";
import { connectConnector, connectDevice, makeHub, pairDevice, peer } from "./helpers";

const count = (store: { get: Function }, table: string) => Number((store.get(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n);
const MIN = 60_000;

describe("first-start seed", () => {
  it("creates an empty workspace by default: owner, SLA policies and neutral settings only", () => {
    const store = openStore(":memory:");
    const hub = new WorkspaceHub(store, { quiet: true });
    expect(seed(hub, { workspaceName: "Acme" })).toBe(true);
    expect(hub.workspace().name).toBe("Acme");
    expect(count(store, "users")).toBe(1);
    expect(count(store, "memberships")).toBe(1);
    for (const t of ["threads", "messages", "runs", "run_events", "approvals", "inbox_items", "notes", "integrations", "agents", "projects", "audit_log", "notifications"]) {
      expect(count(store, t), t).toBe(0);
    }
    const policies = store.all<{ name: string; is_default: number }>("SELECT name, is_default FROM sla_policies ORDER BY respond_within_minutes");
    expect(policies.map((p) => p.name)).toEqual(["P0 — 1 hour, around the clock", "P1 — 4 business hours", "Standard — 1 business day"]);
    expect(policies.filter((p) => p.is_default)).toHaveLength(1);
    expect(hub.setting("triage.rules", null)).toEqual({ vipSenders: [], mutedSenders: ["noreply@", "no-reply@", "newsletter@", "digest@"] });
    // Nothing in the default baseline names an invented business.
    const dump = JSON.stringify(store.all("SELECT * FROM changes")) + JSON.stringify(store.all("SELECT * FROM settings"));
    expect(dump).not.toMatch(/\.example|harbor|northwind|hilltop|lakeside|northside/i);
    expect(seed(hub, { demo: true })).toBe(false); // idempotent: an existing workspace is never seeded again
    expect(count(store, "threads")).toBe(0);
  });

  it("seeds the demo with demo: true (HOMEBASE_DEMO=1)", () => {
    const { hub, store } = makeHub({ demo: true });
    expect(count(store, "threads")).toBeGreaterThan(0);
    expect(count(store, "inbox_items")).toBeGreaterThan(0);
    expect(count(store, "notes")).toBeGreaterThan(0);
    expect(count(store, "run_events")).toBeGreaterThan(0);
    expect(store.all<{ status: string }>("SELECT status FROM integrations").every((i) => i.status === "simulated")).toBe(true);
    expect(store.all<{ key: string }>("SELECT key FROM agents WHERE kind = 'mock' ORDER BY key").map((a) => a.key)).toEqual(["comms", "dev", "ops"]);
    expect(hub.setting<{ vipSenders: string[] }>("triage.rules", { vipSenders: [] }).vipSenders).toEqual(["harborpinerealty.example", "northwindsupply.example"]);
    expect(count(store, "sla_policies")).toBe(3);
  });

  it("reads HOMEBASE_DEMO: off by default, on for 1/true/yes/on", () => {
    expect(loadConfig({}).demo).toBe(false);
    expect(loadConfig({ HOMEBASE_DEMO: "0" }).demo).toBe(false);
    expect(loadConfig({ HOMEBASE_DEMO: "1" }).demo).toBe(true);
    expect(loadConfig({ HOMEBASE_DEMO: " True " }).demo).toBe(true);
  });
});

/** A demo-seeded hub that the owner then used for real: the case `npm run remove-demo` is for. */
function usedDemoHub() {
  const env = makeHub({ demo: true });
  const { hub, store, directory, clock } = env;
  const demoIds = new Set(store.all<{ id: string }>(
    `SELECT id FROM threads UNION ALL SELECT id FROM messages UNION ALL SELECT id FROM runs UNION ALL SELECT id FROM approvals
     UNION ALL SELECT id FROM inbox_items UNION ALL SELECT id FROM notes UNION ALL SELECT id FROM integrations UNION ALL SELECT id FROM projects
     UNION ALL SELECT id FROM agents WHERE key IN ('dev', 'ops')`,
  ).map((r) => r.id));
  const comms = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'comms'")!.id;
  const dev = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'dev'")!.id;
  const demoThread = store.get<{ id: string }>("SELECT id FROM threads WHERE agent_id = ? LIMIT 1", dev)!.id;

  // A connector paired in the seed's first minute is real, and so is its audit row.
  const early = pairDevice(directory, "connector", "early-connector");
  // Two hours later: a real connector, real sessions, mail, notes and settings.
  clock.now += 120 * MIN;
  connectConnector(hub, directory, [{ key: "claude", name: "Claude agent", kind: "claude" as any }]);
  const claude = store.get<{ id: string }>("SELECT id FROM agents WHERE key = 'claude'")!.id;
  const real = { threads: [newId("thr"), newId("thr")], message: newId("msg"), run: newId("run"), note: newId("note"), integration: newId("int"), project: newId("prj"), lateDev: newId("thr") };
  hub.commit(null, null, (tx) => {
    const now = tx.now;
    tx.upsert("projects", { id: real.project, name: "Real project", description: null, defaultAgentId: dev, defaultCwd: "/srv/x", pinned: false, archived: false, createdAt: now, updatedAt: now });
    for (const id of real.threads) {
      tx.upsert("threads", { id, title: "Real session", agentId: id === real.threads[0] ? claude : comms, lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: now, updatedAt: now });
    }
    tx.upsert("runs", {
      id: real.run, agentId: claude, threadId: real.threads[0], prompt: "real work", status: "succeeded", sessionRef: null, summary: null, error: null, costUsd: 0,
      numTurns: 1, durationMs: 1, lastEventIdx: -1, startedBy: null, cwd: null, createdAt: now, startedAt: now, endedAt: now, updatedAt: now,
    });
    tx.upsert("messages", { id: real.message, threadId: real.threads[0], role: "user", text: "hello", source: "text", runId: real.run, authorDeviceId: null, createdAt: now });
    tx.upsert("notes", { id: real.note, title: "Real note", body: "x", tags: [], rev: 1, source: "text", vaultPath: null, createdAt: now, updatedAt: now });
    tx.upsert("integrations", { id: real.integration, kind: "gmail", name: "Gmail", status: "connected", config: {}, lastSyncAt: now, error: null });
    // A later session with the scripted Dev agent goes with it.
    tx.upsert("threads", { id: real.lateDev, title: "Tried the dev agent", agentId: dev, lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: now, updatedAt: now });
    const rules = tx.get("settings", "triage.rules")!;
    tx.upsert("settings", { ...rules, value: { ...(rules.value as object), vipSenders: [...(rules.value as any).vipSenders, "bigclient.test"] }, updatedAt: now });
    tx.audit("thread.create", "thread", real.threads[0]);
  });
  const mail = hub.ingest({ source: "gmail", externalId: "real-1", title: "Real mail", sender: "someone@bigclient.test" });
  hub.commit(null, null, (tx) => tx.patch("inbox_items", mail.id, { linkedThreadId: demoThread }));
  return { ...env, demoIds, real, mail, demoThread, early };
}

describe("remove-demo", () => {
  it("dry run lists only the demo, and the seed-era rows", () => {
    const { store, demoIds, real, mail } = usedDemoHub();
    const plan = planDemoRemoval(store);
    const removed = new Set(plan.remove.map((r) => r.id));
    for (const id of demoIds) expect(removed.has(id), id).toBe(true);
    for (const id of [...real.threads, real.message, real.run, real.note, real.integration, real.project, mail.id]) expect(removed.has(id), id).toBe(false);
    expect(plan.remove.filter((r) => r.late).map((r) => r.id)).toEqual([real.lateDev]);
    expect(plan.remove.filter((r) => r.entity === "agents").map((r) => r.label).sort()).toEqual(["Dev agent (dev)", "Site ops agent (ops)"]);
    expect(plan.detach.map((d) => [d.entity, d.id, d.fields])).toEqual(expect.arrayContaining([
      ["inbox_items", mail.id, { linkedThreadId: null }],
      ["projects", real.project, { defaultAgentId: null, defaultCwd: null }],
    ]));
    expect(plan.vip).toEqual({ before: ["harborpinerealty.example", "northwindsupply.example", "bigclient.test"], after: ["bigclient.test"] });
    expect(plan.direct.some((d) => d.entity === "run_events")).toBe(true);
    expect(plan.direct.filter((d) => d.entity === "audit_log").every((d) => d.label.startsWith("approval.decide"))).toBe(true);
    expect(formatPlan(plan).join("\n")).toMatch(/Tried the dev agent {3}\[created after the seed\]/);
  });

  it("apply removes only the demo, through the change log, and keeps every real row", () => {
    const { hub, store, directory, real, mail, early } = usedDemoHub();
    const device = connectDevice(hub, directory);
    const lastSeq = hub.currentSeq();
    const before = tableCounts(store);
    const plan = planDemoRemoval(store);
    applyDemoRemoval(hub, plan);
    const after = tableCounts(store);

    // Real rows are all there.
    expect(store.all<{ id: string }>("SELECT id FROM threads").map((t) => t.id).sort()).toEqual([...real.threads].sort());
    expect(store.all<{ id: string }>("SELECT id FROM messages").map((m) => m.id)).toEqual([real.message]);
    expect(store.all<{ id: string }>("SELECT id FROM runs").map((r) => r.id)).toEqual([real.run]);
    expect(store.all<{ id: string }>("SELECT id FROM notes").map((n) => n.id)).toEqual([real.note]);
    expect(store.all<{ id: string }>("SELECT id FROM integrations").map((i) => i.id)).toEqual([real.integration]);
    expect(store.all<{ id: string }>("SELECT id FROM inbox_items").map((i) => i.id)).toEqual([mail.id]);
    expect(store.all<{ key: string }>("SELECT key FROM agents ORDER BY key").map((a) => a.key)).toEqual(["claude", "comms"]);
    expect(store.get<any>("SELECT linked_thread_id FROM inbox_items WHERE id = ?", mail.id).linked_thread_id).toBeNull();
    expect(store.get<any>("SELECT default_agent_id, name FROM projects WHERE id = ?", real.project)).toEqual({ default_agent_id: null, name: "Real project" });
    expect(count(store, "approvals") + count(store, "run_events") + count(store, "note_revisions")).toBe(0);
    expect(hub.setting<{ vipSenders: string[] }>("triage.rules", { vipSenders: [] }).vipSenders).toEqual(["bigclient.test"]);
    for (const t of ["workspaces", "users", "memberships", "devices", "connectors", "sla_policies", "settings"]) expect(after[t], t).toBe(before[t]);
    // The real audit rows (three pairings, one in the seed's first minute, and a thread) stay; the seed's approval records go.
    expect(store.all<{ action: string }>("SELECT action FROM audit_log ORDER BY action").map((a) => a.action)).toEqual(["demo.remove", "device.pair", "device.pair", "device.pair", "thread.create"]);
    expect(store.get<any>("SELECT subject_id FROM audit_log WHERE subject_id = ?", early.deviceId)).toBeTruthy();

    // A connected device got the removals live; one that reconnects from before gets them as a delta.
    const deletes = device.of("changes").flatMap((f) => f.changes).filter((c: any) => c.op === "delete");
    expect(deletes.length).toBe(plan.remove.length);
    const late = peer(device.id);
    hub.attachDevice(late, { lastSeq });
    const delta = late.of("changes").flatMap((f) => f.changes);
    expect(late.of("welcome")[0].mode).toBe("delta");
    expect(new Set(delta.filter((c: any) => c.op === "delete").map((c: any) => c.id))).toEqual(new Set(plan.remove.map((r) => r.id)));
    expect(delta.some((c: any) => c.op === "delete" && [...real.threads, real.message, real.note].includes(c.id))).toBe(false);

    // Running it again finds nothing.
    expect(planIsEmpty(planDemoRemoval(store))).toBe(true);
  });

  it("finds nothing in a database that never had the demo", () => {
    const { store } = makeHub();
    const plan = planDemoRemoval(store);
    expect(planIsEmpty(plan)).toBe(true);
    expect(formatPlan(plan).join("\n")).toMatch(/No demo content found/);
  });

  it("reads a file database read-only for the dry run and sees when another connection holds it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-demo-"));
    const path = join(dir, "homebase.db");
    try {
      const store = openStore(path);
      seed(new WorkspaceHub(store, { quiet: true }), { demo: true });
      expect(databaseInUse(path)).toBe(true); // what a running hub looks like
      const ro = new ReadOnlyStore(path);
      expect(planDemoRemoval(ro).remove.length).toBeGreaterThan(0);
      expect(() => ro.run()).toThrow(/read-only/);
      ro.close();
      store.close();
      expect(databaseInUse(path)).toBe(false);
      const again = new NodeSqlStore(path);
      expect(count(again, "threads")).toBeGreaterThan(0); // the probe changed nothing
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
