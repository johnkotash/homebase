import { describe, expect, it } from "vitest";
import {
  EFFORTS, ENTITY_SCHEMAS, Effort, MODEL_CATALOG, MUTATIONS, ModelName, SessionMarkerCard, canonicalModel, describeChoice, effectiveModelChoice, modelInfo, modelLabel,
  offersModels, resolveModelChoice, sameModel, switchImpact, switchMarkerText, switchOptions, type ModelAgent,
} from "../src";

const IDS = ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const claude: ModelAgent = { models: IDS, efforts: [...EFFORTS], configModel: "claude-sonnet-5-5", configEffort: null, defaultModel: null, defaultEffort: null };
const scripted: ModelAgent = { models: null, efforts: null };

describe("the model catalogue", () => {
  it("lists the four current models by their full names, most capable first, with the CLI's aliases", () => {
    expect(MODEL_CATALOG.map((m) => m.id)).toEqual(IDS);
    expect(MODEL_CATALOG.map((m) => m.alias)).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(MODEL_CATALOG.map((m) => m.label)).toEqual(["Fable 5.2", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    expect([...EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]); // what `claude --effort` accepts
  });

  it("recognises an alias, a full name and a full name with a suffix as the same model", () => {
    expect(modelInfo("sonnet")?.id).toBe("claude-sonnet-5-5");
    expect(modelInfo("Claude-Sonnet-5-5")?.id).toBe("claude-sonnet-5-5");
    expect(modelInfo("claude-sonnet-5-5-20261001")?.id).toBe("claude-sonnet-5-5");
    expect(modelInfo("claude-opus-5-5[1m]")?.id).toBe("claude-opus-5-5");
    expect(modelInfo("claude-sonnet-5")).toBeNull(); // an older model is not silently treated as the current one
    expect(modelInfo("gpt-9")).toBeNull();
    expect(modelInfo(null)).toBeNull();
    expect(sameModel("sonnet", "claude-sonnet-5-5")).toBe(true);
    expect(sameModel("sonnet", "opus")).toBe(false);
    expect(sameModel(null, null)).toBe(true);
    expect(canonicalModel("haiku")).toBe("claude-haiku-5-5");
    expect(canonicalModel("some-custom-model")).toBe("some-custom-model");
  });

  it("labels a choice for the owner", () => {
    expect(modelLabel("opus")).toBe("Opus 5.5");
    expect(modelLabel("some-custom-model")).toBe("some-custom-model");
    expect(modelLabel(null)).toBe("Default model");
    expect(describeChoice("claude-fable-5-2", "xhigh")).toBe("Fable 5.2 · Extra high");
    expect(describeChoice("sonnet", null)).toBe("Sonnet 5.5 · Default effort");
  });

  it("a model name is always one safe command-line word", () => {
    for (const ok of ["sonnet", "claude-opus-5-5", "claude-sonnet-5-5[1m]", "claude-haiku-5-5@20261001", "us.anthropic.claude-opus-5-5-v1:0"]) expect(ModelName.safeParse(ok).success).toBe(true);
    for (const bad of ["", "--dangerously-skip-permissions", "-p", "sonnet --resume x", "son net", "a;rm -rf /", "$(whoami)", "x".repeat(81), "モデル"]) expect(ModelName.safeParse(bad).success).toBe(false);
    expect(Effort.safeParse("max").success).toBe(true);
    expect(Effort.safeParse("ultra").success).toBe(false);
  });
});

describe("what a run starts with", () => {
  it("nothing chosen anywhere asks for nothing: the connector's own setting runs, as before", () => {
    expect(resolveModelChoice(claude)).toEqual({ model: null, effort: null });
    expect(resolveModelChoice(claude, { model: null, effort: null })).toEqual({ model: null, effort: null });
    expect(resolveModelChoice(claude, {})).toEqual({ model: null, effort: null }); // a session from before model choice existed
    expect(effectiveModelChoice(claude)).toEqual({ model: "claude-sonnet-5-5", effort: null, from: "connector" });
  });

  it("prefers this run's own, then the session's, then the owner's default for the agent", () => {
    const agent = { ...claude, defaultModel: "claude-opus-5-5", defaultEffort: "high" as const };
    expect(resolveModelChoice(agent)).toEqual({ model: "claude-opus-5-5", effort: "high" });
    expect(resolveModelChoice(agent, { model: "claude-haiku-5-5", effort: null })).toEqual({ model: "claude-haiku-5-5", effort: "high" }); // each field falls back on its own
    expect(resolveModelChoice(agent, { model: null, effort: "low" })).toEqual({ model: "claude-opus-5-5", effort: "low" });
    expect(resolveModelChoice(agent, { model: "claude-haiku-5-5", effort: "low" }, { model: "fable", effort: "max" })).toEqual({ model: "claude-fable-5-2", effort: "max" });
    expect(effectiveModelChoice(agent)).toMatchObject({ model: "claude-opus-5-5", effort: "high", from: "agent" });
    expect(effectiveModelChoice(agent, { model: "claude-haiku-5-5" })).toMatchObject({ model: "claude-haiku-5-5", effort: "high", from: "session" });
  });

  it("never returns a model or an effort the connector did not offer", () => {
    const narrow: ModelAgent = { models: ["claude-sonnet-5-5", "claude-haiku-5-5"], efforts: ["low", "medium"], configModel: "claude-sonnet-5-5", defaultModel: "claude-opus-5-5", defaultEffort: "max" };
    expect(resolveModelChoice(narrow)).toEqual({ model: null, effort: null }); // a default the connector no longer offers is ignored
    expect(resolveModelChoice(narrow, { model: "claude-fable-5-2", effort: "xhigh" })).toEqual({ model: null, effort: null });
    expect(resolveModelChoice(narrow, { model: "haiku", effort: "low" })).toEqual({ model: "claude-haiku-5-5", effort: "low" }); // an alias resolves to the offered spelling
    expect(resolveModelChoice(narrow, null, { model: "--resume", effort: "bogus" })).toEqual({ model: null, effort: null });
    expect(resolveModelChoice(narrow, null, { model: 42, effort: {} })).toEqual({ model: null, effort: null });
  });

  it("a scripted agent has no model and no effort, whatever is asked", () => {
    expect(offersModels(scripted)).toBe(false);
    expect(offersModels({ models: [] })).toBe(false);
    expect(offersModels(claude)).toBe(true);
    expect(resolveModelChoice(scripted, { model: "claude-opus-5-5", effort: "high" }, { model: "opus", effort: "max" })).toEqual({ model: null, effort: null });
    expect(effectiveModelChoice(scripted)).toEqual({ model: null, effort: null, from: "connector" });
  });
});

describe("telling the owner what a switch will do", () => {
  it("knows what differs between two choices", () => {
    const a = { model: "claude-sonnet-5-5", effort: null };
    expect(switchImpact(a, { model: "sonnet", effort: null })).toEqual({ model: false, effort: false }); // the same model, spelled differently
    expect(switchImpact(a, { model: "claude-opus-5-5", effort: null })).toEqual({ model: true, effort: false });
    expect(switchImpact(a, { model: "claude-sonnet-5-5", effort: "high" })).toEqual({ model: false, effort: true });
    expect(switchImpact(a, { model: "claude-haiku-5-5", effort: "low" })).toEqual({ model: true, effort: true });
  });

  it("a new model: keeping the conversation costs one slower, uncached turn; starting fresh loses it", () => {
    const o = switchOptions({ model: true, effort: false }, { model: "claude-opus-5-5", effort: "high" });
    expect(o.keep.title).toBe("Keep the conversation");
    expect(o.keep.body).toMatch(/keeps everything said so far/);
    expect(o.keep.body).toMatch(/reads the whole conversation again on the new model, without the cache/);
    expect(o.keep.body).toMatch(/slower and uses more of your plan/);
    expect(o.keep.body).toMatch(/not the earlier model's private reasoning/);
    expect(o.fresh.title).toBe("Start fresh");
    expect(o.fresh.body).toMatch(/A new agent session on Opus 5\.5 · High/);
    expect(o.fresh.body).toMatch(/will not remember this conversation/);
    expect(o.fresh.body).toMatch(/The messages stay here for you to read/);
  });

  it("only a new effort: the conversation is kept and nothing is said about the cache", () => {
    const o = switchOptions({ model: false, effort: true }, { model: "claude-sonnet-5-5", effort: "max" });
    expect(o.keep.body).toBe("The agent keeps everything said so far. The new effort applies from its next reply.");
    expect(o.fresh.body).toMatch(/will not remember this conversation/);
  });

  it("the line in the session says which of the two happened", () => {
    expect(switchMarkerText("switch", "claude-opus-5-5", "high")).toBe("Now on Opus 5.5 · High. The conversation is kept.");
    expect(switchMarkerText("fresh", "claude-haiku-5-5", null)).toBe("New agent session on Haiku 5.5 · Default effort. The agent does not see the messages above.");
  });
});

describe("schemas", () => {
  const agent = { id: "agt_1", connectorId: null, key: "claude", name: "Claude agent", kind: "claude", description: "", capabilities: [], workspaces: [], permissionProfile: "strict", status: "online", updatedAt: 1 };
  const thread = { id: "thr_1", title: "t", agentId: "agt_1", lastMessageAt: null, pinned: false, archived: false, createdBy: null, createdAt: 1, updatedAt: 1 };
  const run = {
    id: "run_1", agentId: "agt_1", threadId: "thr_1", prompt: "p", status: "queued", sessionRef: null, summary: null, error: null, costUsd: null, numTurns: null, durationMs: null,
    lastEventIdx: -1, startedBy: null, cwd: null, createdAt: 1, startedAt: null, endedAt: null, updatedAt: 1,
  };

  it("agents, sessions and runs from before model choice are still valid, and so are ones with it", () => {
    expect(ENTITY_SCHEMAS.agents.safeParse(agent).success).toBe(true);
    expect(ENTITY_SCHEMAS.threads.safeParse(thread).success).toBe(true);
    expect(ENTITY_SCHEMAS.runs.safeParse(run).success).toBe(true);
    expect(ENTITY_SCHEMAS.agents.safeParse({ ...agent, models: IDS, efforts: [...EFFORTS], configModel: "sonnet", configEffort: null, defaultModel: "claude-opus-5-5", defaultEffort: "high" }).success).toBe(true);
    expect(ENTITY_SCHEMAS.agents.safeParse({ ...agent, models: null, efforts: null, configModel: null, configEffort: null, defaultModel: null, defaultEffort: null }).success).toBe(true);
    expect(ENTITY_SCHEMAS.threads.safeParse({ ...thread, model: "claude-haiku-5-5", effort: "low", sessionResetAt: 5 }).success).toBe(true);
    expect(ENTITY_SCHEMAS.runs.safeParse({ ...run, model: "claude-sonnet-5-5-20261001", effort: "xhigh" }).success).toBe(true);
    expect(ENTITY_SCHEMAS.threads.safeParse({ ...thread, effort: "ultra" }).success).toBe(false);
    expect(ENTITY_SCHEMAS.threads.safeParse({ ...thread, model: "--evil flag" }).success).toBe(false);
  });

  it("a session marker rides on a system message", () => {
    const card = { type: "session_marker", kind: "fresh", model: "claude-opus-5-5", effort: null };
    expect(SessionMarkerCard.safeParse(card).success).toBe(true);
    expect(SessionMarkerCard.safeParse({ ...card, kind: "silently" }).success).toBe(false);
    const message = { id: "msg_1", threadId: "thr_1", role: "system", text: "t", source: "agent", runId: "run_1", authorDeviceId: null, createdAt: 1, card };
    expect(ENTITY_SCHEMAS.messages.safeParse(message).success).toBe(true);
  });

  it("model.set takes a scope, and leaves alone what it is not given", () => {
    const m = MUTATIONS["model.set"];
    expect(m.safeParse({ scope: "thread", id: "thr_1", model: "claude-opus-5-5" }).success).toBe(true);
    expect(m.safeParse({ scope: "thread", id: "thr_1", effort: null, fresh: true }).success).toBe(true);
    expect(m.safeParse({ scope: "agent", id: "agt_1", model: null, effort: "max" }).success).toBe(true);
    expect(m.safeParse({ scope: "thread", id: "thr_1", model: "opus; rm -rf /" }).success).toBe(false);
    expect(m.safeParse({ scope: "thread", id: "thr_1", effort: "extreme" }).success).toBe(false);
    expect(m.safeParse({ scope: "workspace", id: "x", model: "opus" }).success).toBe(false);
    expect(MUTATIONS["run.start"].safeParse({ runId: "r", agentId: "a", prompt: "p", options: { model: "haiku", effort: "low" } }).success).toBe(true);
  });
});
