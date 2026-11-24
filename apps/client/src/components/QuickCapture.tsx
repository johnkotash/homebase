import React, { useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { newId } from "@homebase/protocol";
import { mutate, showToast, syncStore } from "../sync/session";
import { addToToday } from "../vault/vault";
import { color, radius, space } from "../theme";
import { useDictation } from "../voice/useDictation";
import { MicButton } from "./MicButton";
import { Btn, Card, Icon, Segmented, T } from "./ui";

type Target = "note" | "inbox";

export function saveCapture(target: Target, text: string, source: "voice" | "text") {
  const clean = text.trim();
  if (!clean) return;
  const title = clean.length > 70 ? `${clean.slice(0, 67).trimEnd()}…` : clean;
  if (target === "note") {
    // Notes live in the vault now: this goes to the Notes agent, which files it under today.
    const agents = Object.values(syncStore.getState().entities.agents);
    addToToday(agents.find((a) => a.key === "notes") ?? agents.find((a) => !!a.vault), clean, source);
  } else {
    void mutate("inbox.capture", { itemId: newId("inb"), title, body: clean, priority: "P2" });
    showToast("Added to your inbox", title, "ok", "/inbox");
  }
}

/** Home's quick capture: hold the mic, speak, and it becomes a note or a manual inbox item. */
export function QuickCapture({ defaultTarget = "note", fixedTarget }: { defaultTarget?: Target; fixedTarget?: Target }) {
  const [target, setTarget] = useState<Target>(fixedTarget ?? defaultTarget);
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(false);
  const base = useRef("");
  const join = (a: string, b: string) => (a.trim() ? `${a.trim()} ${b.trim()}` : b.trim());
  const d = useDictation({
    onPartial: (p) => setText(join(base.current, p)),
    onFinal: (f) => {
      base.current = join(base.current, f);
      setText(base.current);
      setVoice(true);
    },
  });
  const save = () => {
    saveCapture(target, text, voice ? "voice" : "text");
    setText("");
    base.current = "";
    setVoice(false);
  };
  const hasMic = d.availability !== "hidden";
  return (
    <Card style={{ gap: space.md }}>
      <View style={st.head}>
        <View style={{ flex: 1 }}>
          <T v="heading">Quick capture</T>
          <T v="small">
            {d.listening ? "Listening… release when you're done" : hasMic ? (d.availability === "unavailable" ? "Speech recognition unavailable on this device. Type instead." : "Hold the mic and talk, or type") : "Type it, and it goes to today's note or your inbox"}
          </T>
        </View>
        {fixedTarget ? null : (
          <View style={{ width: 176 }}>
            <Segmented value={target} onChange={setTarget} options={[{ value: "note", label: "Today", icon: "file-text" }, { value: "inbox", label: "Inbox", icon: "inbox" }]} />
          </View>
        )}
      </View>
      <View style={st.body}>
        {hasMic ? (
          <MicButton listening={d.listening} level={d.level} onStart={d.start} onStop={d.stop} size={84} disabled={d.availability === "unavailable"} label="Hold to capture" />
        ) : null}
        <View style={[st.field, d.listening && { borderColor: color.accent }]}>
          <TextInput
            value={text}
            onChangeText={(v) => {
              setText(v);
              base.current = v;
            }}
            placeholder={target === "note" ? "Something for today's note…" : "Something to deal with later…"}
            placeholderTextColor={color.textMuted}
            multiline
            style={st.input}
            accessibilityLabel="Quick capture text"
          />
        </View>
      </View>
      {d.errorText ? <View style={st.err}><Icon name="alert-circle" size={13} tone={color.warn} /><T v="small" tone={color.warn}>{d.errorText}</T></View> : null}
      {text.trim() ? (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Btn label="Discard" kind="ghost" onPress={() => { setText(""); base.current = ""; }} />
          <Btn label={target === "note" ? "Add to today" : "Add to inbox"} kind="primary" icon="check" onPress={save} grow />
        </View>
      ) : null}
    </Card>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" },
  body: { flexDirection: "row", alignItems: "center", gap: space.lg },
  field: { flex: 1, minHeight: 84, backgroundColor: color.bg, borderRadius: radius.md, borderWidth: 1, borderColor: color.border, paddingHorizontal: space.md },
  input: { flex: 1, color: color.text, fontSize: 15, lineHeight: 21, paddingVertical: space.md, minHeight: 82, textAlignVertical: "top", outlineStyle: "none" } as any,
  err: { flexDirection: "row", alignItems: "center", gap: 6 },
});
