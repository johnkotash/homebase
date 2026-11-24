import React from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { color, font, radius, space, tint, toneColor, toneLabel } from "../theme";
import { parseNote, parseNoteInline, type NoteBlock, type NoteSpan, type ParseOptions } from "../vault/noteMarkdown";
import { openLink } from "../vault/vault";
import { T } from "./ui";

/**
 * Renders a vault note (or an agent's answer that cites notes): headings, nested lists, tables, code,
 * quotes, tags and wikilinks. A wikilink is tappable and opens the note it points at.
 */
export function NoteInline({ text, from, tone, chips, tones, lenient }: { text: string; from?: string | null; tone?: string; chips?: boolean } & ParseOptions) {
  const spans = React.useMemo(() => parseNoteInline(text, {}, { tones, lenient }), [text, tones, lenient]);
  return <>{spans.map((s, i) => <Span key={i} s={s} from={from ?? null} tone={tone} chips={chips} />)}</>;
}

function Span({ s, from, tone, chips }: { s: NoteSpan; from: string | null; tone?: string; chips?: boolean }) {
  // An agent's toned span keeps its colour whatever else it is: bold, italic, struck through.
  const base = [s.bold && st.bold, s.italic && { fontStyle: "italic" as const }, s.strike && { textDecorationLine: "line-through" as const }, s.mark && st.mark, s.tone && { color: toneColor[s.tone] }];
  if (s.code) return <T v="mono" style={st.inlineCode}>{s.text}</T>;
  if (s.link) {
    const link = s.link;
    return (
      <Text accessibilityRole="link" accessibilityLabel={`Open ${s.text}`} onPress={() => openLink(link, from)} suppressHighlighting
        style={[base, chips ? st.chip : st.link]}>
        {chips ? ` ${s.text} ` : s.text}
      </Text>
    );
  }
  if (s.url) {
    const url = s.url;
    return <Text accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => {})} style={[base, st.link]}>{s.text}</Text>;
  }
  if (s.tag) return <Text style={st.tag}>{s.text}</Text>;
  // A plain Text, not T: a span inherits its size and line height from the heading, bullet or cell it sits in.
  return <Text style={[!s.bold && tone ? { color: tone } : null, base]}>{s.text}</Text>;
}

function Block({ b, from, selectable, chips, compact, tones, lenient }: { b: NoteBlock; from: string | null; selectable?: boolean; chips?: boolean; compact?: boolean } & ParseOptions) {
  const body = compact ? st.bodyCompact : st.body;
  const inl = { from, chips, tones, lenient };
  switch (b.t) {
    case "h": {
      const day = /^\d{8}$/.test(b.text.trim());
      const size = b.level === 1 ? (compact ? 18 : 24) : b.level === 2 ? (compact ? 16 : 18) : compact ? 15 : 16;
      return (
        <View style={[b.level <= 2 && !compact && st.hWrap, b.level === 2 && !compact && st.h2Rule, compact && st.hCompact, compact && b.level <= 2 && st.hCompactRule]}>
          <T selectable={selectable} accessibilityRole="header" style={[{ fontFamily: b.level === 1 ? font.display : font.heading, fontSize: size, lineHeight: size + 8, color: color.text, letterSpacing: -0.2 }, day && st.day]}>
            {day ? `${b.text.slice(0, 4)}  ${b.text.slice(4, 6)}  ${b.text.slice(6)}` : <NoteInline text={b.text} {...inl} />}
          </T>
        </View>
      );
    }
    case "p":
      return <T selectable={selectable} style={body}><NoteInline text={b.text} tone={color.textDim} {...inl} /></T>;
    case "li":
      return (
        <View style={[st.li, { paddingLeft: b.depth * 18 }]}>
          <T tone={color.textMuted} style={[st.marker, b.ordered && { fontVariant: ["tabular-nums"] }]}>{b.marker}</T>
          <T selectable={selectable} style={[body, { flex: 1 }]}><NoteInline text={b.text} tone={color.textDim} {...inl} /></T>
        </View>
      );
    case "code":
      return <ScrollView horizontal style={st.code} contentContainerStyle={{ padding: space.md }}><T v="mono" selectable={selectable} style={{ fontSize: 12.5 }}>{b.text}</T></ScrollView>;
    case "quote": {
      if (!b.tone) return <View style={st.quote}><T selectable={selectable} style={body}><NoteInline text={b.text} tone={color.textMuted} {...inl} /></T></View>;
      // A callout: the agent gave this paragraph a meaning. The label says it in words too, not only in colour.
      const c = toneColor[b.tone];
      return (
        <View style={[st.callout, { borderLeftColor: c, backgroundColor: tint(c, 0.08) }]} accessibilityLabel={`${toneLabel[b.tone]}: ${b.title || b.text}`}>
          <T v="micro" tone={c} style={st.calloutLabel}>{toneLabel[b.tone]}</T>
          {b.title ? <T selectable={selectable} style={[body, st.bold, { color: c }]}><NoteInline text={b.title} {...inl} /></T> : null}
          {b.text ? <T selectable={selectable} style={body}><NoteInline text={b.text} tone={color.textDim} {...inl} /></T> : null}
        </View>
      );
    }
    case "hr":
      return <View style={st.hr} />;
    case "table": {
      const cols = Math.max(b.head.length, ...b.rows.map((r) => r.length));
      const row = (cellsOf: string[], head: boolean, key: number) => (
        <View key={key} style={[st.tr, head && { backgroundColor: color.surface2 }]}>
          {Array.from({ length: cols }, (_, c) => (
            <View key={c} style={st.td}>
              <T selectable={selectable} style={[st.cell, head && st.bold]}><NoteInline text={cellsOf[c] ?? ""} tone={head ? undefined : color.textDim} {...inl} /></T>
            </View>
          ))}
        </View>
      );
      return (
        <ScrollView horizontal style={st.table} contentContainerStyle={{ flexGrow: 1 }}>
          <View style={{ flexGrow: 1, minWidth: cols * 132 }}>{row(b.head, true, -1)}{b.rows.map((r, i) => row(r, false, i))}</View>
        </ScrollView>
      );
    }
  }
}

/** A whole note. `target` is the index of the block to mark (a day, a heading or a search hit); `onTargetLayout` reports where it is. */
export function NoteMarkdown({ text, from, selectable, target, onTargetLayout, showProperties = true }: {
  text: string; from?: string | null; selectable?: boolean; target?: number; onTargetLayout?: (y: number) => void; showProperties?: boolean;
}) {
  const note = React.useMemo(() => parseNote(text), [text]);
  return (
    <View style={st.root}>
      {showProperties && note.frontmatter.length ? (
        <View style={st.props} accessibilityLabel="Note properties">
          {note.frontmatter.map(([k, v], i) => (
            <View key={i} style={st.prop}>
              <T v="micro" style={st.propKey}>{k}</T>
              <T v="small" selectable={selectable} style={{ flex: 1 }}><NoteInline text={v.replace(/^["']|["']$/g, "")} from={from} tone={color.textDim} /></T>
            </View>
          ))}
        </View>
      ) : null}
      {note.blocks.map((b, i) => (
        <View key={i} onLayout={i === target && onTargetLayout ? (e) => onTargetLayout(e.nativeEvent.layout.y) : undefined} style={i === target ? st.target : undefined}>
          <Block b={b} from={from ?? null} selectable={selectable} />
        </View>
      ))}
      {note.blocks.length === 0 && !note.frontmatter.length ? <T v="small" muted>This note is empty.</T> : null}
    </View>
  );
}

/**
 * An agent's answer in the chat: the same renderer, tighter, with wikilinks drawn as citation chips and
 * the agent's toned text in colour. `streaming` is for text that is still arriving.
 */
export function AnswerMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const note = React.useMemo(() => parseNote(text, { tones: true }), [text]);
  return (
    <View style={{ gap: 5 }}>
      {note.blocks.map((b, i) => <Block key={i} b={b} from={null} selectable chips compact tones lenient={streaming} />)}
    </View>
  );
}

export const hasWikilink = (text: string) => /\[\[[^\]\n]+\]\]/.test(text);

const st = StyleSheet.create({
  root: { gap: 7 },
  body: { fontSize: 15.5, lineHeight: 24, color: color.textDim },
  bodyCompact: { fontSize: 15, lineHeight: 22, color: color.textDim },
  bold: { fontFamily: font.heading, color: color.text },
  mark: { backgroundColor: color.surface3, color: color.text },
  link: { color: color.text, textDecorationLine: "underline", textDecorationColor: color.textMuted },
  chip: { color: color.text, backgroundColor: color.surface3, fontFamily: font.label, borderRadius: 6, overflow: "hidden" },
  tag: { color: color.textMuted, fontFamily: font.label },
  inlineCode: { fontSize: 13, backgroundColor: color.surface3, color: color.text },
  hWrap: { marginTop: space.md },
  hCompact: { marginTop: 6 },
  hCompactRule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.borderStrong, paddingBottom: 4, marginBottom: 2 },
  h2Rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border, paddingTop: space.md },
  day: { fontFamily: font.label, fontSize: 13, lineHeight: 18, letterSpacing: 1.6, color: color.textMuted, fontVariant: ["tabular-nums"] },
  li: { flexDirection: "row", gap: 8 },
  marker: { minWidth: 14, textAlign: "right", fontSize: 15.5, lineHeight: 24 },
  code: { backgroundColor: color.surface, borderRadius: radius.sm, borderWidth: 1, borderColor: color.border },
  quote: { borderLeftWidth: 2, borderLeftColor: color.borderStrong, paddingLeft: space.md },
  callout: { borderLeftWidth: 3, borderRadius: radius.sm, paddingLeft: space.md, paddingRight: space.md, paddingVertical: space.sm, gap: 2, marginVertical: 2 },
  calloutLabel: { fontSize: 10, letterSpacing: 1.2 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: color.borderStrong, marginVertical: space.sm },
  table: { borderWidth: 1, borderColor: color.border, borderRadius: radius.sm },
  tr: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  td: { flex: 1, minWidth: 132, paddingHorizontal: space.md, paddingVertical: 8 },
  cell: { fontSize: 14, lineHeight: 20, color: color.textDim },
  props: { borderWidth: 1, borderColor: color.border, borderRadius: radius.md, backgroundColor: color.surface, paddingHorizontal: space.md, paddingVertical: 6, marginBottom: space.sm },
  prop: { flexDirection: "row", gap: space.md, paddingVertical: 4, alignItems: "flex-start" },
  propKey: { width: 84, paddingTop: 3 },
  target: { borderLeftWidth: 2, borderLeftColor: color.accent, paddingLeft: space.md, marginLeft: -space.md - 2 },
});
