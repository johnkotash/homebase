import { describe, expect, it } from "vitest";
import { ClaudeStreamMapper, LineBuffer, MAX_TOOL_OUTPUT, toolTitle, type MappedAction } from "../src/adapters/claude-stream";
import { fixture } from "./claude-fixtures";

const mapAll = (text: string) => {
  const m = new ClaudeStreamMapper();
  return text.split("\n").flatMap((l) => m.line(l));
};
const events = (a: MappedAction[]) => a.filter((x): x is Extract<MappedAction, { type: "event" }> => x.type === "event");

describe("stream-json → run events", () => {
  const actions = mapAll(fixture("claude-list-files.jsonl"));

  it("reads the session id, model and auth source from system/init", () => {
    const init = actions.find((a) => a.type === "init");
    expect(init).toMatchObject({ type: "init", sessionId: "a2ef81c0-c0f0-47c5-85d5-3a02fae4dd94", model: "claude-haiku-5-5", apiKeySource: "none", cwd: "C:\\work\\sandbox" });
  });

  it("maps a tool_use block to tool_call and its tool_result to tool_result", () => {
    const ev = events(actions);
    const call = ev.find((e) => e.kind === "tool_call")!;
    expect(call.data).toMatchObject({ toolUseId: "toolu_01F9syabJR6yyqe3wqSSt2Gy", tool: "Glob", input: { pattern: "*", path: "C:\\work\\sandbox" } });
    expect(call.data.title).toBe("Find files *");
    const result = ev.find((e) => e.kind === "tool_result")!;
    expect(result.data).toEqual({ toolUseId: "toolu_01F9syabJR6yyqe3wqSSt2Gy", tool: "Glob", output: "a.txt", isError: false });
    expect(ev.indexOf(call)).toBeLessThan(ev.indexOf(result));
  });

  it("streams text deltas unpersisted, then one complete text message", () => {
    const ev = events(actions);
    const deltas = ev.filter((e) => e.kind === "text_delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((d) => d.persist === false)).toBe(true);
    const texts = ev.filter((e) => e.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].persist).toBeUndefined();
    expect(deltas.map((d) => d.data.text).join("")).toBe(texts[0].data.text);
    expect(texts[0].data.text).toBe("a.txt\n\nDone and dusted.");
  });

  it("maps the final result to summary, cost, turns and duration", () => {
    expect(actions.at(-1)).toEqual({
      type: "result", ok: true, summary: "a.txt\n\nDone and dusted.", error: null, sessionId: "a2ef81c0-c0f0-47c5-85d5-3a02fae4dd94",
      costUsd: 0.00188197, numTurns: 2, durationMs: 2566,
    });
  });

  it("ignores status lines, allowed rate-limit events, tool-input deltas and noise", () => {
    const kinds = new Set(events(actions).map((e) => e.kind));
    expect([...kinds].sort()).toEqual(["text", "text_delta", "tool_call", "tool_result"]);
    const m = new ClaudeStreamMapper();
    expect(m.line("")).toEqual([]);
    expect(m.line("not json")).toEqual([]);
    expect(m.line("{broken")).toEqual([]);
    expect(m.line(JSON.stringify({ type: "system", subtype: "status", status: "requesting" }))).toEqual([]);
  });

  it("marks a denied tool call as an error result and keeps going across two turns", () => {
    const a = mapAll(fixture("claude-denied-then-followup.jsonl"));
    const denied = events(a).find((e) => e.kind === "tool_result")!;
    expect(denied.data).toMatchObject({ tool: "Write", isError: true });
    expect(String(denied.data.output)).toContain("The owner denied this in HomeBase");
    const results = a.filter((x) => x.type === "result") as Array<Extract<MappedAction, { type: "result" }>>;
    expect(results.map((r) => [r.ok, r.summary, r.numTurns])).toEqual([[true, "refused", 2], [true, "hi", 1]]);
    // every turn re-announces the same session
    const inits = a.filter((x) => x.type === "init") as Array<Extract<MappedAction, { type: "init" }>>;
    expect(inits).toHaveLength(2);
    expect(new Set(inits.map((i) => i.sessionId)).size).toBe(1);
    expect(inits[0].mcpServers).toEqual([{ name: "homebase", status: "connected" }]);
  });

  it("maps error results to a readable failure", () => {
    const m = new ClaudeStreamMapper();
    const [maxTurns] = m.message({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 25, session_id: "s", total_cost_usd: 0.2, duration_ms: 9 });
    expect(maxTurns).toMatchObject({ type: "result", ok: false, summary: "", numTurns: 25, costUsd: 0.2 });
    expect((maxTurns as any).error).toMatch(/max-turns limit \(25 turns\)/);
    const [loggedOut] = m.message({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: "s" });
    expect(loggedOut).toMatchObject({ ok: false, error: "Not logged in · Please run /login" });
    const [noSession] = m.message({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0 });
    expect((noSession as any).error).toBe("Claude stopped: error during execution");
  });

  it("truncates large tool output, flattens block content and de-duplicates tool calls", () => {
    const m = new ClaudeStreamMapper();
    const use = { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "type big.log" } }] } };
    expect(m.message(use)).toHaveLength(1);
    expect(m.message(use)).toHaveLength(0);
    const [r] = m.message({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "x".repeat(MAX_TOOL_OUTPUT + 500) }, { type: "image" }] }] } }) as any[];
    expect(r.data.tool).toBe("Bash");
    expect(r.data.output.length).toBeLessThan(MAX_TOOL_OUTPUT + 200);
    expect(r.data.output).toContain("more characters stay on the connector host");
  });

  it("keeps subagent text out of the thread and warns once about usage limits", () => {
    const m = new ClaudeStreamMapper();
    expect(m.message({ type: "assistant", parent_tool_use_id: "toolu_p", message: { content: [{ type: "text", text: "inner" }] } })).toEqual([]);
    expect(m.message({ type: "stream_event", parent_tool_use_id: "toolu_p", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } })).toEqual([]);
    const warn = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1795091400 } };
    const [w] = m.message(warn) as any[];
    expect(w.kind).toBe("system");
    expect(w.data.message).toMatch(/Usage limit reached \(five hour\)/);
    expect(m.message(warn)).toEqual([]);
  });

  it("names tool calls for people", () => {
    expect(toolTitle("Write", { file_path: "C:\\work\\sandbox\\hello.txt" })).toBe("Write hello.txt");
    expect(toolTitle("Bash", { command: "npm test", description: "Run the tests" })).toBe("Run the tests");
    expect(toolTitle("PowerShell", { command: "Get-ChildItem" })).toBe("Run: Get-ChildItem");
    expect(toolTitle("mcp__clickup__create_task", {})).toBe("mcp__clickup__create_task");
  });

  it("reassembles lines split across chunks", () => {
    const b = new LineBuffer();
    expect(b.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(b.push(":2}\n")).toEqual(['{"b":2}']);
    expect(b.push("tail")).toEqual([]);
    expect(b.flush()).toEqual(["tail"]);
  });
  it("forwards the plan usage of every rate_limit_event for the meter", () => {
    const m = new ClaudeStreamMapper();
    const ev = { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: 1795091400, status: "allowed" }, seven_day: { utilization: 0.15, resetsAt: 1795590000, status: "allowed" } } } };
    const out = m.message(ev as any);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "usage", usage: { windows: { five_hour: { pct: 7 }, seven_day: { pct: 15 } } } });
  });
});
