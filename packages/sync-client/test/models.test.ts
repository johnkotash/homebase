import { describe, expect, it } from "vitest";
import { EFFORTS, type Agent, type Thread } from "@homebase/protocol";
import { applyOptimistic, emptyMaps } from "../src";

const agent = (id: string, models: string[] | null): Agent => ({
  id, connectorId: "con_1", key: id, name: id, kind: models ? "claude" : "mock", description: "", capabilities: [], workspaces: [], permissionProfile: "strict",
  status: "online", updatedAt: 1, models, efforts: models ? [...EFFORTS] : null, configModel: models ? "claude-sonnet-5-5" : null, defaultModel: null, defaultEffort: null,
});
const thread = (id: string, agentId: string | null): Thread => ({
  id, title: "t", agentId, lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 1,
});

function server() {
  const maps = emptyMaps();
  maps.agents = { agt_claude: agent("agt_claude", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]), agt_dev: agent("agt_dev", null) };
  maps.threads = { thr_1: thread("thr_1", "agt_claude"), thr_dev: thread("thr_dev", "agt_dev"), thr_scratch: thread("thr_scratch", null) };
  return maps;
}
const m = (args: unknown, at: number) => ({ id: `m${at}`, name: "model.set" as const, args, at });

describe("model.set, predicted on the device", () => {
  it("a session's choice shows at once, and a field that is not sent is left alone", () => {
    const s = server();
    let out = applyOptimistic(s, [m({ scope: "thread", id: "thr_1", model: "opus", effort: "high" }, 5)], "dev_1");
    expect(out.threads.thr_1).toMatchObject({ model: "claude-opus-5-5", effort: "high", updatedAt: 5 }); // the alias becomes the offered name
    expect(out.threads.thr_1.sessionResetAt ?? null).toBeNull();
    out = applyOptimistic(s, [m({ scope: "thread", id: "thr_1", model: "claude-opus-5-5", effort: "high" }, 5), m({ scope: "thread", id: "thr_1", effort: null }, 6)], "dev_1");
    expect(out.threads.thr_1).toMatchObject({ model: "claude-opus-5-5", effort: null });
    expect(s.threads.thr_1.model).toBeUndefined(); // hub-confirmed rows are not touched
  });

  it("start fresh stamps the session with when it was asked", () => {
    const out = applyOptimistic(server(), [m({ scope: "thread", id: "thr_1", model: "claude-haiku-5-5", fresh: true }, 9)], "dev_1");
    expect(out.threads.thr_1).toMatchObject({ model: "claude-haiku-5-5", sessionResetAt: 9 });
  });

  it("an agent's default shows at once", () => {
    const out = applyOptimistic(server(), [m({ scope: "agent", id: "agt_claude", model: "claude-haiku-5-5", effort: "low" }, 5), m({ scope: "agent", id: "agt_claude", model: null }, 6)], "dev_1");
    expect(out.agents.agt_claude).toMatchObject({ defaultModel: null, defaultEffort: "low" });
  });

  it("shows nothing the hub would refuse: a model that is not offered, a scripted agent, a session with no agent", () => {
    const s = server();
    const out = applyOptimistic(s, [
      m({ scope: "thread", id: "thr_1", model: "claude-fable-5-2" }, 1),
      m({ scope: "thread", id: "thr_dev", model: "claude-opus-5-5" }, 2),
      m({ scope: "thread", id: "thr_scratch", effort: "max" }, 3),
      m({ scope: "agent", id: "agt_dev", effort: "max" }, 4),
      m({ scope: "thread", id: "thr_gone", model: "claude-opus-5-5" }, 5),
    ], "dev_1");
    expect(out.threads).toEqual(s.threads);
    expect(out.agents).toEqual(s.agents);
  });
});
