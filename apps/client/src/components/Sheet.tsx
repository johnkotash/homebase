import React from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parseTones } from "@homebase/protocol";
import { useLayout } from "../layout/Shell";
import { color, radius, space, toneColor } from "../theme";
import { IconBtn, T } from "./ui";

/**
 * One modal for every small task (file a session, edit a project, start a session): a sheet from the
 * bottom on a phone, a centred dialog on a wide window. Same content and same controls on both.
 */
export function Sheet({ visible, title, subtitle, onClose, children, testID }: {
  visible: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const { wide, height } = useLayout();
  return (
    <Modal visible={visible} transparent animationType={wide ? "fade" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={[st.scrim, wide && st.scrimWide]} behavior={Platform.OS === "web" ? undefined : "padding"}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={`Close ${title}`} />
        <View testID={testID} accessibilityViewIsModal
          style={[st.panel, wide ? st.dialog : st.bottom, { maxHeight: Math.max(320, height - insets.top - 48) }, !wide && { paddingBottom: Math.max(insets.bottom, space.lg) }]}>
          {wide ? null : <View style={st.grabber} />}
          <View style={st.head}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T v="heading" numberOfLines={1} accessibilityRole="header">{title}</T>
              {subtitle ? <T v="small" muted numberOfLines={1}>{subtitle}</T> : null}
            </View>
            <IconBtn icon="x" label="Close" onPress={onClose} style={{ marginRight: -8 }} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={st.body}>{children}</ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A labelled group inside a sheet. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <T v="micro">{label}</T>
      {children}
      {hint ? <T v="small" muted style={{ fontSize: 12 }}>{hint}</T> : null}
    </View>
  );
}

/** The app's text field, for sheets and filters. */
export function Input({ style, multiline, ...rest }: TextInputProps) {
  return (
    <TextInput placeholderTextColor={color.textMuted} multiline={multiline} textAlignVertical={multiline ? "top" : undefined}
      {...rest} style={[st.input, multiline && st.inputMulti, style]} />
  );
}

/**
 * Agent text shown without a Markdown renderer (the run timeline): the words an agent gave a meaning
 * are coloured, everything else is passed through. Renders inside a <T>, whose size it inherits.
 */
export function ToneText({ text, lenient }: { text: string; lenient?: boolean }) {
  const spans = React.useMemo(() => parseTones(text, { lenient }), [text, lenient]);
  return <>{spans.map((s, i) => (s.tone ? <Text key={i} style={{ color: toneColor[s.tone] }}>{s.text}</Text> : s.text))}</>;
}

const st = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: color.overlay, justifyContent: "flex-end" },
  scrimWide: { justifyContent: "center", alignItems: "center", padding: space.xl },
  panel: { backgroundColor: color.surface, borderColor: color.borderStrong, borderWidth: 1 },
  bottom: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderBottomWidth: 0, paddingTop: space.sm },
  dialog: { width: "100%", maxWidth: 520, borderRadius: radius.xl, paddingTop: space.md, paddingBottom: space.md },
  grabber: { alignSelf: "center", width: 38, height: 4, borderRadius: 2, backgroundColor: color.borderStrong, marginBottom: space.xs },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, minHeight: 48 },
  body: { paddingHorizontal: space.lg, paddingBottom: space.md, paddingTop: space.xs, gap: space.lg },
  input: {
    minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: color.borderStrong, backgroundColor: color.bg, color: color.text, fontSize: 15,
    paddingHorizontal: space.md, paddingVertical: 10, outlineStyle: "none",
  } as any,
  inputMulti: { minHeight: 92, lineHeight: 21 },
});
