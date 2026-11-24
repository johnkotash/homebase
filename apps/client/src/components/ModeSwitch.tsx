import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PERMISSION_MODES, type PermissionMode } from "@homebase/protocol";
import { MAIL_MODE, MAIL_SECRETS_NOTE, MODE, NOTES_MODE, NOTES_SECRETS_NOTE, SECRETS_NOTE } from "../modes";
import { color, radius, space } from "../theme";
import { Icon, T } from "./ui";

/** Small label for a mode, used on runs, approvals and timelines. */
export function ModeTag({ mode }: { mode: PermissionMode }) {
  const m = MODE[mode];
  return (
    <View style={st.tag} accessibilityLabel={`${m.label} mode`}>
      <Icon name={m.icon} size={11} tone={color.textDim} />
      <T v="small" style={st.tagText}>{m.label.toUpperCase()}</T>
    </View>
  );
}

/** The three modes as selectable rows with their explanations. */
export function ModeOptions({ value, modes, onChange, inherit, mail, notes }: {
  value: PermissionMode | null; modes: PermissionMode[]; onChange: (m: PermissionMode | null) => void;
  /** The agent works in a mailbox: describe the modes in terms of drafts and sends. */
  mail?: boolean;
  notes?: boolean;
  /** When set, a first row offers "follow the agent's default" (value null). */
  inherit?: { mode: PermissionMode };
}) {
  const row = (key: string, selected: boolean, icon: React.ComponentProps<typeof Icon>["name"], title: string, body: string, onPress: () => void) => (
    <Pressable key={key} onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={`${title}. ${body}`} testID={`mode-${key}`}
      style={({ pressed, hovered }: any) => [st.option, selected && st.optionOn, hovered && !selected && { backgroundColor: color.surface2 }, pressed && { opacity: 0.8 }]}>
      <View style={[st.optionIcon, selected && { backgroundColor: color.accent }]}><Icon name={icon} size={16} tone={selected ? color.accentInk : color.textDim} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="heading" style={{ fontSize: 15 }}>{title}</T>
        <T v="small">{body}</T>
      </View>
      <View style={[st.radio, selected && { borderColor: color.accent }]}>{selected ? <View style={st.radioDot} /> : null}</View>
    </Pressable>
  );
  return (
    <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
      {inherit ? row("default", value === null, "corner-down-right", `Agent default (${MODE[inherit.mode].label})`, "Follow whatever the agent's default mode is.", () => onChange(null)) : null}
      {PERMISSION_MODES.filter((m) => modes.includes(m)).map((m) => row(m, value === m, MODE[m].icon, MODE[m].label, notes && m !== "plan" ? NOTES_MODE[m].body : mail && m !== "plan" ? MAIL_MODE[m].body : MODE[m].body, () => onChange(m)))}
    </View>
  );
}

/**
 * The compact mode switch for a chat: shows the mode the next run starts in, and opens a sheet that
 * explains the three modes and changes it.
 */
export function ModeSwitch({ mode, override, agentDefault, modes, onChange, live, liveMode, mail, notes }: {
  mail?: boolean;
  notes?: boolean;
  /** The mode in effect for the next run. */
  mode: PermissionMode;
  /** The chat's own choice, or null when it follows the agent. */
  override: PermissionMode | null;
  agentDefault: PermissionMode;
  modes: PermissionMode[];
  onChange: (m: PermissionMode | null) => void;
  /** A run is in flight in this chat. */
  live?: boolean;
  liveMode?: PermissionMode | null;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const m = MODE[mode];
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`Permission mode: ${m.label}. Tap to change.`} testID="mode-switch" hitSlop={8}
        style={({ pressed, hovered }: any) => [st.pill, hovered && { backgroundColor: color.surface3 }, pressed && { opacity: 0.75 }]}>
        <Icon name={m.icon} size={13} tone={color.text} />
        <T v="small" tone={color.text} style={st.pillText}>{m.label}</T>
        <Icon name="chevron-up" size={13} tone={color.textMuted} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
        <Pressable style={st.scrim} onPress={() => setOpen(false)} accessibilityLabel="Close">
          <Pressable style={[st.sheet, { paddingBottom: Math.max(insets.bottom, space.lg) }]} onPress={() => {}} accessibilityViewIsModal>
            <View style={st.grabber} />
            <View style={st.sheetHead}>
              <T v="title" style={{ flex: 1 }} accessibilityRole="header">Permission mode</T>
              <Pressable onPress={() => setOpen(false)} hitSlop={12} accessibilityRole="button" accessibilityLabel="Done"><T tone={color.accent} style={{ fontFamily: "SpaceGrotesk_600SemiBold" }}>Done</T></Pressable>
            </View>
            <T v="small" style={{ marginBottom: space.md }}>How much this agent may do in this chat without asking you.</T>
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space.md }}>
              <ModeOptions value={override} modes={modes} inherit={{ mode: agentDefault }} onChange={(next) => onChange(next)} mail={mail} notes={notes} />
              <View style={st.note}>
                <Icon name="info" size={13} tone={color.textMuted} />
                <T v="small" muted style={{ flex: 1 }}>
                  {live
                    ? `A run is live${liveMode ? ` in ${MODE[liveMode].label}` : ""}. Switching between Manual and Auto applies to what it asks for next${mail ? "." : "; Plan starts with your next message."}`
                    : "Applies to the next run in this chat. Every device sees the change."}
                  {" "}{notes ? NOTES_SECRETS_NOTE : mail ? MAIL_SECRETS_NOTE : SECRETS_NOTE}
                </T>
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const st = StyleSheet.create({
  tag: { height: 22, paddingHorizontal: 8, borderRadius: 6, flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", borderWidth: 1, borderColor: color.borderStrong },
  tagText: { fontFamily: "SpaceGrotesk_600SemiBold", fontSize: 11, letterSpacing: 0.4, color: color.textDim, lineHeight: 14 },
  pill: {
    height: 30, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.surface2,
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
  },
  pillText: { fontFamily: "SpaceGrotesk_600SemiBold", fontSize: 13, lineHeight: 16 },
  scrim: { flex: 1, backgroundColor: color.overlay, justifyContent: "flex-end", alignItems: "center" },
  sheet: {
    width: "100%", maxWidth: 560, maxHeight: "88%", backgroundColor: color.surface, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderWidth: 1, borderBottomWidth: 0, borderColor: color.borderStrong, paddingHorizontal: space.lg, paddingTop: space.sm,
  },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: color.borderStrong, marginBottom: space.md },
  sheetHead: { flexDirection: "row", alignItems: "center", marginBottom: 2 },
  option: { flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg },
  optionOn: { borderColor: color.accent, backgroundColor: color.accentDim },
  optionIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: color.surface3, alignItems: "center", justifyContent: "center" },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: color.borderStrong, alignItems: "center", justifyContent: "center", marginTop: 4 },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.accent },
  note: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingHorizontal: 2, paddingBottom: space.sm },
});
