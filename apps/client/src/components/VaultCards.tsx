import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { VaultCaptureCard as CaptureCard } from "@homebase/protocol";
import { color, radius, space } from "../theme";
import { fileName, openNote } from "../vault/vault";
import { NoteInline } from "./NoteMarkdown";
import { Card, Icon, T, Tag } from "./ui";

const prettyDay = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
/** `Daily Notes/Clients/X/2026/November.md` → "X — November"; the general log → "November 2026". */
export function captureFileLabel(path: string): string {
  const p = path.replace(/\.md$/i, "").split("/");
  const ci = p.indexOf("Clients");
  if (ci >= 0 && p.length >= ci + 4) return `${p[ci + 1]} — ${p[ci + 3]}`;
  if (p.length >= 2 && /^\d{4}$/.test(p[p.length - 2])) return `${p[p.length - 1]} ${p[p.length - 2]}`;
  return fileName(path);
}

/**
 * What a dictation wrote to the vault: each file (tap to open it at that day), the bullets exactly as
 * they are on disk, the transcript, and anything the service flagged. There is no undo here on purpose:
 * a wrong bullet gets a correction bullet.
 */
export function VaultCaptureCard({ card, compact }: { card: CaptureCard; compact?: boolean }) {
  const count = card.files.reduce((n, f) => n + f.bullets.filter((b) => /^[-*+]\s/.test(b)).length, 0);
  return (
    <Card pad={space.md} style={{ gap: space.sm, maxWidth: 560, width: "100%" }}>
      <View style={st.head}>
        <Icon name="check-circle" size={16} tone={color.text} />
        <T v="heading" style={{ flex: 1, fontSize: 15 }}>Captured {prettyDay(card.date)}</T>
        <Tag label={`${count} BULLET${count === 1 ? "" : "S"} · ${card.files.length} FILE${card.files.length === 1 ? "" : "S"}`} />
      </View>
      {card.files.map((f) => (
        <View key={f.path} style={st.file}>
          <Pressable accessibilityRole="link" accessibilityLabel={`Open ${captureFileLabel(f.path)}`} onPress={() => openNote({ path: f.path, day: card.date })}
            style={({ pressed, hovered }: any) => [st.fileHead, hovered && { backgroundColor: color.surface2 }, pressed && { opacity: 0.7 }]}>
            <Icon name="file-text" size={14} tone={color.textDim} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T v="heading" numberOfLines={1} style={{ fontSize: 14 }}>{captureFileLabel(f.path)}</T>
              <T v="small" muted numberOfLines={1} style={{ fontSize: 11.5 }}>{f.path} · {f.status}</T>
            </View>
            <Icon name="chevron-right" size={16} tone={color.textMuted} />
          </Pressable>
          {compact ? null : (
            <View style={st.bullets}>
              {f.bullets.map((b, i) => {
                const m = /^(\s*)[-*+]\s+(.*)$/.exec(b);
                const depth = m ? Math.floor(m[1].length / 2) : 0;
                return (
                  <View key={i} style={[st.bullet, { paddingLeft: depth * 16 }]}>
                    <T tone={color.textMuted} style={{ lineHeight: 21 }}>•</T>
                    <T selectable style={st.bulletText}><NoteInline text={m ? m[2] : b} from={f.path} tone={color.textDim} /></T>
                  </View>
                );
              })}
            </View>
          )}
        </View>
      ))}
      {card.flags.map((f, i) => (
        <View key={i} style={st.flag} accessibilityLabel={`Flag: ${f}`}>
          <Icon name="alert-triangle" size={13} tone={color.warn} style={{ marginTop: 3 }} />
          <T v="small" tone={color.warn} selectable style={{ flex: 1 }}>{f}</T>
        </View>
      ))}
      {card.transcriptPath ? (
        <Pressable accessibilityRole="link" onPress={() => openNote({ path: card.transcriptPath! })} hitSlop={6} style={st.transcript}>
          <Icon name="mic" size={13} tone={color.textDim} />
          <T v="small" style={{ textDecorationLine: "underline" }}>Transcript, word for word</T>
        </Pressable>
      ) : null}
    </Card>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: space.sm },
  file: { borderRadius: radius.md, borderWidth: 1, borderColor: color.border, backgroundColor: color.bg, overflow: "hidden" },
  fileHead: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md, paddingVertical: 9, minHeight: 48 },
  bullets: { paddingHorizontal: space.md, paddingBottom: space.md, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border, paddingTop: space.sm },
  bullet: { flexDirection: "row", gap: 8 },
  bulletText: { flex: 1, fontSize: 14, lineHeight: 21, color: color.textDim },
  flag: { flexDirection: "row", gap: 8, alignItems: "flex-start", paddingHorizontal: 2 },
  transcript: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 2, alignSelf: "flex-start" },
});
