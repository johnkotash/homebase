import { calloutHead, matchToneAt, type Tone } from "@homebase/protocol";

/**
 * A small Markdown parser for agent plans: headings, lists, code, quotes, rules, bold, italic,
 * inline code and links (kept as their text), plus the toned text an agent may use
 * (`:critical[...]` spans and `> [!warning] Title` callouts). Pure, so it is unit-tested without a renderer.
 */
export type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "li"; ordered: boolean; marker: string; depth: number; text: string }
  | { t: "code"; text: string }
  | { t: "quote"; text: string; tone?: Tone; title?: string }
  | { t: "hr" };

export function parseMarkdown(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let quoteEnd = -2; // index of the last quoted line
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push({ t: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      out.push({ t: "h", level: m[1].length, text: m[2] });
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: "hr" });
    } else if ((m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line))) {
      flush();
      const ordered = /\d/.test(m[2]);
      out.push({ t: "li", ordered, marker: ordered ? m[2].replace(")", ".") : "•", depth: Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2)), text: m[3].replace(/^\[( |x|X)\]\s+/, (_, c) => (c === " " ? "☐ " : "☑ ")) });
    } else if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
      flush();
      const prev = out.at(-1);
      const head = calloutHead(m[1]);
      // A callout ends at the first line that is not quoted; a plain quote after a blank line is its own block.
      const joins = prev?.t === "quote" && (!prev.tone || quoteEnd === i - 1);
      if (head) out.push({ t: "quote", text: "", tone: head.tone, title: head.title });
      else if (prev?.t === "quote" && joins) prev.text = prev.text ? `${prev.text} ${m[1]}` : m[1];
      else out.push({ t: "quote", text: m[1] });
      quoteEnd = i;
    } else {
      const prev = out.at(-1);
      // A wrapped line directly under a list item belongs to that item.
      if (!para.length && prev?.t === "li" && /^\s{2,}\S/.test(line)) prev.text += ` ${line.trim()}`;
      else para.push(line.trim());
    }
  }
  flush();
  return out;
}

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; tone?: Tone };

export function parseInline(text: string, style: Partial<Span> = {}): Span[] {
  const spans: Span[] = [];
  const push = (s: Span) => spans.push({ ...style, ...s });
  const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w:\\]):(critical|warning|success|info)\[/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[8] != null) {
      // A toned span: found by scanning, because its brackets must balance.
      const span = matchToneAt(text, m.index);
      if (!span) continue;
      if (m.index > last) push({ text: text.slice(last, m.index) });
      spans.push(...parseInline(span.inner.replace(/\\\]/g, "]"), { ...style, tone: span.tone }));
      last = re.lastIndex = span.end;
      continue;
    }
    if (m.index > last) push({ text: text.slice(last, m.index) });
    if (m[2] != null) push({ text: m[2], code: true });
    else if (m[3] != null || m[4] != null) spans.push(...parseInline(m[3] ?? m[4], { ...style, bold: true }));
    else if (m[5] != null) spans.push(...parseInline(m[5], { ...style, italic: true }));
    else push({ text: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) push({ text: text.slice(last) });
  return spans;
}
