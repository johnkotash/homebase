import React from "react";
import { StyleSheet, View } from "react-native";
import { parseInline, parseMarkdown } from "../markdown";
import { color, font, radius, space, tint, toneColor, toneLabel } from "../theme";
import { T } from "./ui";

/** Renders an agent's plan. The parser is in ../markdown.ts; nothing here adds to the native build. */
function Inline({ text, tone }: { text: string; tone?: string }) {
  return (
    <>
      {parseInline(text).map((s, i) =>
        s.code ? <T key={i} v="mono" style={st.inlineCode}>{s.text}</T>
        : <T key={i} tone={tone} style={[s.bold && { fontFamily: font.heading, color: color.text }, s.italic && { fontStyle: "italic" }, s.tone && { color: toneColor[s.tone] }]}>{s.text}</T>,
      )}
    </>
  );
}

export function Markdown({ text, selectable }: { text: string; selectable?: boolean }) {
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={st.root}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h":
            return <T key={i} v={b.level <= 2 ? "heading" : "body"} selectable={selectable} accessibilityRole="header"
              style={[b.level <= 2 ? { fontSize: b.level === 1 ? 18 : 16 } : { fontFamily: font.heading }, i > 0 && { marginTop: space.sm }]}><Inline text={b.text} /></T>;
          case "p":
            return <T key={i} selectable={selectable} tone={color.textDim}><Inline text={b.text} tone={color.textDim} /></T>;
          case "li":
            return (
              <View key={i} style={[st.li, { paddingLeft: b.depth * 16 }]}>
                <T tone={color.textMuted} style={[st.marker, b.ordered && { fontVariant: ["tabular-nums"] }]}>{b.marker}</T>
                <T selectable={selectable} tone={color.textDim} style={{ flex: 1 }}><Inline text={b.text} tone={color.textDim} /></T>
              </View>
            );
          case "code":
            return <View key={i} style={st.code}><T v="mono" selectable={selectable} style={{ fontSize: 12.5 }}>{b.text}</T></View>;
          case "quote": {
            if (!b.tone) return <View key={i} style={st.quote}><T selectable={selectable} tone={color.textMuted}><Inline text={b.text} tone={color.textMuted} /></T></View>;
            const c = toneColor[b.tone];
            return (
              <View key={i} style={[st.callout, { borderLeftColor: c, backgroundColor: tint(c, 0.08) }]} accessibilityLabel={`${toneLabel[b.tone]}: ${b.title || b.text}`}>
                <T v="micro" tone={c} style={{ fontSize: 10, letterSpacing: 1.2 }}>{toneLabel[b.tone]}</T>
                {b.title ? <T selectable={selectable} tone={c} style={{ fontFamily: font.heading }}><Inline text={b.title} tone={c} /></T> : null}
                {b.text ? <T selectable={selectable} tone={color.textDim}><Inline text={b.text} tone={color.textDim} /></T> : null}
              </View>
            );
          }
          case "hr":
            return <View key={i} style={st.hr} />;
        }
      })}
    </View>
  );
}

const st = StyleSheet.create({
  root: { gap: 6 },
  li: { flexDirection: "row", gap: 8 },
  marker: { minWidth: 18, textAlign: "right" },
  inlineCode: { fontSize: 13, backgroundColor: color.surface3, color: color.text },
  code: { backgroundColor: color.bg, borderRadius: radius.sm, padding: space.md, borderWidth: 1, borderColor: color.border },
  quote: { borderLeftWidth: 2, borderLeftColor: color.borderStrong, paddingLeft: space.md },
  callout: { borderLeftWidth: 3, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: color.borderStrong, marginVertical: space.xs },
});
