import { describe, expect, it } from "vitest";
import { AGENT_MARKUP_NOTE, TONES, calloutHead, matchToneAt, parseTones, stripAgentMarkup } from "../src";

describe("toned spans  :tone[text]", () => {
  it("matches each of the four tones and nothing else", () => {
    for (const tone of TONES) expect(matchToneAt(`:${tone}[x y]`, 0)).toEqual({ tone, inner: "x y", end: tone.length + 6 });
    for (const bad of [":red[x]", ":danger[x]", ":CRITICAL[x]", ":critical [x]", ":critical(x)", "critical[x]", ":style[color:red]"]) expect(matchToneAt(bad, 0)).toBeNull();
  });

  it("only opens at the given index, and not in the middle of a word or after another colon", () => {
    expect(matchToneAt("a :info[b]", 0)).toBeNull();
    expect(matchToneAt("a :info[b]", 2)).toMatchObject({ tone: "info", inner: "b", end: 10 });
    expect(matchToneAt("x:info[b]", 1)).toBeNull();        // glued to a word
    expect(matchToneAt("::info[b]", 1)).toBeNull();        // a second colon
    expect(matchToneAt("\\:info[b]", 1)).toBeNull();       // escaped
  });

  it("needs balanced brackets, so links and wikilinks can sit inside", () => {
    expect(matchToneAt(":warning[see [the docs](https://x.test/a) first]", 0)?.inner).toBe("see [the docs](https://x.test/a) first");
    expect(matchToneAt(":info[[[Clients/Acme Corp|Acme]] is affected] tail", 0)).toMatchObject({ inner: "[[Clients/Acme Corp|Acme]] is affected", end: 45 });
    expect(matchToneAt(":critical[a \\] b]", 0)?.inner).toBe("a \\] b"); // an escaped bracket does not close it
    expect(matchToneAt(":critical[use `arr[0]]` here]", 0)?.inner).toBe("use `arr[0]]` here"); // brackets in code do not count
  });

  it("an unclosed or empty span is not a span, unless the text is still streaming", () => {
    expect(matchToneAt(":critical[never closed", 0)).toBeNull();
    expect(matchToneAt(":critical[]", 0)).toBeNull();
    expect(matchToneAt(":critical[   ]", 0)).toBeNull();
    expect(matchToneAt(":critical[line one\nline two]", 0)).toBeNull(); // never across lines
    expect(matchToneAt(":critical[still typ", 0, { lenient: true })).toEqual({ tone: "critical", inner: "still typ", end: 19 });
    expect(matchToneAt(":critical[one\ntwo", 0, { lenient: true })).toMatchObject({ inner: "one", end: 13 });
    expect(matchToneAt(":critical[", 0, { lenient: true })).toBeNull();
  });
});

describe("parseTones", () => {
  it("splits text into toned and plain runs", () => {
    expect(parseTones("Found :critical[an SQL injection] and :warning[2 old deps]. :success[Tests pass].")).toEqual([
      { text: "Found " }, { text: "an SQL injection", tone: "critical" }, { text: " and " }, { text: "2 old deps", tone: "warning" }, { text: ". " },
      { text: "Tests pass", tone: "success" }, { text: "." },
    ]);
    expect(parseTones("nothing here: just text [1] and a :smile:")).toEqual([{ text: "nothing here: just text [1] and a :smile:" }]);
  });

  it("leaves code spans alone and keeps the inner tone when spans nest", () => {
    expect(parseTones("run `echo :critical[x]` then :info[go]")).toEqual([{ text: "run `echo :critical[x]` then " }, { text: "go", tone: "info" }]);
    expect(parseTones(":warning[outer :critical[inner] rest]")).toEqual([
      { text: "outer ", tone: "warning" }, { text: "inner", tone: "critical" }, { text: " rest", tone: "warning" },
    ]);
    expect(parseTones(":info[a \\] b]")).toEqual([{ text: "a ] b", tone: "info" }]);
  });

  it("cannot be used to smuggle anything but a tone name: there is no attribute, colour or style to set", () => {
    const hostile = ':critical[x]{color:#f0f} :info[<b onclick="x">y</b>] :critical;background:url(z)[q] :#ff0000[r] :critical[javascript:alert(1)]';
    const spans = parseTones(hostile);
    expect(new Set(spans.map((s) => s.tone).filter(Boolean))).toEqual(new Set(["critical", "info"]));
    for (const s of spans) expect(Object.keys(s).every((k) => k === "text" || k === "tone")).toBe(true);
    expect(spans.map((s) => s.text).join("")).toBe('x{color:#f0f} <b onclick="x">y</b> :critical;background:url(z)[q] :#ff0000[r] javascript:alert(1)');
  });
});

describe("callouts  > [!tone] Title", () => {
  it("reads the four tones and the GitHub / Obsidian words agents already use", () => {
    expect(calloutHead("[!critical] SQL injection in /login")).toEqual({ tone: "critical", title: "SQL injection in /login" });
    expect(calloutHead("[!WARNING]")).toEqual({ tone: "warning", title: "" });
    expect(calloutHead("[!CAUTION] careful")).toEqual({ tone: "critical", title: "careful" });
    expect(calloutHead("[!IMPORTANT] x")?.tone).toBe("warning");
    expect(calloutHead("[!TIP] x")?.tone).toBe("success");
    expect(calloutHead("[!NOTE] x")?.tone).toBe("info");
    expect(calloutHead("[!note]- folded in Obsidian")).toEqual({ tone: "info", title: "folded in Obsidian" });
  });

  it("is not a callout for an unknown word or ordinary quoted text", () => {
    for (const s of ["[!purple] x", "[!] x", "[critical] x", "just a quote", "[!critical x"]) expect(calloutHead(s)).toBeNull();
  });
});

describe("stripAgentMarkup", () => {
  it("keeps the words and drops the markup, for previews, notifications and read-aloud", () => {
    expect(stripAgentMarkup("Found :critical[an SQL injection] in **/login**.")).toBe("Found an SQL injection in **/login**.");
    expect(stripAgentMarkup("> [!warning] Rate limit at 80%\n> Twelve requests were throttled.")).toBe("> Rate limit at 80%\n> Twelve requests were throttled.");
    expect(stripAgentMarkup(":warning[cut off mid-str")).toBe("cut off mid-str");
    expect(stripAgentMarkup("`:info[code stays]` and 10:30 [a]")).toBe("`:info[code stays]` and 10:30 [a]");
    expect(stripAgentMarkup("plain")).toBe("plain");
  });
});

describe("what the agent is told", () => {
  it("names every tone with its syntax, says to use it rarely, and where never to use it", () => {
    for (const tone of TONES) expect(AGENT_MARKUP_NOTE).toContain(`:${tone}[text]`);
    expect(AGENT_MARKUP_NOTE).toContain("> [!critical] Short title");
    expect(AGENT_MARKUP_NOTE).toMatch(/Use them rarely/);
    expect(AGENT_MARKUP_NOTE).toMatch(/Never use this markup in files, code, commit messages, emails, notes, or tool inputs/);
    expect(AGENT_MARKUP_NOTE).toMatch(/no other colours, HTML or styling/);
  });

  it("its own example parses to exactly the tones it shows", () => {
    const example = /Example: "(.*)"$/m.exec(AGENT_MARKUP_NOTE)![1];
    expect(parseTones(example).filter((s) => s.tone).map((s) => s.tone)).toEqual(["critical", "warning", "success"]);
  });
});
