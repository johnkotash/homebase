import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/markdown";
import { parseNote, parseNoteInline } from "../src/vault/noteMarkdown";

const tones = { tones: true };

describe("toned text in an agent's reply (the chat renderer)", () => {
  it("turns :tone[text] into a span with that tone, next to ordinary Markdown", () => {
    expect(parseNoteInline("Found :critical[an SQL injection] in **/login** and :warning[2 old deps].", {}, tones)).toEqual([
      { text: "Found " }, { text: "an SQL injection", tone: "critical" }, { text: " in " }, { text: "/login", bold: true }, { text: " and " },
      { text: "2 old deps", tone: "warning" }, { text: "." },
    ]);
  });

  it("combines with bold, italic, code, links and wikilinks, inside or outside the span", () => {
    expect(parseNoteInline("**:critical[Vulnerability]**", {}, tones)).toEqual([{ text: "Vulnerability", bold: true, tone: "critical" }]);
    expect(parseNoteInline(":critical[**Vulnerability** in `auth.ts`]", {}, tones)).toEqual([
      { text: "Vulnerability", tone: "critical", bold: true }, { text: " in ", tone: "critical" }, { text: "auth.ts", tone: "critical", code: true },
    ]);
    expect(parseNoteInline(":info[see [the docs](https://x.test/a)]", {}, tones)).toEqual([
      { text: "see ", tone: "info" }, { text: "the docs", tone: "info", url: "https://x.test/a" },
    ]);
    const wiki = parseNoteInline(":success[filed in [[Clients/Acme Corp/2026/November|Acme]]]", {}, tones);
    expect(wiki[1]).toMatchObject({ text: "Acme", tone: "success", link: { target: "Clients/Acme Corp/2026/November" } });
  });

  it("leaves markup inside code alone, and anything that is not one of the four tones", () => {
    expect(parseNoteInline("type `:critical[x]` to mark it", {}, tones)).toEqual([{ text: "type " }, { text: ":critical[x]", code: true }, { text: " to mark it" }]);
    expect(parseNoteInline("at 10:30 [a] :red[b] :critical(c) x:info[d]", {}, tones)).toEqual([{ text: "at 10:30 [a] :red[b] :critical(c) x:info[d]" }]);
    expect(parseNoteInline(":critical[never closed and **bold**", {}, tones)).toEqual([{ text: ":critical[never closed and " }, { text: "bold", bold: true }]);
  });

  it("shows an unclosed span as toned only while the text is still streaming", () => {
    expect(parseNoteInline("Found :critical[an SQL inj", {}, { tones: true, lenient: true })).toEqual([{ text: "Found " }, { text: "an SQL inj", tone: "critical" }]);
  });

  it("a vault note is never coloured by text that looks like the markup", () => {
    expect(parseNoteInline("Found :critical[an SQL injection]")).toEqual([{ text: "Found :critical[an SQL injection]" }]);
    expect(parseNote("> [!warning] Title\n> body").blocks).toEqual([{ t: "quote", text: "[!warning] Title body", line: 1 }]);
  });

  it("reads a callout: a tone, a title and the body lines after it", () => {
    const { blocks } = parseNote("Before.\n\n> [!critical] Fix before the next deploy\n> The `email` field is concatenated.\n> A parameterised query closes it.\n\nAfter.", tones);
    expect(blocks).toEqual([
      { t: "p", text: "Before.", line: 1 },
      { t: "quote", tone: "critical", title: "Fix before the next deploy", text: "The `email` field is concatenated. A parameterised query closes it.", line: 3 },
      { t: "p", text: "After.", line: 7 },
    ]);
  });

  it("two callouts in a row stay two; GitHub's words map onto the four tones; an unknown word is a plain quote", () => {
    const { blocks } = parseNote("> [!WARNING]\n> careful\n> [!TIP] nice\n> [!purple] what\n> more", tones);
    expect(blocks).toEqual([
      { t: "quote", tone: "warning", title: "", text: "careful", line: 1 },
      { t: "quote", tone: "success", title: "nice", text: "[!purple] what more", line: 3 },
    ]);
    expect(parseNote("> just a quote\n> on two lines", tones).blocks).toEqual([{ t: "quote", text: "just a quote on two lines", line: 1 }]);
  });
});

describe("toned text in a plan (the plan renderer)", () => {
  it("parses spans and keeps bold and italic working around them", () => {
    expect(parseInline("Step 1 is :warning[irreversible]; **:critical[back up first]** and *then* run `x`")).toEqual([
      { text: "Step 1 is " }, { text: "irreversible", tone: "warning" }, { text: "; " }, { text: "back up first", bold: true, tone: "critical" },
      { text: " and " }, { text: "then", italic: true }, { text: " run " }, { text: "x", code: true },
    ]);
    expect(parseInline("2 * 3 * 4 and :nope[x]")).toEqual([{ text: "2 * 3 * 4 and :nope[x]" }]);
  });

  it("reads callouts", () => {
    expect(parseMarkdown("> [!critical] Drops the table\n> There is no undo.\n\n> plain quote")).toEqual([
      { t: "quote", tone: "critical", title: "Drops the table", text: "There is no undo." },
      { t: "quote", text: "plain quote" },
    ]);
  });
});
