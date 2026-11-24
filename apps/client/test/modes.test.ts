import { describe, expect, it } from "vitest";
import type { AgentAuthProof } from "@homebase/protocol";
import { applyOptimistic, emptyMaps } from "@homebase/sync-client";
import { parseInline, parseMarkdown } from "../src/markdown";
import { MODE, authFacts, effectiveMode } from "../src/modes";

describe("permission mode shown in a chat", () => {
  const agent = { modes: ["manual", "auto", "plan"] as Array<"manual" | "auto" | "plan">, defaultMode: "auto" as const };

  it("is the chat's own choice, else the agent's default, else Manual", () => {
    expect(effectiveMode(agent, { mode: "plan" })).toBe("plan");
    expect(effectiveMode(agent, { mode: null })).toBe("auto");
    expect(effectiveMode(agent, undefined)).toBe("auto");
    expect(effectiveMode({ ...agent, defaultMode: null }, null)).toBe("manual");
    expect(effectiveMode({ modes: ["manual", "plan"], defaultMode: "manual" }, { mode: "auto" })).toBe("manual");
  });

  it("is absent for agents without modes", () => {
    expect(effectiveMode({ modes: null, defaultMode: null }, { mode: "auto" })).toBeNull();
    expect(effectiveMode(undefined, null)).toBeNull();
  });

  it("explains each mode in plain words", () => {
    expect(Object.keys(MODE)).toEqual(["manual", "auto", "plan"]);
    expect(MODE.auto.body).toMatch(/without asking/);
    expect(MODE.auto.body).toMatch(/secret and credential files/);
    expect(MODE.plan.body).toMatch(/Nothing is changed/);
  });
});

describe("optimistic mode changes", () => {
  const base = () => {
    const maps = emptyMaps();
    maps.agents.agt_1 = { id: "agt_1", connectorId: "con_1", key: "claude", name: "Claude agent", kind: "claude", description: "", capabilities: [], workspaces: [], permissionProfile: "strict", status: "online", updatedAt: 1, modes: ["manual", "auto", "plan"], defaultMode: "manual" };
    maps.threads.thr_1 = { id: "thr_1", title: "t", agentId: "agt_1", lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 1, mode: null };
    maps.runs.run_1 = { id: "run_1", agentId: "agt_1", threadId: "thr_1", prompt: "p", status: "waiting_approval", sessionRef: null, summary: null, error: null, costUsd: null, numTurns: null, durationMs: null, lastEventIdx: -1, startedBy: null, cwd: null, createdAt: 1, startedAt: 1, endedAt: null, updatedAt: 1, mode: "plan" };
    maps.approvals.apr_1 = { id: "apr_1", runId: "run_1", agentId: "agt_1", kind: "plan", tool: "ExitPlanMode", title: "Plan ready for review", summary: null, input: { plan: "1. x" }, questions: null, risk: "low", reason: null, status: "pending", decisionMessage: null, answers: null, decidedBy: null, requestedAt: 1, decidedAt: null, mode: "plan" };
    return maps;
  };
  const entry = (name: string, args: unknown) => ({ id: `mut_${name}`, name, args, at: 5 }) as any;

  it("shows a mode change at once, before the hub confirms it", () => {
    const server = base();
    const view = applyOptimistic(server, [entry("mode.set", { scope: "thread", id: "thr_1", mode: "auto" }), entry("mode.set", { scope: "agent", id: "agt_1", mode: "plan" })], "dev_1");
    expect(view.threads.thr_1.mode).toBe("auto");
    expect(view.agents.agt_1.defaultMode).toBe("plan");
    expect(server.threads.thr_1.mode).toBeNull(); // hub-confirmed state is untouched
    // A mode the agent does not offer is not predicted.
    server.agents.agt_1 = { ...server.agents.agt_1, modes: ["manual", "plan"] };
    expect(applyOptimistic(server, [entry("mode.set", { scope: "thread", id: "thr_1", mode: "auto" })], "dev_1").threads.thr_1.mode).toBeNull();
  });

  it("approving a plan moves the card, the run and the chat to the chosen mode", () => {
    const view = applyOptimistic(base(), [entry("approval.decide", { approvalId: "apr_1", decision: "approve", mode: "auto" })], "dev_1");
    expect(view.approvals.apr_1).toMatchObject({ status: "approved", mode: "auto", decidedBy: "dev_1" });
    expect(view.runs.run_1.mode).toBe("auto");
    expect(view.threads.thr_1.mode).toBe("auto");
    const kept = applyOptimistic(base(), [entry("approval.decide", { approvalId: "apr_1", decision: "deny", message: "more detail" })], "dev_1");
    expect(kept.approvals.apr_1).toMatchObject({ status: "denied", mode: "plan", decisionMessage: "more detail" });
    expect(kept.runs.run_1.mode).toBe("plan");
  });
});

describe("auth facts", () => {
  const auth: AgentAuthProof = {
    authMode: "subscription", cliVersion: "2.1.301", apiKeySource: "none", model: "claude-haiku-5-5", envStripped: true,
    strippedPatterns: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_*"], strippedCount: 0, loggedIn: true, checkedAt: 1000, lastRunAt: 2000,
  };
  const byLabel = (a: AgentAuthProof) => Object.fromEntries(authFacts(a, (t) => `t${t}`).map((f) => [f.label, f]));

  it("lists the facts the connector reported, in the owner's words", () => {
    const f = byLabel(auth);
    expect(f["Auth mode"].value).toBe("Subscription (Claude Code login)");
    expect(f["Claude Code CLI"].value).toBe("2.1.301");
    expect(f["apiKeySource (last run)"]).toMatchObject({ value: "none", ok: true });
    expect(f["Model"].value).toBe("claude-haiku-5-5");
    expect(f["Environment"].value).toBe("Auth variables stripped");
    expect(f["Environment"].note).toContain("ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_*");
    expect(f["Last check"]).toMatchObject({ value: "t1000", note: "Last run started t2000." });
  });

  it("flags an API key on a subscription agent and says when no run has happened yet", () => {
    expect(byLabel({ ...auth, apiKeySource: "ANTHROPIC_API_KEY" })["apiKeySource (last run)"]).toMatchObject({ value: "ANTHROPIC_API_KEY", ok: false });
    expect(byLabel({ ...auth, apiKeySource: null, lastRunAt: null })["apiKeySource (last run)"]).toMatchObject({ value: "No run yet", ok: undefined });
    expect(byLabel({ ...auth, authMode: "api_key", apiKeySource: "ANTHROPIC_API_KEY" })["Auth mode"].value).toBe("API key");
  });
});

describe("plan markdown", () => {
  it("parses the shapes a plan uses", () => {
    const blocks = parseMarkdown("# Plan\n\nSome **context** here\nwrapped.\n\n1. First `step`\n2. Second\n   - nested\n\n```sh\nnpm test\n```\n> note\n---\n- [ ] todo");
    expect(blocks.map((b) => b.t)).toEqual(["h", "p", "li", "li", "li", "code", "quote", "hr", "li"]);
    expect(blocks[0]).toEqual({ t: "h", level: 1, text: "Plan" });
    expect(blocks[1]).toEqual({ t: "p", text: "Some **context** here wrapped." });
    expect(blocks[2]).toMatchObject({ ordered: true, marker: "1.", depth: 0, text: "First `step`" });
    expect(blocks[4]).toMatchObject({ ordered: false, marker: "•", depth: 1, text: "nested" });
    expect(blocks[5]).toEqual({ t: "code", text: "npm test" });
    expect(blocks[8]).toMatchObject({ text: "☐ todo" });
  });

  it("parses inline bold, italic, code and links, and leaves plain text alone", () => {
    expect(parseInline("Run `npm test` then **ship** it *now* via [docs](https://x.test/a)")).toEqual([
      { text: "Run " }, { text: "npm test", code: true }, { text: " then " }, { text: "ship", bold: true }, { text: " it " }, { text: "now", italic: true },
      { text: " via " }, { text: "docs" },
    ]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ text: "2 * 3 * 4" }]);
    expect(parseMarkdown("")).toEqual([]);
  });
});
