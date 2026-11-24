import { calloutHead, matchToneAt, type Tone } from "@homebase/protocol";

/**
 * Markdown parser for vault notes: what Obsidian notes in this vault actually use. Headings, nested
 * lists and tasks, code, quotes, rules, tables, frontmatter, and inline bold, italic, code, tags,
 * wikilinks, embeds and links. Every block keeps its source line so a search hit or a `## YYYYMMDD`
 * header can be scrolled to. Pure, so it is unit-tested without a renderer.
 *
 * Agent replies go through the same parser with `tones: true`, which adds the toned text an agent may
 * use (`:critical[...]` and `> [!warning] Title` callouts). Notes are parsed without it, so a note is
 * never coloured by something that only looks like the markup.
 */
export interface ParseOptions {
  /** Recognise an agent's toned spans and callouts. */
  tones?: boolean;
  /** Text that is still streaming in: a toned span that is not closed yet runs to the end of its line. */
  lenient?: boolean;
}

export type NoteBlock =
  | { t: "h"; level: number; text: string; line: number }
  | { t: "p"; text: string; line: number }
  | { t: "li"; ordered: boolean; marker: string; depth: number; text: string; line: number }
  | { t: "code"; text: string; line: number }
  | { t: "quote"; text: string; line: number; tone?: Tone; title?: string }
  | { t: "hr"; line: number }
  | { t: "table"; head: string[]; rows: string[][]; line: number };

export interface ParsedNote {
  /** Frontmatter as written, key and raw value. Empty when the note has none. */
  frontmatter: Array<[string, string]>;
  blocks: NoteBlock[];
}

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

export function parseNote(src: string, opts: ParseOptions = {}): ParsedNote {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const frontmatter: Array<[string, string]> = [];
  let i = 0;
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && l.trimEnd() === "---");
    if (end > 0) {
      let key: string | null = null;
      for (const l of lines.slice(1, end)) {
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(l);
        const item = /^\s+-\s+(.*)$/.exec(l);
        if (kv) {
          key = kv[1];
          frontmatter.push([key, kv[2].trim()]);
        } else if (item && key) {
          const last = frontmatter[frontmatter.length - 1];
          last[1] = last[1] ? `${last[1]}, ${item[1].trim()}` : item[1].trim();
        }
      }
      i = end + 1;
    }
  }
  const out: NoteBlock[] = [];
  let para: string[] = [];
  let paraLine = 0;
  let quoteEnd = -2; // index of the last quoted line
  const flush = () => {
    if (para.length) out.push({ t: "p", text: para.join(" "), line: paraLine });
    para = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push({ t: "code", text: body.join("\n"), line: n });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      out.push({ t: "h", level: m[1].length, text: m[2], line: n });
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: "hr", line: n });
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push({ t: "table", head, rows, line: n });
    } else if ((m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line))) {
      flush();
      const ordered = /\d/.test(m[2]);
      out.push({
        t: "li", ordered, marker: ordered ? m[2].replace(")", ".") : "•", depth: Math.min(4, Math.floor(m[1].replace(/\t/g, "  ").length / 2)),
        text: m[3].replace(/^\[( |x|X)\]\s+/, (_, c) => (c === " " ? "☐ " : "☑ ")), line: n,
      });
    } else if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
      flush();
      const prev = out[out.length - 1];
      // `> [!warning] Title` opens a callout; the lines after it are its body.
      const head = opts.tones ? calloutHead(m[1]) : null;
      // A callout ends at the first line that is not quoted; a plain quote after a blank line is its own block.
      const joins = prev?.t === "quote" && (!prev.tone || quoteEnd === i - 1);
      if (head) out.push({ t: "quote", text: "", line: n, tone: head.tone, title: head.title });
      else if (prev?.t === "quote" && joins) prev.text = prev.text ? `${prev.text} ${m[1]}` : m[1];
      else out.push({ t: "quote", text: m[1], line: n });
      quoteEnd = i;
    } else {
      const prev = out[out.length - 1];
      if (!para.length && prev?.t === "li" && /^\s{2,}\S/.test(line)) prev.text += ` ${line.trim()}`;
      else {
        if (!para.length) paraLine = n;
        para.push(line.trim());
      }
    }
  }
  flush();
  return { frontmatter, blocks: out };
}

export interface NoteSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  mark?: boolean;
  /** A wikilink: where it points. `text` is its alias or a short form of the target. */
  link?: { target: string; heading: string | null; embed: boolean };
  /** A web link. */
  url?: string;
  tag?: boolean;
  /** The meaning an agent gave these words. */
  tone?: Tone;
}

/** `Daily Notes/Clients/Acme Corp/2026/November` reads better as `Acme Corp — November`; other paths show their last part. */
export function linkLabel(target: string, heading: string | null): string {
  const parts = target.replace(/\.md$/i, "").split("/").filter(Boolean);
  let label = parts[parts.length - 1] ?? "";
  const ci = parts.indexOf("Clients");
  if (ci >= 0 && parts.length >= ci + 4 && /^\d{4}$/.test(parts[ci + 2])) label = `${parts[ci + 1]} — ${parts[ci + 3]}`;
  else if (parts.length >= 2 && /^\d{4}$/.test(parts[parts.length - 2])) label = `${label} ${parts[parts.length - 2]}`;
  if (!label) return heading ?? "";
  return heading ? `${label} · ${heading}` : label;
}

const INLINE = /(`+)([^`]+?)\1|(!?)\[\[([^\]\n]+?)\]\]|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|==(.+?)==|\*([^*\s][^*]*?)\*|(?<![\w/])_([^_\s][^_]*?)_(?![\w])|(?<![\w/&])#([A-Za-z][\w/-]*)|(https?:\/\/[^\s<>)\]]+)|(?<![\w:\\]):(critical|warning|success|info)\[/g;

export function parseNoteInline(text: string, style: Partial<NoteSpan> = {}, opts: ParseOptions = {}): NoteSpan[] {
  const spans: NoteSpan[] = [];
  const push = (s: NoteSpan) => spans.push({ ...style, ...s });
  let last = 0;
  INLINE.lastIndex = 0;
  const re = new RegExp(INLINE.source, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[15] != null) {
      // A toned span. Its brackets must balance, which a regular expression cannot check.
      const span = opts.tones ? matchToneAt(text, m.index, opts) : null;
      if (!span) continue; // not one after all: it stays ordinary text
      if (m.index > last) push({ text: text.slice(last, m.index) });
      spans.push(...parseNoteInline(span.inner.replace(/\\\]/g, "]"), { ...style, tone: span.tone }, opts));
      last = re.lastIndex = span.end;
      continue;
    }
    if (m.index > last) push({ text: text.slice(last, m.index) });
    if (m[2] != null) push({ text: m[2], code: true });
    else if (m[4] != null) {
      const [left, ...alias] = m[4].split(/\\?\|/);
      const [target, ...h] = left.split("#");
      const heading = h.length ? h.join("#").trim() : null;
      push({ text: alias.length ? alias.join("|").trim() : linkLabel(target.trim(), heading), link: { target: target.trim(), heading, embed: m[3] === "!" } });
    } else if (m[5] != null) {
      if (/^https?:\/\//i.test(m[6])) push({ text: m[5], url: m[6] });
      else if (/\.md(#.*)?$/i.test(m[6])) {
        const [target, heading] = decodeURIComponent(m[6]).split("#");
        push({ text: m[5], link: { target, heading: heading ?? null, embed: false } });
      } else push({ text: m[5] });
    } else if (m[7] != null || m[8] != null) spans.push(...parseNoteInline(m[7] ?? m[8], { ...style, bold: true }, opts));
    else if (m[9] != null) spans.push(...parseNoteInline(m[9], { ...style, strike: true }, opts));
    else if (m[10] != null) spans.push(...parseNoteInline(m[10], { ...style, mark: true }, opts));
    else if (m[11] != null || m[12] != null) spans.push(...parseNoteInline(m[11] ?? m[12], { ...style, italic: true }, opts));
    else if (m[13] != null) push({ text: `#${m[13]}`, tag: true });
    else if (m[14] != null) push({ text: m[14].replace(/^https?:\/\/(www\.)?/, "").slice(0, 60), url: m[14] });
    last = m.index + m[0].length;
  }
  if (last < text.length) push({ text: text.slice(last) });
  return spans;
}

/** One line of a note as plain text for a list row: no bullet marker, links shown by their alias or name. */
export function plainSnippet(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/!?\[\[([^\]\n]+?)\]\]/g, (_, inner: string) => {
      const [left, ...alias] = inner.split(/\\?\|/);
      const [target, ...h] = left.split("#");
      return alias.length ? alias.join("|").trim() : linkLabel(target.trim(), h.length ? h.join("#").trim() : null);
    })
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, "$1")
    .replace(/\*\*|__|`|==|~~/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The block a link, a day or a search hit points at: by `## YYYYMMDD`, by heading text, or by source line. */
export function findTarget(blocks: NoteBlock[], t: { day?: string | null; heading?: string | null; line?: number | null }): number {
  if (t.day) {
    const i = blocks.findIndex((b) => b.t === "h" && b.text.trim() === t.day);
    if (i >= 0) return i;
  }
  if (t.heading) {
    const want = t.heading.trim().toLowerCase();
    const i = blocks.findIndex((b) => b.t === "h" && b.text.replace(/\*\*|`/g, "").trim().toLowerCase() === want);
    if (i >= 0) return i;
  }
  if (t.line && t.line > 0) {
    let best = -1;
    blocks.forEach((b, i) => {
      if (b.line <= t.line!) best = i;
    });
    return best;
  }
  return -1;
}

/** How many top-level bullets a month file has under one day. */
export function countDayBullets(text: string, day: string): number {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${day}\\s*$`).test(l));
  if (at < 0) return 0;
  let n = 0;
  for (let i = at + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]); i++) if (/^[-*+]\s/.test(lines[i])) n++;
  return n;
}
