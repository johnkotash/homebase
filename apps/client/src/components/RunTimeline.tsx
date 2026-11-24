import React, { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { MAKER_LABEL, type RunEvent } from "@homebase/protocol";
import { clock } from "../format";
import { imageStepTitle, toolLabel } from "../images";
import { color, radius, space, tint } from "../theme";
import { ToneText } from "./Sheet";
import { Icon, T, type IconName } from "./ui";
import { BrowserStepShot } from "./BrowserShot";
import { browserToolWords } from "../browser";

interface Step {
  key: string;
  at: number;
  kind: "text" | "tool" | "error" | "system" | "result" | "thinking" | "auto" | "blocked" | "mode";
  text?: string;
  /** Why the policy decided this without asking. */
  reason?: string;
  mode?: string;
  tool?: string;
  title?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  pending?: boolean;
  /** Replaces the kind's own label: the provider that did an image step ("OpenAI", "Claude"), or "Images" for a routing note. */
  label?: string;
  /** A step in the browser: the small picture of the page after it, when one was kept. */
  shotId?: string;
}

/** Tool calls and their results are folded into one step, matched by toolUseId. */
function toSteps(events: RunEvent[]): Step[] {
  const steps: Step[] = [];
  const byTool = new Map<string, Step>();
  for (const e of events) {
    const d = e.data as any;
    if (e.kind === "tool_call") {
      // An image tool belongs to a provider; the step says whose work it is.
      const maker = toolLabel(d.tool).maker;
      const s: Step = { key: `e${e.idx}`, at: e.at, kind: "tool", tool: d.tool, title: d.title, input: d.input, pending: true, label: maker ? MAKER_LABEL[maker] : undefined };
      if (d.toolUseId) byTool.set(d.toolUseId, s);
      steps.push(s);
    } else if (e.kind === "tool_result") {
      const s = d.toolUseId ? byTool.get(d.toolUseId) : undefined;
      if (s) Object.assign(s, { output: String(d.output ?? ""), isError: !!d.isError, pending: false });
      else steps.push({ key: `e${e.idx}`, at: e.at, kind: "tool", tool: "result", output: String(d.output ?? ""), isError: !!d.isError });
    } else if (e.kind === "text") steps.push({ key: `e${e.idx}`, at: e.at, kind: "text", text: String(d.text ?? "") });
    else if (e.kind === "error") steps.push({ key: `e${e.idx}`, at: e.at, kind: "error", text: String(d.message ?? "Error") });
    else if (e.kind === "result") steps.push({ key: `e${e.idx}`, at: e.at, kind: "result", text: String(d.summary ?? "Finished") });
    else if (e.kind === "thinking") steps.push({ key: `e${e.idx}`, at: e.at, kind: "thinking", text: String(d.text ?? "") });
    else if (e.kind === "system") {
      // Policy decisions made without the owner get their own look, so a run can be audited at a glance.
      const kind: Step["kind"] = d.decision === "auto_approved" ? "auto" : d.decision === "blocked" ? "blocked" : d.modeChanged || d.decision ? "mode" : "system";
      const text = kind === "auto" || kind === "blocked" ? String(d.title ?? d.message ?? "") : String(d.text ?? d.message ?? "");
      // Image steps carry the maker the connector stamped (a finished image, or one that was not made) or are routing notes.
      const maker = d.imageCard?.maker ?? d.imageIssue?.maker;
      const label = maker === "openai" || maker === "claude" ? MAKER_LABEL[maker as "openai" | "claude"] : d.imageRoute ? "Images" : undefined;
      steps.push({ key: `e${e.idx}`, at: e.at, kind, text, reason: typeof d.reason === "string" ? d.reason : undefined, mode: typeof d.mode === "string" ? d.mode : undefined, label });
      // What the agent did in the browser, with the picture the browser took of the page.
      if (d.browser && typeof d.browser === "object") Object.assign(steps[steps.length - 1], { label: "Browser", shotId: typeof d.browser.shotId === "string" ? d.browser.shotId : undefined });
    }
  }
  return steps;
}

const META: Record<Step["kind"], { icon: IconName; tone: string; label: string }> = {
  text: { icon: "message-square", tone: color.text, label: "Agent" },
  tool: { icon: "terminal", tone: color.p2, label: "Tool" },
  error: { icon: "alert-octagon", tone: color.danger, label: "Error" },
  system: { icon: "info", tone: color.textMuted, label: "System" },
  result: { icon: "flag", tone: color.ok, label: "Result" },
  thinking: { icon: "more-horizontal", tone: color.textMuted, label: "Thinking" },
  auto: { icon: "check-circle", tone: color.ok, label: "Auto-approved" },
  blocked: { icon: "slash", tone: color.danger, label: "Blocked by policy" },
  mode: { icon: "sliders", tone: color.textDim, label: "Mode" },
};

function ToolStep({ s }: { s: Step }) {
  const [open, setOpen] = useState(false);
  const tone = s.isError ? color.danger : color.p2;
  return (
    <View style={[st.tool, { borderColor: tint(tone, 0.3) }]}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${s.tool}: ${s.title ?? ""}`} style={st.toolHead}>
        <View style={[st.toolName, { backgroundColor: tint(tone, 0.14) }]}><T v="mono" tone={tone} style={{ fontSize: 12 }}>{browserToolWords(s.tool, s.input)?.label ?? toolLabel(s.tool).label}</T></View>
        {/* An image step is titled with the image's name or brief, not the tool's id. */}
        <T v="small" style={{ flex: 1 }} numberOfLines={1} tone={color.text}>{browserToolWords(s.tool, s.input)?.title ?? imageStepTitle(s.tool, s.input) ?? s.title ?? (typeof (s.input as any)?.command === "string" ? (s.input as any).command : "")}</T>
        {s.pending ? <T v="small" tone={color.p1}>running</T> : <Icon name={s.isError ? "x" : "check"} size={14} tone={s.isError ? color.danger : color.ok} />}
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} />
      </Pressable>
      {open ? (
        <View style={st.toolBody}>
          <T v="micro">Input</T>
          <View style={st.code}><T v="mono" selectable>{typeof s.input === "string" ? s.input : JSON.stringify(s.input ?? {}, null, 2)}</T></View>
          {s.output != null ? (
            <>
              <T v="micro" style={{ marginTop: space.sm }}>Output</T>
              <View style={st.code}><T v="mono" selectable tone={s.isError ? color.danger : color.textDim}>{s.output || "(empty)"}</T></View>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function RunTimeline({ events, streaming }: { events: RunEvent[]; streaming?: string }) {
  const steps = useMemo(() => toSteps(events), [events]);
  return (
    <View>
      {steps.map((s, i) => {
        const m = META[s.kind];
        const last = i === steps.length - 1 && !streaming;
        return (
          <View key={s.key} style={st.step}>
            <View style={st.gutter}>
              <View style={[st.node, { borderColor: tint(m.tone, 0.5) }]}><Icon name={m.icon} size={12} tone={m.tone} /></View>
              {!last ? <View style={st.line} /> : null}
            </View>
            <View style={st.body}>
              <View style={st.meta}>
                <T v="micro" tone={m.tone === color.text ? color.textDim : m.tone}>{s.kind === "auto" && s.mode ? `${m.label} · ${s.mode} mode` : s.label ?? m.label}</T>
                <T v="small" muted style={{ fontSize: 11 }}>{clock(s.at)}</T>
              </View>
              {s.kind === "tool" ? <ToolStep s={s} /> : <T selectable tone={s.kind === "error" || s.kind === "blocked" ? color.danger : s.kind === "text" || s.kind === "auto" ? color.text : color.textDim}>{s.kind === "text" ? <ToneText text={s.text ?? ""} /> : s.text}</T>}
              {(s.kind === "auto" || s.kind === "blocked") && s.reason ? <T v="small" muted>{s.reason}</T> : null}
              {s.shotId ? <BrowserStepShot id={s.shotId} label={s.text ?? "The page"} /> : null}
            </View>
          </View>
        );
      })}
      {streaming ? (
        <View style={st.step}>
          <View style={st.gutter}><View style={[st.node, { borderColor: color.accent }]}><Icon name="edit-2" size={12} tone={color.accent} /></View></View>
          <View style={st.body}><T v="micro" tone={color.accent}>Writing</T><T tone={color.textDim}><ToneText text={streaming} lenient />▍</T></View>
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  step: { flexDirection: "row", gap: space.md },
  gutter: { width: 26, alignItems: "center" },
  node: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, backgroundColor: color.surface, alignItems: "center", justifyContent: "center" },
  line: { width: 1, flex: 1, backgroundColor: color.border, marginVertical: 2 },
  body: { flex: 1, minWidth: 0, paddingBottom: space.lg, gap: 4 },
  meta: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 26 },
  tool: { borderWidth: 1, borderRadius: radius.md, backgroundColor: color.surface, overflow: "hidden" },
  toolHead: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 48, paddingHorizontal: space.md },
  toolName: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5 },
  toolBody: { padding: space.md, paddingTop: 0, gap: 4 },
  code: { backgroundColor: color.bg, borderRadius: radius.sm, padding: space.md, borderWidth: 1, borderColor: color.border },
});
