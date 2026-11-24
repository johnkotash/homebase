/**
 * Toned text in agent replies: a small, closed set of meanings an agent can attach to a few words or
 * to a callout, on top of Markdown. There is no way to name a colour, a size or a style: an agent picks
 * a meaning and each client decides how that meaning looks.
 *
 *   inline    :critical[SQL injection in /login]      :warning[...]   :success[...]   :info[...]
 *   callout   > [!warning] Rate limit at 80%
 *             > Twelve requests were throttled in the last hour.
 *
 * This file holds the grammar, the note that teaches it to the agent, and a stripper for the places
 * that show plain text (list previews, notifications, read-aloud). Pure, so it is unit-tested.
 */
export const TONES = ["critical", "warning", "success", "info"] as const;
export type Tone = (typeof TONES)[number];

export const TONE_MEANING: Record<Tone, string> = {
  critical: "must not be missed: a vulnerability, data loss, an outage, something broken in production",
  warning: "needs care or a decision soon: a risk, a deprecation, a limit that is close",
  success: "confirmed good: tests passing, a deploy that is verified, a fix that is proven",
  info: "a key term, name or title worth finding again when scanning the reply",
};

/** Callout words agents already know from GitHub and Obsidian, mapped onto the four tones. */
const CALLOUT_ALIAS: Record<string, Tone> = {
  critical: "critical", caution: "critical", danger: "critical", error: "critical",
  warning: "warning", important: "warning", attention: "warning",
  success: "success", tip: "success", done: "success",
  info: "info", note: "info",
};

/**
 * The paragraph added to every Claude agent's system prompt (apps/connector builds the command line).
 * Keep it in step with the grammar above: this text is the only way an agent learns the syntax.
 */
export const AGENT_MARKUP_NOTE = [
  "Formatting in HomeBase. Your replies are rendered as Markdown (headings, bold, lists, tables, code). You can also give a few words a meaning, and HomeBase shows that meaning in colour:",
  ...TONES.map((t) => `- :${t}[text] for ${TONE_MEANING[t]}.`),
  "For a whole paragraph, start a quote block with the same word: \"> [!critical] Short title\" and continue the block on the following \"> \" lines.",
  "Example: \"Found :critical[an SQL injection in /login] and :warning[two outdated dependencies]. :success[All 42 tests pass].\"",
  "Rules: there are exactly these four words and no other colours, HTML or styling. Use them rarely, for the one or two things the owner must not miss; most replies need none, and a reply where everything is marked tells the owner nothing. Bold stays the normal way to emphasise. Never use this markup in files, code, commit messages, emails, notes, or tool inputs: only in what you say to the owner.",
].join("\n");

export interface ToneMatch {
  tone: Tone;
  /** The text inside the brackets, still Markdown. */
  inner: string;
  /** Index just past the closing bracket. */
  end: number;
}

const OPEN = /(?<![\w:\\]):(critical|warning|success|info)\[/y;

/** Where a code span starting at `i` ends (index past its closing backticks), or -1 when it never closes. */
function codeSpanEnd(text: string, i: number): number {
  let n = 0;
  while (text[i + n] === "`") n++;
  for (let j = i + n; j < text.length; j++) {
    if (text[j] !== "`") continue;
    let k = 0;
    while (text[j + k] === "`") k++;
    if (k === n) return j + n;
    j += k - 1;
  }
  return -1;
}

/**
 * A toned span that opens exactly at `at`, or null. Brackets inside it must balance, so a link or a
 * wikilink can sit inside; `\]` is a literal bracket. An unclosed span is not a span, unless `lenient`
 * (text that is still streaming in), where it runs to the end of the text.
 */
export function matchToneAt(text: string, at: number, opts: { lenient?: boolean } = {}): ToneMatch | null {
  OPEN.lastIndex = at;
  const m = OPEN.exec(text);
  if (!m) return null;
  const tone = m[1] as Tone;
  const start = at + m[0].length;
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") break;
    if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      const end = codeSpanEnd(text, i);
      if (end > 0) i = end - 1;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]" && --depth === 0) {
      const inner = text.slice(start, i);
      return inner.trim() ? { tone, inner, end: i + 1 } : null;
    }
  }
  if (!opts.lenient) return null;
  const nl = text.indexOf("\n", start);
  const end = nl < 0 ? text.length : nl;
  const inner = text.slice(start, end);
  return inner.trim() ? { tone, inner, end } : null;
}

export interface ToneSpan {
  text: string;
  tone?: Tone;
}

/**
 * Splits plain text into runs with and without a tone, for places that show agent text without a
 * Markdown renderer. Code spans are left alone. A span nested in another keeps the inner tone.
 */
export function parseTones(text: string, opts: { lenient?: boolean } = {}, outer?: Tone): ToneSpan[] {
  const out: ToneSpan[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(outer ? { text: buf, tone: outer } : { text: buf });
    buf = "";
  };
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === "`") {
      const end = codeSpanEnd(text, i);
      if (end > 0) {
        buf += text.slice(i, end);
        i = end;
        continue;
      }
    } else if (ch === ":") {
      const m = matchToneAt(text, i, opts);
      if (m) {
        flush();
        out.push(...parseTones(m.inner.replace(/\\\]/g, "]"), opts, m.tone));
        i = m.end;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** A callout's first line: `[!warning] Title`. Null when the word is not one HomeBase knows. */
export function calloutHead(line: string): { tone: Tone; title: string } | null {
  const m = /^\s*\[!([A-Za-z]+)\][+-]?\s*(.*)$/.exec(line);
  if (!m) return null;
  const tone = CALLOUT_ALIAS[m[1].toLowerCase()];
  return tone ? { tone, title: m[2].trim() } : null;
}

/** The same text with the tone markup taken out and the words kept: for previews, notifications and read-aloud. */
export function stripAgentMarkup(text: string): string {
  if (!text.includes(":") && !text.includes("[!")) return text;
  return text
    .split("\n")
    .map((line) => {
      const quote = /^(\s{0,3}>\s?)(.*)$/.exec(line);
      const head = quote ? calloutHead(quote[2]) : null;
      const body = head ? `${quote![1]}${head.title}` : line;
      return parseTones(body, { lenient: true }).map((s) => s.text).join("");
    })
    .join("\n");
}
