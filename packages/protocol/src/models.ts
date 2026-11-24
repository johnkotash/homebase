import { z } from "zod";

/**
 * Model and effort for agents that run on Claude: the shared catalogue, the rule that decides what a
 * run starts with, and the words for telling the owner what a change will do.
 *
 * How it reaches the CLI (checked against Claude Code 2.1.319): `--model <alias or full name>` and
 * `--effort <low|medium|high|xhigh|max>`. Both are per launch, and HomeBase launches the CLI once per
 * run, so a session can change either between two messages: `--resume <session>` with another `--model`
 * keeps the conversation and reads it again without the prompt cache; another `--effort` keeps both.
 * No model or no effort chosen anywhere means the flag is left to the connector's own configuration,
 * which is how every agent ran before this existed.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;
export const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const EFFORT_BLURB: Record<Effort, string> = {
  low: "Quick answers and simple edits. Fastest and lightest.",
  medium: "A balance for everyday work.",
  high: "Thinks things through. Good for most real tasks.",
  xhigh: "Digs deep on hard coding and long tasks.",
  max: "Everything it has. Slowest; for when being right matters more than time.",
};

/** A model as the CLI takes it: an alias or a full name. Shaped so it is always one safe command-line word. */
export const ModelName = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._:@[\]-]*$/);

export interface ModelInfo {
  /** The full name passed to `--model`. */
  id: string;
  /** The CLI's alias for the newest model of this family. */
  alias: string;
  label: string;
  blurb: string;
}

/** The models HomeBase offers, most capable first. Full names, so what is picked is what runs. */
export const MODEL_CATALOG: ModelInfo[] = [
  { id: "claude-fable-5-2", alias: "fable", label: "Fable 5.2", blurb: "The most capable. For the hardest and longest work." },
  { id: "claude-opus-5-5", alias: "opus", label: "Opus 5.5", blurb: "Strong reasoning and coding for demanding work." },
  { id: "claude-sonnet-5-5", alias: "sonnet", label: "Sonnet 5.5", blurb: "Fast and capable. The everyday choice." },
  { id: "claude-haiku-5-5", alias: "haiku", label: "Haiku 5.5", blurb: "The quickest and lightest. For short, simple jobs." },
];

/** The catalogue entry for an alias, a full name, or a full name with a date or context suffix. Null when unknown. */
export function modelInfo(value: string | null | undefined): ModelInfo | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\[.*\]$/, "");
  return MODEL_CATALOG.find((m) => v === m.id || v === m.alias || v.startsWith(`${m.id}-`) || v.startsWith(`${m.id}@`)) ?? null;
}

/** One spelling per model, so "sonnet" and "claude-sonnet-5-5" compare equal. An unknown name is kept as written. */
export const canonicalModel = (value: string | null | undefined): string | null => (value ? modelInfo(value)?.id ?? value.trim() : null);
export const sameModel = (a: string | null | undefined, b: string | null | undefined) => canonicalModel(a) === canonicalModel(b);
export const modelLabel = (value: string | null | undefined): string => (value ? modelInfo(value)?.label ?? value : "Default model");

/** "Sonnet 5.5 · High". No effort chosen reads as the CLI's own default. */
export function describeChoice(model: string | null | undefined, effort: Effort | null | undefined): string {
  return `${modelLabel(model)} · ${effort ? EFFORT_LABEL[effort] : "Default effort"}`;
}

/** The parts of an agent that say what it offers and what it uses when nothing is chosen. */
export interface ModelAgent {
  /** Models the connector lets this agent run. Empty or missing: model and effort do not apply (a scripted agent). */
  models?: string[] | null;
  efforts?: Effort[] | null;
  /** What the connector itself is configured with. */
  configModel?: string | null;
  configEffort?: Effort | null;
  /** The owner's default for this agent. */
  defaultModel?: string | null;
  defaultEffort?: Effort | null;
}
export interface ModelThread {
  model?: string | null;
  effort?: Effort | null;
}

export const offersModels = (agent: ModelAgent | null | undefined): boolean => !!agent?.models?.length;

const offered = (agent: ModelAgent, model: unknown): string | null => {
  const p = ModelName.safeParse(model);
  if (!p.success) return null;
  const want = canonicalModel(p.data);
  return (agent.models ?? []).find((m) => canonicalModel(m) === want) ?? null;
};
const offeredEffort = (agent: ModelAgent, effort: unknown): Effort | null => {
  const p = Effort.safeParse(effort);
  return p.success && (agent.efforts ?? EFFORTS).includes(p.data) ? p.data : null;
};

/**
 * What the next run is asked to use: what was asked for this run, else the session's own choice, else
 * the owner's default for the agent. Null means "do not ask for anything": the connector's configuration
 * decides, as before. Never a model or an effort the connector did not offer.
 */
export function resolveModelChoice(agent: ModelAgent, thread?: ModelThread | null, asked?: { model?: unknown; effort?: unknown }): { model: string | null; effort: Effort | null } {
  if (!offersModels(agent)) return { model: null, effort: null };
  const model = offered(agent, asked?.model) ?? offered(agent, thread?.model) ?? offered(agent, agent.defaultModel);
  const effort = offeredEffort(agent, asked?.effort) ?? offeredEffort(agent, thread?.effort) ?? offeredEffort(agent, agent.defaultEffort);
  return { model, effort };
}

/** What will actually run, for showing it: the resolved choice, falling back to the connector's own setting. */
export function effectiveModelChoice(agent: ModelAgent, thread?: ModelThread | null): { model: string | null; effort: Effort | null; from: "session" | "agent" | "connector" } {
  const r = resolveModelChoice(agent, thread);
  const session = !!(offered(agent, thread?.model) || offeredEffort(agent, thread?.effort));
  const own = !!(offered(agent, agent.defaultModel) || offeredEffort(agent, agent.defaultEffort));
  return {
    model: canonicalModel(r.model ?? agent.configModel ?? null), effort: r.effort ?? agent.configEffort ?? null,
    from: session ? "session" : own ? "agent" : "connector",
  };
}

export interface SwitchImpact {
  model: boolean;
  effort: boolean;
}
/** What differs between two choices. */
export function switchImpact(from: { model: string | null; effort: Effort | null }, to: { model: string | null; effort: Effort | null }): SwitchImpact {
  return { model: !sameModel(from.model, to.model), effort: (from.effort ?? null) !== (to.effort ?? null) };
}

/**
 * The two ways to apply a change to a session that already has a conversation, in the words the owner
 * reads before choosing. Kept here so both clients, and the tests, say exactly the same thing.
 */
export function switchOptions(impact: SwitchImpact, to: { model: string | null; effort: Effort | null }): { keep: { title: string; body: string }; fresh: { title: string; body: string } } {
  const target = describeChoice(to.model, to.effort);
  const keep = impact.model
    ? "The agent keeps everything said so far. Its next reply reads the whole conversation again on the new model, without the cache, "
      + "so that one turn is slower and uses more of your plan. After that it is back to normal. "
      + "The new model sees the messages and tool results, not the earlier model's private reasoning."
    : "The agent keeps everything said so far. The new effort applies from its next reply.";
  return {
    keep: { title: "Keep the conversation", body: keep },
    fresh: {
      title: "Start fresh",
      body: `A new agent session on ${target}. The first turn is quick and cheap, but the agent will not remember this conversation. `
        + "The messages stay here for you to read. Ask for a recap first if you want something to hand over.",
    },
  };
}

/** The line a session shows where its model, effort or agent session changed. */
export function switchMarkerText(kind: "switch" | "fresh", model: string | null, effort: Effort | null, folder?: string | null): string {
  const target = describeChoice(model, effort);
  return kind === "fresh"
    ? `New agent session ${folder ? `in ${folder}, ` : ""}on ${target}. The agent does not see the messages above.`
    : `Now on ${target}. The conversation is kept.`;
}
