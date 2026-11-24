import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import {
  EFFORTS, EFFORT_BLURB, EFFORT_LABEL, MODEL_CATALOG, canonicalModel, describeChoice, effectiveModelChoice, modelInfo, modelLabel, offersModels,
  sameModel, switchImpact, switchOptions, type Agent, type Effort, type SessionMarkerCard, type Thread,
} from "@homebase/protocol";
import { mutate } from "../sync/session";
import { color, radius, space } from "../theme";
import { Field, Sheet } from "./Sheet";
import { Btn, Chip, Icon, T } from "./ui";

/**
 * Model and effort, the same on the phone and the desktop: a chip above the message box that always
 * says what the next reply runs on, a sheet to change it for this session, and the same fields on an
 * agent's page for its default. A scripted agent has no model; the chip says so instead of pretending.
 */

/** The text of the chip: "Sonnet 5.5 · High", or "Sonnet 5.5" when the effort is left to the CLI. */
export function choiceText(model: string | null, effort: Effort | null): string {
  return effort ? `${modelLabel(model)} · ${EFFORT_LABEL[effort]}` : modelLabel(model);
}

/** The offered models in catalogue order (most capable first), then anything the connector offers that the catalogue does not know. */
function offeredModels(agent: Agent): Array<{ id: string; label: string; blurb: string }> {
  const offered = (agent.models ?? []).map((m) => canonicalModel(m)!);
  const known = MODEL_CATALOG.filter((m) => offered.includes(m.id)).map((m) => ({ id: m.id, label: m.label, blurb: m.blurb }));
  const other = offered.filter((id) => !modelInfo(id)).map((id) => ({ id, label: id, blurb: "Offered by this agent's connector." }));
  return [...known, ...other];
}

/**
 * The fields themselves: one row per model and a row of effort chips. `inherit` adds a first choice
 * (value null) for "whatever the default is", worded by the caller.
 */
export function ModelFields({ agent, model, effort, onModel, onEffort, inherit }: {
  agent: Agent; model: string | null; effort: Effort | null; onModel: (m: string | null) => void; onEffort: (e: Effort | null) => void;
  inherit: { modelTitle: string; modelBody: string; effortLabel: string };
}) {
  const models = useMemo(() => offeredModels(agent), [agent]);
  const efforts = EFFORTS.filter((e) => (agent.efforts ?? EFFORTS).includes(e));
  const row = (key: string, selected: boolean, title: string, body: string, onPress: () => void) => (
    <Pressable key={key} onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${title}. ${body}`} testID={`model-${key}`}
      style={({ pressed, hovered }: any) => [st.option, selected && st.optionOn, hovered && !selected && { backgroundColor: color.surface2 }, pressed && { opacity: 0.8 }]}>
      <View style={{ flex: 1, gap: 1 }}>
        <T v="heading" style={{ fontSize: 15 }}>{title}</T>
        <T v="small" numberOfLines={2}>{body}</T>
      </View>
      <View style={[st.radio, selected && { borderColor: color.accent }]}>{selected ? <View style={st.radioDot} /> : null}</View>
    </Pressable>
  );
  return (
    <>
      <Field label="Model">
        <View style={{ gap: 6 }} accessibilityRole="radiogroup">
          {row("default", model === null, inherit.modelTitle, inherit.modelBody, () => onModel(null))}
          {models.map((m) => row(m.id, model !== null && sameModel(model, m.id), m.label, m.blurb, () => onModel(m.id)))}
        </View>
      </Field>
      <Field label="Effort" hint={effort ? EFFORT_BLURB[effort] : "How hard the model thinks before it answers. More effort is slower and uses more of your plan."}>
        <View style={st.wrap} accessibilityRole="radiogroup">
          <Chip label={inherit.effortLabel} selected={effort === null} onPress={() => onEffort(null)} />
          {efforts.map((e) => <Chip key={e} label={EFFORT_LABEL[e]} selected={effort === e} onPress={() => onEffort(e)} />)}
        </View>
      </Field>
    </>
  );
}

/** An agent's default model and effort, on its page. Applies as it is tapped, like the default mode. */
export function AgentModelDefaults({ agent }: { agent: Agent }) {
  if (!offersModels(agent)) {
    return (
      <View style={st.note}>
        <Icon name="cpu" size={14} tone={color.textMuted} />
        <T v="small" muted style={{ flex: 1 }}>{agent.name} is a scripted agent. It does not run on a model, so model and effort do not apply to it.</T>
      </View>
    );
  }
  const config = describeChoice(agent.configModel ?? null, agent.configEffort ?? null);
  const set = (patch: { model?: string | null; effort?: Effort | null }) => void mutate("model.set", { scope: "agent", id: agent.id, ...patch });
  return (
    <View style={{ gap: space.lg }}>
      <ModelFields agent={agent} model={agent.defaultModel ?? null} effort={agent.defaultEffort ?? null} onModel={(model) => set({ model })} onEffort={(effort) => set({ effort })}
        inherit={{
          modelTitle: `Connector setting (${modelLabel(agent.configModel ?? null)})`, modelBody: "Whatever this agent's connector is configured with.",
          effortLabel: agent.configEffort ? `Connector (${EFFORT_LABEL[agent.configEffort]})` : "Default",
        }} />
      <View style={st.note}>
        <Icon name="info" size={13} tone={color.textMuted} />
        <T v="small" muted style={{ flex: 1 }}>
          New sessions with {agent.name} start on this. A session can pick its own from its message box. Sessions that follow this default switch at their next message and keep
          their conversation; the session shows a line where it happens. With nothing chosen here the agent runs on {config}, as it always has.
        </T>
      </View>
    </View>
  );
}

/** The line a session shows where its model, effort or agent session changed. */
export function SessionMarker({ card, text }: { card: SessionMarkerCard; text: string }) {
  const fresh = card.kind === "fresh";
  return (
    <View style={st.marker} accessibilityRole="text" accessibilityLabel={text} testID={`session-marker-${card.kind}`}>
      <View style={st.markerLine} />
      <View style={st.markerBody}>
        <Icon name={fresh ? "refresh-cw" : card.kind === "folders" ? "folder" : "shuffle"} size={12} tone={fresh ? color.text : color.textDim} />
        <T v="small" tone={fresh ? color.text : color.textDim} style={{ fontSize: 12, flexShrink: 1, textAlign: "center" }}>{text}</T>
      </View>
      <View style={st.markerLine} />
    </View>
  );
}

/**
 * The chip above the message box and the sheet behind it. Before the first message the choice is
 * applied at once. In a session that already has a conversation, the owner is shown what each way of
 * applying it does (keep the conversation, or start fresh) and picks one; nothing is dropped silently.
 */
export function ModelSwitch({ thread, agent, live, liveModel, hasHistory }: {
  thread: Thread; agent: Agent;
  /** A run is in flight in this session, and the model it is on. */
  live: boolean; liveModel?: string | null;
  /** The agent has already run here, so there is a conversation to keep or to leave behind. */
  hasHistory: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [confirming, setConfirming] = useState(false);
  const scripted = !offersModels(agent);
  const now = effectiveModelChoice(agent, thread);
  const agentDefault = effectiveModelChoice(agent, null);
  useEffect(() => {
    if (!open) return;
    setModel(thread.model ?? null);
    setEffort(thread.effort ?? null);
    setConfirming(false);
    // Staged when the sheet opens; a sync of the same session must not reset what is being picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (scripted) {
    return (
      <>
        <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Scripted agent: no model. Tap for details." testID="model-switch" hitSlop={8}
          style={({ pressed, hovered }: any) => [st.pill, hovered && { backgroundColor: color.surface3 }, pressed && { opacity: 0.75 }]}>
          <Icon name="cpu" size={13} tone={color.textMuted} />
          <T v="small" muted style={st.pillText}>No model</T>
        </Pressable>
        <Sheet visible={open} title="Model and effort" subtitle={agent.name} onClose={() => setOpen(false)} testID="model-sheet">
          <View style={st.note}>
            <Icon name="cpu" size={14} tone={color.textMuted} />
            <T v="small" style={{ flex: 1 }}>{agent.name} is a scripted agent. It follows a fixed script instead of running on a model, so there is no model or effort to choose here.</T>
          </View>
          <Btn label="Done" onPress={() => setOpen(false)} />
        </Sheet>
      </>
    );
  }

  // What the staged choice comes to, with the defaults filled in, and how it differs from what runs now.
  const staged = effectiveModelChoice(agent, { model, effort });
  const impact = switchImpact(now, staged);
  const dirty = (model ?? null) !== (thread.model ?? null) || (effort ?? null) !== (thread.effort ?? null);
  const apply = (fresh: boolean) => {
    void mutate("model.set", { scope: "thread", id: thread.id, model, effort, ...(fresh ? { fresh: true } : {}) });
    setOpen(false);
  };
  const next = () => {
    // Nothing would actually change for the agent (for example the default spelled out): no question to ask.
    if (!hasHistory || (!impact.model && !impact.effort)) return apply(false);
    setConfirming(true);
  };
  const options = switchOptions(impact, staged);
  const target = describeChoice(staged.model, staged.effort);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`Model and effort: ${describeChoice(now.model, now.effort)}. Tap to change.`} testID="model-switch" hitSlop={8}
        style={({ pressed, hovered }: any) => [st.pill, hovered && { backgroundColor: color.surface3 }, pressed && { opacity: 0.75 }]}>
        <Icon name="cpu" size={13} tone={color.text} />
        <T v="small" tone={color.text} numberOfLines={1} style={st.pillText}>{choiceText(now.model, now.effort)}</T>
        <Icon name="chevron-up" size={13} tone={color.textMuted} />
      </Pressable>
      <Sheet visible={open} title={confirming ? `Switch to ${target}?` : "Model and effort"} subtitle={confirming ? `Now on ${describeChoice(now.model, now.effort)}` : `${agent.name} · this session`}
        onClose={() => setOpen(false)} testID="model-sheet">
        {confirming ? (
          <>
            {live ? (
              <View style={st.note} testID="model-live-note">
                <Icon name="zap" size={13} tone={color.p1} />
                <T v="small" style={{ flex: 1 }}>The agent is working right now on {modelLabel(liveModel ?? now.model)}. The change applies to your next message after it has finished.</T>
              </View>
            ) : null}
            <Pressable onPress={() => apply(false)} accessibilityRole="button" testID="model-keep"
              style={({ pressed, hovered }: any) => [st.choice, st.choicePrimary, hovered && { opacity: 0.94 }, pressed && { opacity: 0.8 }]}>
              <View style={st.choiceHead}><Icon name="message-square" size={16} tone={color.accentInk} /><T v="heading" tone={color.accentInk} style={{ flex: 1 }}>{options.keep.title}</T></View>
              <T v="small" tone={color.accentInk}>{options.keep.body}</T>
            </Pressable>
            <Pressable onPress={live ? undefined : () => apply(true)} disabled={live} accessibilityRole="button" accessibilityState={{ disabled: live }} testID="model-fresh"
              style={({ pressed, hovered }: any) => [st.choice, hovered && !live && { backgroundColor: color.surface2 }, pressed && { opacity: 0.8 }, live && { opacity: 0.45 }]}>
              <View style={st.choiceHead}><Icon name="refresh-cw" size={16} tone={color.text} /><T v="heading" style={{ flex: 1 }}>{options.fresh.title}</T></View>
              <T v="small">{options.fresh.body}</T>
              {live ? <T v="small" tone={color.p1}>Available when the agent has finished its current turn.</T> : null}
            </Pressable>
            <Btn kind="ghost" icon="arrow-left" label="Back, change nothing yet" onPress={() => setConfirming(false)} testID="model-back" />
          </>
        ) : (
          <>
            <ModelFields agent={agent} model={model} effort={effort} onModel={setModel} onEffort={setEffort}
              inherit={{
                modelTitle: `Agent default (${modelLabel(agentDefault.model)})`, modelBody: `Follow whatever ${agent.name} is set to.`,
                effortLabel: agentDefault.effort ? `Agent default (${EFFORT_LABEL[agentDefault.effort]})` : "Agent default",
              }} />
            <Btn kind="primary" icon="check" label={dirty ? `Use ${choiceText(staged.model, staged.effort)}` : "Done"} onPress={dirty ? next : () => setOpen(false)} testID="model-apply" />
            <View style={st.note}>
              <Icon name="info" size={13} tone={color.textMuted} />
              <T v="small" muted style={{ flex: 1 }}>
                {hasHistory
                  ? "This session already has a conversation. You will be asked whether to keep it before anything changes."
                  : "Nothing has been said here yet, so this simply sets what the first reply runs on."}
                {" "}Every device sees the change.
              </T>
            </View>
          </>
        )}
      </Sheet>
    </>
  );
}

const st = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: {
    height: 30, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface2,
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", flexShrink: 1, maxWidth: 220,
  },
  pillText: { fontFamily: "SpaceGrotesk_600SemiBold", fontSize: 13, lineHeight: 16, flexShrink: 1 },
  option: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg },
  optionOn: { borderColor: color.accent, backgroundColor: color.accentDim },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: color.borderStrong, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: color.accent },
  note: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  choice: { gap: 6, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg },
  choicePrimary: { backgroundColor: color.accent, borderColor: color.accent },
  choiceHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
  marker: { flexDirection: "row", alignItems: "center", gap: space.sm, marginVertical: space.sm },
  markerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: color.borderStrong, minWidth: 12 },
  markerBody: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, maxWidth: "82%" },
});
