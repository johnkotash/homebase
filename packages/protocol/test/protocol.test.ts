import { describe, expect, it } from "vitest";
import {
  ApprovalRequest, ApprovalRequestFrame, Change, CmdFrame, ENTITY_NAMES, PERMISSION_MODES, ENTITY_SCHEMAS, HelloFrame, HubToDeviceFrame, InboundFrame, MUTATIONS, MUTATION_NAMES,
  RunEventFrame, isId, isMutationName, newId, uuidv7,
} from "../src";

describe("ids", () => {
  it("creates prefixed uuidv7 ids", () => {
    const id = newId("thr");
    expect(id.startsWith("thr_")).toBe(true);
    expect(isId(id, "thr")).toBe(true);
    expect(isId(id, "msg")).toBe(false);
    expect(isId("thr_not-a-uuid")).toBe(false);
  });

  it("is unique and sorts by creation time", () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("encodes the timestamp in the first 48 bits", () => {
    const t = 1795046400000;
    const hex = uuidv7(t + 10 ** 9).replace(/-/g, "").slice(0, 12);
    expect(parseInt(hex, 16)).toBeGreaterThanOrEqual(t);
  });
});

describe("frames", () => {
  it("accepts the documented hello frame and rejects a tokenless one", () => {
    const ok = HelloFrame.safeParse({
      t: "hello", v: 1, token: "hb_dev_abcdefgh", role: "device", lastSeq: 1287, schema: 1,
      client: { platform: "android", app: "0.1.0", name: "Pixel 10 Pro" },
    });
    expect(ok.success).toBe(true);
    expect(HelloFrame.safeParse({ t: "hello", v: 1, role: "device" }).success).toBe(false);
    expect(HelloFrame.safeParse({ t: "hello", v: 2, token: "hb_dev_abcdefgh", role: "device" }).success).toBe(false);
  });

  it("discriminates inbound frames by t", () => {
    expect(InboundFrame.parse({ t: "ping" }).t).toBe("ping");
    expect(InboundFrame.parse({ t: "sub", topic: "run:run_1" }).t).toBe("sub");
    expect(InboundFrame.safeParse({ t: "nope" }).success).toBe(false);
    expect(InboundFrame.safeParse({ t: "mutate", name: "note.delete", args: {} }).success).toBe(false); // id is required
  });

  it("validates connector frames from the spec", () => {
    expect(RunEventFrame.safeParse({
      t: "run.event", runId: "run_1", idx: 17, at: 1795046410000, kind: "tool_call", persist: true,
      data: { toolUseId: "toolu_1", tool: "Bash", input: { command: "npm test" }, title: "Run tests" },
    }).success).toBe(true);
    expect(RunEventFrame.safeParse({ t: "run.event", runId: "run_1", idx: -1, at: 1, kind: "text", data: {} }).success).toBe(false);
    expect(ApprovalRequestFrame.safeParse({
      t: "approval.request",
      approval: {
        id: "apr_1", runId: "run_1", kind: "question", title: "Which branch?", risk: "low", requestedAt: 1795046425000,
        questions: [{ question: "Which branch?", header: "Branch", multiSelect: false, options: [{ label: "main" }, { label: "staging" }] }],
      },
    }).success).toBe(true);
    expect(ApprovalRequestFrame.safeParse({
      t: "approval.request", approval: { id: "apr_1", runId: "run_1", kind: "tool", title: "x", risk: "extreme", requestedAt: 1 },
    }).success).toBe(false);
  });

  it("validates hub frames", () => {
    expect(HubToDeviceFrame.parse({ t: "ack", id: "mut_1", ok: false, error: { code: "forbidden", message: "no" } }).t).toBe("ack");
    expect(Change.safeParse({ seq: 1288, entity: "messages", id: "msg_1", op: "upsert", at: 1, data: { id: "msg_1" } }).success).toBe(true);
    expect(Change.safeParse({ seq: 0, entity: "messages", id: "msg_1", op: "upsert", at: 1 }).success).toBe(false);
    expect(Change.safeParse({ seq: 3, entity: "run_events", id: "x", op: "upsert", at: 1 }).success).toBe(false); // not a synced entity
  });
});

describe("mutations", () => {
  it("covers the v1 mutation table", () => {
    expect(MUTATION_NAMES.sort()).toEqual([
      "approval.decide", "device.update", "folders.set", "images.set", "inbox.capture", "inbox.update", "message.send", "mode.set", "model.set", "note.delete", "note.upsert",
      "project.create", "project.delete", "project.update", "run.cancel",
      "run.input", "run.start", "settings.update", "thread.create", "thread.read", "thread.recap", "thread.update",
    ]);
    expect(isMutationName("message.send")).toBe(true);
    expect(isMutationName("constructor")).toBe(false);
    expect(isMutationName("drop.database")).toBe(false);
  });

  it("validates args", () => {
    expect(MUTATIONS["message.send"].safeParse({ threadId: "thr_1", messageId: "msg_1", text: "Deploy the staging fix", source: "voice" }).success).toBe(true);
    expect(MUTATIONS["message.send"].safeParse({ threadId: "thr_1", messageId: "msg_1", text: "", source: "voice" }).success).toBe(false);
    expect(MUTATIONS["message.send"].safeParse({ threadId: "thr_1", messageId: "msg_1", text: "x", source: "telepathy" }).success).toBe(false);
    expect(MUTATIONS["approval.decide"].safeParse({ approvalId: "apr_1", decision: "maybe" }).success).toBe(false);
    expect(MUTATIONS["inbox.update"].safeParse({ itemId: "inb_1", priority: "P9" }).success).toBe(false);
    expect(MUTATIONS["inbox.update"].safeParse({ itemId: "inb_1", status: "responded" }).success).toBe(true);
  });

  it("validates permission-mode changes and plan approvals", () => {
    const set = MUTATIONS["mode.set"];
    expect(set.safeParse({ scope: "agent", id: "agt_1", mode: "auto" }).success).toBe(true);
    expect(set.safeParse({ scope: "thread", id: "thr_1", mode: null }).success).toBe(true); // back to the agent's default
    expect(set.safeParse({ scope: "thread", id: "thr_1", mode: "bypassPermissions" }).success).toBe(false);
    expect(set.safeParse({ scope: "workspace", id: "x", mode: "auto" }).success).toBe(false);
    expect(PERMISSION_MODES).toEqual(["manual", "auto", "plan"]);
    // A plan is approved into Manual or Auto, never back into Plan.
    expect(MUTATIONS["approval.decide"].safeParse({ approvalId: "apr_1", decision: "approve", mode: "auto" }).success).toBe(true);
    expect(MUTATIONS["approval.decide"].safeParse({ approvalId: "apr_1", decision: "approve", mode: "plan" }).success).toBe(false);
    expect(MUTATIONS["run.start"].safeParse({ runId: "run_1", agentId: "agt_1", prompt: "x", options: { mode: "plan" } }).success).toBe(true);
    expect(CmdFrame.safeParse({ t: "cmd", id: "c1", name: "run.mode", runId: "run_1", mode: "auto" }).success).toBe(true);
    expect(CmdFrame.safeParse({ t: "cmd", id: "c1", name: "run.mode", runId: "run_1", mode: "plan" }).success).toBe(false);
    expect(ApprovalRequest.safeParse({ id: "apr_1", runId: "run_1", kind: "plan", title: "Plan ready for review", input: { plan: "1. Do it" }, risk: "low", requestedAt: 1, mode: "plan" }).success).toBe(true);
  });
});

describe("entities", () => {
  it("has a schema for every synced entity", () => {
    for (const e of ENTITY_NAMES) expect(ENTITY_SCHEMAS[e]).toBeDefined();
    expect(ENTITY_NAMES).toHaveLength(15);
  });
});

describe("vault", () => {
  it("accepts a capture card and a dictation's capture time, and only the read-side vault ops", async () => {
    const { MessageCard, VaultReqFrame, VaultIndexFrame } = await import("../src");
    const card = { type: "vault_capture", date: "20261119", files: [{ path: "Daily Notes/2026/November.md", status: "appended", bullets: ["- x"] }], transcriptPath: null, flags: [] };
    expect(MessageCard.safeParse(card).success).toBe(true);
    expect(MessageCard.safeParse({ ...card, date: "2026-11-19" }).success).toBe(false);
    expect(MUTATIONS["message.send"].safeParse({ threadId: "t", messageId: "m", text: "hi", source: "voice", capturedAt: 1795111522000, tz: "America/New_York" }).success).toBe(true);
    for (const op of ["read", "search", "backlinks", "status"]) expect(VaultReqFrame.safeParse({ t: "vault.req", id: "1", op, args: {} }).success).toBe(true);
    for (const op of ["save", "create", "delete", "rename", "move"]) expect(VaultReqFrame.safeParse({ t: "vault.req", id: "1", op, args: {} }).success).toBe(false);
    // The index frame carries metadata only: there is no field for a note's text.
    expect(Object.keys(VaultIndexFrame.shape.upserts.element.shape).sort()).toEqual(["folder", "hash", "id", "mtime", "path", "size", "summary", "tags", "title", "type"]);
  });
});
