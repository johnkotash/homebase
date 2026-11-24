import { describe, expect, it } from "vitest";
import type { VaultFile } from "@homebase/protocol";
import { countDayBullets, findTarget, linkLabel, parseNote, parseNoteInline, plainSnippet } from "../src/vault/noteMarkdown";
import { buildTree, folderLabel, looksLikeQuestion, todayIn } from "../src/vault/pure";

const NOTE = [
  "---", "client: Harbor Pine Realty", "tags: [a, b]", "files:", "  - x", "  - y", "---", "",
  "# Harbor Pine Realty — November 2026", "",
  "## 20261105",
  "- **Hero photo** — swapped for **shot 4**. #followup",
  "  - Quoted **$400**.",
  "- **[[Clients/Harbor Pine Realty/2026/November|Harbor Pine Realty]]** — pointer ([[Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305|src]])",
  "", "## 20261118", "- later", "",
  "| Folder | Also heard as |", "|---|---|", "| [[Clients/A/2026/August\\|A]] | Alpha, Al |", "",
  "```", "[[not a link]]", "```",
].join("\n");

describe("note markdown", () => {
  it("parses frontmatter, headings, nested bullets, tables and code, keeping source lines", () => {
    const n = parseNote(NOTE);
    expect(n.frontmatter).toEqual([["client", "Harbor Pine Realty"], ["tags", "[a, b]"], ["files", "x, y"]]);
    expect(n.blocks.map((b) => b.t)).toEqual(["h", "h", "li", "li", "li", "h", "li", "table", "code"]);
    expect(n.blocks[1]).toEqual({ t: "h", level: 2, text: "20261105", line: 11 });
    expect(n.blocks[3]).toMatchObject({ t: "li", depth: 1, text: "Quoted **$400**.", line: 13 });
    expect(n.blocks[7]).toEqual({ t: "table", head: ["Folder", "Also heard as"], rows: [["[[Clients/A/2026/August|A]]", "Alpha, Al"]], line: 19 });
    expect(n.blocks[8]).toMatchObject({ t: "code", text: "[[not a link]]" });
  });

  it("finds the block for a day, a heading or a search hit's line", () => {
    const { blocks } = parseNote(NOTE);
    expect(findTarget(blocks, { day: "20261118" })).toBe(5);
    expect(findTarget(blocks, { heading: "harbor pine realty — november 2026" })).toBe(0);
    expect(findTarget(blocks, { line: 13 })).toBe(3);
    expect(findTarget(blocks, { day: "20270101" })).toBe(-1);
    expect(findTarget(blocks, {})).toBe(-1);
  });

  it("turns wikilinks into links, including one inside bold and the transcript link", () => {
    const spans = parseNoteInline("**[[Clients/Harbor Pine Realty/2026/November|Harbor Pine Realty]]** — pointer ([[Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305|src]]) #followup `code` *it*");
    expect(spans[0]).toEqual({ bold: true, text: "Harbor Pine Realty", link: { target: "Clients/Harbor Pine Realty/2026/November", heading: null, embed: false } });
    expect(spans[2]).toEqual({ text: "src", link: { target: "Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305", heading: null, embed: false } });
    expect(spans.find((s) => s.tag)).toEqual({ text: "#followup", tag: true });
    expect(spans.find((s) => s.code)).toEqual({ text: "code", code: true });
    expect(spans.find((s) => s.italic)).toEqual({ text: "it", italic: true });
  });

  it("labels a citation by what it points at", () => {
    expect(parseNoteInline("[[Daily Notes/Clients/Acme Corp/2026/November#20261105]]")[0]).toMatchObject({ text: "Acme Corp — November · 20261105", link: { heading: "20261105" } });
    expect(linkLabel("Daily Notes/2026/November", null)).toBe("November 2026");
    expect(linkLabel("Tech/Homelab Architecture/Homelab Today", "Network")).toBe("Homelab Today · Network");
    expect(parseNoteInline("![[shot.png]]")[0]).toMatchObject({ link: { target: "shot.png", embed: true } });
    expect(parseNoteInline("see [docs](https://x.test/a) and https://y.test/b")).toEqual([{ text: "see " }, { text: "docs", url: "https://x.test/a" }, { text: " and " }, { text: "y.test/b", url: "https://y.test/b" }]);
    expect(parseNoteInline("2 * 3 * 4 and a_b_c and C# and #1")).toEqual([{ text: "2 * 3 * 4 and a_b_c and C# and #1" }]);
  });

  it("flattens a line for a search hit or a backlink row", () => {
    expect(plainSnippet("- **[[Clients/Harbor Pine Realty/2026/November|Harbor Pine Realty]]** — swapped the `hero` photo ([[Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305|src]])")).toBe("Harbor Pine Realty — swapped the hero photo (src)");
    expect(plainSnippet("- [[Daily Notes/Clients]] — Client list and aliases.")).toBe("Clients — Client list and aliases.");
  });

  it("counts today's top-level bullets", () => {
    expect(countDayBullets(NOTE, "20261105")).toBe(2);
    expect(countDayBullets(NOTE, "20261118")).toBe(1);
    expect(countDayBullets(NOTE, "20261119")).toBe(0);
  });
});

describe("notes tab helpers", () => {
  it("uses the owner's time zone for today, not the device's or UTC", () => {
    const late = Date.UTC(2026, 10, 20, 3, 30); // 22:30 on Thursday the 19th in New York
    expect(todayIn("America/New_York", late)).toEqual({ ymd: "20261119", label: "Thu 19 Nov", path: "Daily Notes/2026/November.md", monthTitle: "November 2026" });
    expect(todayIn("UTC", late).ymd).toBe("20261120");
  });

  it("builds the browse tree with months in calendar order and old versions last", () => {
    const f = (path: string): VaultFile => ({ id: path, path, title: path, type: null, tags: [], summary: null, mtime: 0, size: 0, hash: "", folder: "" });
    const tree = buildTree(["_Archive/x.md", "Tech/a.md", "Daily Notes/2026/November.md", "Daily Notes/2026/August.md", "Daily Notes/2026/May.md", "Daily Notes/RAW/2026/November.md", "_Index.md"].map(f));
    expect(tree.folders.map((n) => n.name)).toEqual(["Daily Notes", "Tech", "_Archive"]);
    expect(tree.files.map((n) => n.path)).toEqual(["_Index.md"]);
    const daily = tree.folders[0];
    expect(daily.count).toBe(4);
    expect(daily.folders.find((n) => n.name === "2026")!.files.map((n) => n.path.split("/").pop())).toEqual(["May.md", "August.md", "November.md"]);
    expect(folderLabel("Daily Notes/RAW")).toBe("yours only");
    expect(folderLabel("Daily Notes/RAW/AI Transcriptions")).toBe("transcripts");
    expect(folderLabel("Daily Notes")).toBeNull();
  });

  it("preselects Ask for text that reads like a question", () => {
    for (const q of ["What did I quote Harbor Pine?", "summarize last week", "find the note about the homelab", "when did I talk to Dana", "Did the invoice go out?"]) expect(looksLikeQuestion(q), q).toBe(true);
    for (const n of ["Okay daily note. Called Dana about the hero photo.", "Renewed the SSL cert on the mail server", "Finding it hard to focus today"]) expect(looksLikeQuestion(n), n).toBe(false);
  });
});
