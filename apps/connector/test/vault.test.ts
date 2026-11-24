import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLinks, resolveLink } from "@homebase/protocol";
import { decideNotes, notesConfig, parentClaudeMd } from "../src/vault/agent";
import {
  AdditiveError, appendToDay, assertAdditive, coverageGaps, localTime, looksSecret, parseClients, planDaily, resolveName, transcriptFile, transcriptPath, type Dictation,
} from "../src/vault/daily";
import { AGENT_AUTHOR, VaultGit } from "../src/vault/git";
import { VaultError, VaultService, classify, parseFrontmatter } from "../src/vault/service";
import { VAULT_TOOL_NAMES } from "../src/vault/tools";
import { testConfig } from "./claude-fixtures";
import { SPOKEN_AT, makeVault, type Fixture } from "./vault-fixture";

const dictation = (text: string, over: Partial<Dictation> = {}): Dictation => ({
  id: "t_test", text, capturedAt: SPOKEN_AT, tz: "America/New_York", device: "Test Phone", message: "msg_1", run: "run_1", ...over,
});

describe("assertAdditive", () => {
  const old = "# November 2026\n\n## 20261105\n- one\n- two\n";
  it("accepts lines inserted anywhere", () => {
    expect(() => assertAdditive(old, "# November 2026\n\n## 20261105\n- one\n- two\n- three\n")).not.toThrow();
    expect(() => assertAdditive(old, "# November 2026\n\n## 20261101\n- early\n\n## 20261105\n- one\n- inserted\n- two\n")).not.toThrow();
    expect(() => assertAdditive("", "anything\n")).not.toThrow();
  });
  it("rejects a removed line", () => {
    expect(() => assertAdditive(old, "# November 2026\n\n## 20261105\n- one\n")).toThrow(AdditiveError);
  });
  it("rejects a changed line, even by one character or trailing space", () => {
    expect(() => assertAdditive(old, old.replace("- two", "- Two"))).toThrow(AdditiveError);
    expect(() => assertAdditive(old, old.replace("- two", "- two "))).toThrow(AdditiveError);
    expect(() => assertAdditive("a\r\nb\r\n", "a\nb\n")).toThrow(AdditiveError); // line endings are bytes too
  });
  it("rejects reordered lines and a dropped duplicate", () => {
    expect(() => assertAdditive(old, "# November 2026\n\n## 20261105\n- two\n- one\n")).toThrow(AdditiveError);
    expect(() => assertAdditive("- same\n- same\n", "- same\n- other\n")).toThrow(AdditiveError);
  });
  it("lets the service rewrite only the updated: line of the frontmatter", () => {
    const fm = "---\ntitle: X\nupdated: 2026-11-01\n---\n\nbody\nupdated: not frontmatter\n";
    expect(() => assertAdditive(fm, fm.replace("updated: 2026-11-01", "updated: 2026-11-19"))).not.toThrow();
    expect(() => assertAdditive(fm, fm.replace("title: X", "title: Y"))).toThrow(AdditiveError);
    expect(() => assertAdditive(fm, fm.replace("updated: not frontmatter", "updated: changed"))).toThrow(AdditiveError);
  });
});

describe("daily formatting", () => {
  it("creates a month file with its title, and a client file with frontmatter", () => {
    expect(appendToDay(null, { title: "December 2026", day: "20261201", lines: ["- first"] })).toBe("# December 2026\n\n## 20261201\n- first\n");
    expect(appendToDay(null, { title: "Northwind Supply — December 2026", frontmatter: "---\nclient: Northwind Supply\n---", day: "20261201", lines: ["- a", "  - b"] }))
      .toBe("---\nclient: Northwind Supply\n---\n\n# Northwind Supply — December 2026\n\n## 20261201\n- a\n  - b\n");
  });
  it("stacks bullets under an existing day and keeps every old line", () => {
    const old = "# November 2026\n\n## 20261105\n- one\n\n## 20261118\n- two\n";
    const next = appendToDay(old, { title: "November 2026", day: "20261105", lines: ["- added"] });
    expect(next).toBe("# November 2026\n\n## 20261105\n- one\n- added\n\n## 20261118\n- two\n");
    assertAdditive(old, next);
  });
  it("adds a new day at the end, and inserts an earlier day in ascending order", () => {
    const old = "# November 2026\n\n## 20261105\n- one\n\n## 20261118\n- two\n";
    expect(appendToDay(old, { title: "x", day: "20261119", lines: ["- new"] })).toBe(`${old}\n## 20261119\n- new\n`);
    const mid = appendToDay(old, { title: "x", day: "20261110", lines: ["- mid"] });
    expect(mid).toBe("# November 2026\n\n## 20261105\n- one\n\n## 20261110\n- mid\n\n## 20261118\n- two\n");
    assertAdditive(old, mid);
    expect([...mid.matchAll(/^## (\d{8})$/gm)].map((m) => m[1])).toEqual(["20261105", "20261110", "20261118"]);
  });
  it("handles a file with no final newline and CRLF files without touching old bytes", () => {
    const a = appendToDay("# November 2026\n\n## 20261118\n- two", { title: "x", day: "20261119", lines: ["- new"] });
    expect(a).toBe("# November 2026\n\n## 20261118\n- two\n\n## 20261119\n- new\n");
    const crlf = "# November 2026\r\n\r\n## 20261118\r\n- two\r\n";
    const b = appendToDay(crlf, { title: "x", day: "20261118", lines: ["- more"] });
    expect(b).toBe("# November 2026\r\n\r\n## 20261118\r\n- two\r\n- more\r\n");
    assertAdditive(crlf, b);
  });
  it("plans client items into the client file with one pointer bullet, and links every top-level bullet to the transcript", () => {
    const t = transcriptPath(SPOKEN_AT, "America/New_York");
    expect(t).toBe("Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md");
    expect(transcriptPath(SPOKEN_AT, "America/New_York", 2)).toBe("Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305-2.md");
    const plan = planDaily("20261119", [
      { text: "Renewed the **SSL cert**." },
      { text: "**Blog post** — added one about open houses.", client: "Harbor Pine Realty", sub: ["Took **2 hours**."], pointer: "added a blog post" },
      { text: "Sent the **invoice**.", client: "Harbor Pine Realty" },
    ], t);
    const src = " ([[Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305|src]])";
    expect(plan.writes.map((w) => w.path)).toEqual(["Daily Notes/Clients/Harbor Pine Realty/2026/November.md", "Daily Notes/2026/November.md"]);
    expect(plan.writes[0]).toMatchObject({ title: "Harbor Pine Realty — November 2026", frontmatter: "---\nclient: Harbor Pine Realty\n---" });
    expect(plan.writes[0].lines).toEqual([`- **Blog post** — added one about open houses.${src}`, "  - Took **2 hours**.", `- Sent the **invoice**.${src}`]);
    expect(plan.writes[1].lines).toEqual([
      `- Renewed the **SSL cert**.${src}`,
      `- **[[Clients/Harbor Pine Realty/2026/November|Harbor Pine Realty]]** — added a blog post; Sent the invoice.${src}`,
    ]);
    expect(planDaily("20261119", [{ text: "typed" }], null).writes[0].lines).toEqual(["- typed"]);
    expect(() => planDaily("20261340", [{ text: "x" }], null)).toThrow();
  });
  it("reads Clients.md: folders, aliases and the not-clients list", () => {
    const list = parseClients("| Folder | Also heard as |\n|---|---|\n| [[Clients/Harbor Pine Realty/2026/November\\|Harbor Pine Realty]] | Harbor Pine, HPR |\n| Northwind Supply | Northwind |\n\n## Not clients (do not create)\n\nNames that come up often:\nNorthside Dental / North Side Dental, Vaca.\nIf one of these becomes a client, ask.\n");
    expect(list.clients).toEqual([{ folder: "Harbor Pine Realty", aliases: ["Harbor Pine", "HPR"] }, { folder: "Northwind Supply", aliases: ["Northwind"] }]);
    expect(list.notClients).toEqual(["Northside Dental", "North Side Dental", "Vaca"]);
    expect(resolveName(list, "harbor pine realty")).toMatchObject({ kind: "client", folder: "Harbor Pine Realty", via: "folder" });
    expect(resolveName(list, "hpr")).toMatchObject({ kind: "client", folder: "Harbor Pine Realty", via: "alias", alias: "HPR" });
    expect(resolveName(list, "North Side Dental")).toMatchObject({ kind: "not_client" });
    expect(resolveName(list, "Acme Roofing")).toMatchObject({ kind: "unknown" });
  });
  it("computes the day in the owner's time zone, not UTC", () => {
    const late = Date.UTC(2026, 10, 20, 3, 30); // 22:30 on the 19th in New York
    expect(localTime(late, "America/New_York")).toMatchObject({ ymd: "20261119", hour: 22, minute: 30, iso: "2026-11-19T22:30:00-05:00" });
    expect(localTime(late, "UTC").ymd).toBe("20261120");
  });
  it("writes a transcript with service frontmatter and the body verbatim", () => {
    const body = "ok so um  Harbour pine called,   they want it by friday.\nalso $400 for the banner";
    const f = transcriptFile(dictation(body), { day: "20261119", files: ["Daily Notes/2026/November.md"] });
    expect(f).toBe([
      "---", "captured_at: 2026-11-19T13:05:22-05:00", 'device: "Test Phone"', "run: run_1", "message: msg_1",
      'daily: "[[Daily Notes/2026/November#20261119]]"', "files:", '  - "[[Daily Notes/2026/November]]"', "---", "", body, "",
    ].join("\n"));
    expect(transcriptFile(dictation(body), { day: null, files: [] })).not.toContain("daily:");
  });
  it("flags figures, days and names that reached no bullet", () => {
    const list = parseClients("| Folder | Also heard as |\n|---|---|\n| Harbor Pine Realty | HPR |\n");
    const gaps = coverageGaps("HPR called. They want the banner for $400 by Thursday at 3pm, and Dana said 12 photos.", ["- **Harbor Pine Realty** — wants the banner for **$400**."], list);
    expect(gaps).toEqual(expect.arrayContaining(["Thursday", "3pm", "12", "Dana"]));
    expect(gaps).not.toContain("$400");
    expect(gaps).not.toContain("HPR"); // covered by the client's folder name
  });
  it("spots secrets and leaves ordinary sentences alone", () => {
    expect(looksSecret("the api key is sk-abcdefghijklmnopqrstuvwxyz123456")).toBe(true); // scan-allow: obvious fake key
    expect(looksSecret("password: hunter2hunter2")).toBe(true);
    expect(looksSecret("The secret is consistency, and I reset my password today.")).toBe(false);
  });
});

describe("note classes and links", () => {
  it("classifies paths; path rules win over frontmatter", () => {
    expect(classify("Daily Notes/2026/November.md")).toBe("append-only");
    expect(classify("Daily Notes/2026/November.md", "architecture")).toBe("append-only");
    expect(classify("Daily Notes/Clients/X/2026/November.md")).toBe("append-only");
    expect(classify("Daily Notes/Clients/X/_Profile.md")).toBe("living");
    expect(classify("_Index.md")).toBe("living");
    expect(classify("Tech/Homelab Architecture/Homelab Today.md")).toBe("living");
    expect(classify("Random notes.md")).toBe("append-only");
    expect(classify("Random notes.md", "reference")).toBe("living");
    expect(classify("Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md")).toBe("create-only");
    expect(classify("Daily Notes/RAW/AI Transcriptions/loose.md")).toBe("closed");
    expect(classify("Daily Notes/RAW/2026/November.md")).toBe("closed");
    expect(classify("_Archive/Tech/X (2026-11-19 1432).md")).toBe("archive");
    for (const p of ["CLAUDE.md", "Daily Notes/CLAUDE.md", ".obsidian/app.json", ".stfolder/x.md", "_generated/x.md", "Daily Notes/photo.png", "Daily Notes/.CLAUDE.md.bak"]) expect(classify(p)).toBe("closed");
  });
  it("parses wikilinks, embeds and markdown links, and resolves them without guessing", () => {
    const links = parseLinks("See [[Tech/Notes/Video Editing#2026-10-02|video]] and ![[shot.png]].\n| [[Clients/A/2026/August\\|A]] |\n[doc](Tech/Other%20Note.md) [site](https://x.test/a.md)\n```\n[[not a link]]\n```\n");
    expect(links).toEqual([
      { target: "Tech/Notes/Video Editing", heading: "2026-10-02", alias: "video", embed: false, line: 1 },
      { target: "shot.png", heading: null, alias: null, embed: true, line: 1 },
      { target: "Clients/A/2026/August", heading: null, alias: "A", embed: false, line: 2 },
      { target: "Tech/Other Note.md", heading: null, alias: "doc", embed: false, line: 3 },
    ]);
    const paths = ["Daily Notes/2026/August.md", "Daily Notes/Clients/A/2026/August.md", "Daily Notes/Clients/B/2026/August.md", "Tech/Notes/Video Editing.md"];
    expect(resolveLink("Tech/Notes/Video Editing", null, paths)).toEqual({ kind: "ok", path: "Tech/Notes/Video Editing.md" });
    expect(resolveLink("Clients/A/2026/August", "Daily Notes/2026/August.md", paths)).toEqual({ kind: "ok", path: "Daily Notes/Clients/A/2026/August.md" });
    expect(resolveLink("Video Editing", null, paths)).toEqual({ kind: "ok", path: "Tech/Notes/Video Editing.md" });
    expect(resolveLink("August", null, paths).kind).toBe("ambiguous");
    expect(resolveLink("Nope", null, paths)).toEqual({ kind: "dead" });
  });
  it("reads the frontmatter subset the vault uses", () => {
    expect(parseFrontmatter("---\ntitle: \"A: B\"\ntags: [a, b]\nfiles:\n  - x\n  - y\nempty:\n---\nbody").data).toEqual({ title: "A: B", tags: ["a", "b"], files: ["x", "y"], empty: null });
  });
});

describe("the vault service on a fixture vault", () => {
  let fx: Fixture | null = null;
  const open: Array<{ stop(): void }> = [];
  afterEach(async () => {
    for (const o of open.splice(0)) o.stop();
    await new Promise((r) => setTimeout(r, 30));
    fx?.cleanup();
    fx = null;
  });

  async function boot(opts: { beforeWrite?: (p: string) => void; git?: boolean } = {}) {
    fx = makeVault();
    const git = opts.git === false ? null : new VaultGit({ root: fx.repo, sweepMs: 0, pushEveryMs: 0, pushDelayMs: 3_600_000, settleMs: 0 });
    if (git) {
      await git.start();
      open.push(git);
    }
    const index: Array<{ upserts: any[]; deletes: string[] }> = [];
    const service = new VaultService({ root: fx.vault, git, tz: "America/New_York", now: () => SPOKEN_AT, watch: false, beforeWrite: opts.beforeWrite, onIndex: (c) => index.push(c) });
    service.start();
    open.push(service);
    return { fx, git: git!, service, index };
  }

  it("indexes notes with title, type, tags and summary, and leaves config folders out", async () => {
    const { service } = await boot({ git: false });
    const paths = service.files().map((f) => f.path).sort();
    expect(paths).toContain("Daily Notes/2026/November.md");
    expect(paths).toContain("Daily Notes/RAW/2026/November.md");
    expect(paths.some((p) => p.includes(".obsidian"))).toBe(false);
    expect(service.files().find((f) => f.path === "Tech/Homelab Architecture/Homelab Today.md")).toMatchObject({ title: "Homelab Today", type: "architecture", tags: expect.arrayContaining(["homelab", "proxmox"]), summary: "Current-state snapshot of the homelab.", folder: "Tech/Homelab Architecture" });
    expect(service.files().find((f) => f.path === "Daily Notes/2026/November.md")!.title).toBe("November 2026");
  });

  it("reads a whole note, one day and one section, with the file hash", async () => {
    const { service } = await boot({ git: false });
    const all = service.read({ path: "Daily Notes/2026/November.md" });
    expect(all.text).toContain("## 20261118");
    expect(all.hash).toMatch(/^[0-9a-f]{64}$/);
    const day = service.read({ path: "Daily Notes/2026/November.md", day: "20261105" });
    expect(day.text).toContain("Seasonal Dispatch");
    expect(day.text).not.toContain("20261118");
    expect(day.startLine).toBe(3);
    expect(service.read({ path: "Tech/Homelab Architecture/Homelab Today.md", heading: "Network" }).text).toBe("## Network\nMetalLB hands out addresses on VLAN 30.\n");
    expect(() => service.read({ path: "../CLAUDE.md" })).toThrow(VaultError);
    expect(() => service.read({ path: ".obsidian/app.json" })).toThrow(VaultError);
  });

  it("searches full text, leaves RAW out unless asked, and says where a RAW hit came from", async () => {
    const { service } = await boot({ git: false });
    const r = await service.search({ query: "hero" });
    expect(r.hits.map((h) => h.path)).toEqual(expect.arrayContaining(["Daily Notes/2026/November.md", "Daily Notes/Clients/Harbor Pine Realty/2026/November.md"]));
    expect(r.hits.every((h) => !h.path.startsWith("Daily Notes/RAW/"))).toBe(true);
    expect((await service.search({ query: "zebra-quartz" })).hits).toEqual([]);
    const raw = await service.search({ query: "zebra-quartz", includeRaw: true });
    expect(raw.hits).toHaveLength(1);
    expect(raw.hits[0]).toMatchObject({ path: "Daily Notes/RAW/2026/November.md", from: "raw", line: 3 });
    expect((await service.search({ query: "homelab" })).titles.map((t) => t.path)).toContain("Tech/Homelab Architecture/Homelab Today.md");
    const scoped = await service.search({ query: "hero", folder: "Daily Notes/Clients" });
    expect(scoped.hits.every((h) => h.path.startsWith("Daily Notes/Clients/"))).toBe(true);
  });

  it("lists backlinks with the linking line", async () => {
    const { service } = await boot({ git: false });
    const back = service.backlinks("Daily Notes/Clients/Harbor Pine Realty/2026/November.md");
    expect(back.map((b) => b.path)).toEqual(["Daily Notes/2026/November.md", "Daily Notes/Clients.md"]);
    expect(back[0].context).toContain("swapped the hero photo");
    expect(service.backlinks("Tech/Notes/Video Editing.md").map((b) => b.path).sort()).toEqual(["Tech/Homelab Architecture/Homelab Today.md", "_Index.md"]);
  });

  it("files a dictation: client by alias, pointer bullet, transcript, one agent commit, nothing removed", async () => {
    const { fx, service, git } = await boot();
    const spoken = "HPR called, they want the open house page by Thursday. Quoted $400. Also renewed the SSL cert.";
    const before = fx.read("Daily Notes/2026/November.md");
    const r = await service.appendDaily({
      date: "20261119", run: "run_abc", dictation: dictation(spoken),
      items: [
        { text: "**Open house page** — they want it by **Thursday**. Quoted **$400**.", client: "HPR", pointer: "wants the open house page by Thursday, quoted $400" },
        { text: "Renewed the **SSL cert**." },
      ],
    });
    const src = " ([[Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305|src]])";
    expect(r.date).toBe("20261119");
    expect(r.transcriptPath).toBe("Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md");
    expect(r.files).toEqual([
      { path: "Daily Notes/2026/November.md", status: "appended", bullets: [`- **[[Clients/Harbor Pine Realty/2026/November|Harbor Pine Realty]]** — wants the open house page by Thursday, quoted $400${src}`, `- Renewed the **SSL cert**.${src}`] },
      { path: "Daily Notes/Clients/Harbor Pine Realty/2026/November.md", status: "appended", bullets: [`- **Open house page** — they want it by **Thursday**. Quoted **$400**.${src}`] },
    ]);
    expect(r.flags).toContain('Heard "HPR" → filed under existing client Harbor Pine Realty.');
    const general = fx.read("Daily Notes/2026/November.md");
    expect(general).toBe(`${before}\n## 20261119\n${r.files[0].bullets.join("\n")}\n`);
    expect(fx.read("Daily Notes/Clients/Harbor Pine Realty/2026/November.md")).toMatch(/\n\n## 20261119\n- \*\*Open house page\*\*.*\|src\]\]\)\n$/s);
    const transcript = fx.read(r.transcriptPath!);
    expect(transcript.endsWith(`---\n\n${spoken}\n`)).toBe(true);
    expect(transcript).toContain("captured_at: 2026-11-19T13:05:22-05:00");
    expect(transcript).toContain('daily: "[[Daily Notes/2026/November#20261119]]"');
    expect(transcript).toContain('  - "[[Daily Notes/Clients/Harbor Pine Realty/2026/November]]"');
    // One commit, by the Notes agent, holding all three files, with zero deleted lines.
    expect(fx.git("log", "-1", "--format=%an <%ae>|%s").trim()).toBe(`${AGENT_AUTHOR.name} <${AGENT_AUTHOR.email}>|notes-agent: append Daily Notes/2026/November.md [run_abc]`);
    expect(fx.git("show", "--name-status", "--format=", "HEAD").trim().split("\n").sort()).toEqual([
      "A\tBusiness/Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md", "M\tBusiness/Daily Notes/2026/November.md", "M\tBusiness/Daily Notes/Clients/Harbor Pine Realty/2026/November.md",
    ]);
    expect(fx.deletedLines()).toBe(0);
    expect(r.commit).toBe(fx.git("rev-parse", "HEAD").trim());
    expect(git.status.writesSuspended).toBe(false);
    expect(fx.git("status", "--porcelain").trim()).toBe("");
    // A second dictation in the same minute gets its own file; the first is never touched.
    const again = await service.appendDaily({ date: "20261119", dictation: dictation("One more thing.", { id: "t_two" }), items: [{ text: "One more thing." }] });
    expect(again.transcriptPath).toBe("Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305-2.md");
    expect(fx.read(r.transcriptPath!)).toBe(transcript);
    expect(fx.read("Daily Notes/2026/November.md").startsWith(general)).toBe(true);
    expect(fx.deletedLines()).toBe(0);
  });

  it("creates the month and client files when they do not exist yet", async () => {
    const { fx, service } = await boot();
    const r = await service.appendDaily({ date: "20261202", items: [{ text: "Fixed checkout.", client: "Northwind Supply" }, { text: "Admin day." }] });
    expect(r.files.map((f) => [f.path, f.status])).toEqual([["Daily Notes/2026/December.md", "created"], ["Daily Notes/Clients/Northwind Supply/2026/December.md", "created"]]);
    expect(fx.read("Daily Notes/2026/December.md")).toBe("# December 2026\n\n## 20261202\n- **[[Clients/Northwind Supply/2026/December|Northwind Supply]]** — Fixed checkout.\n- Admin day.\n");
    expect(fx.read("Daily Notes/Clients/Northwind Supply/2026/December.md")).toBe("---\nclient: Northwind Supply\n---\n\n# Northwind Supply — December 2026\n\n## 20261202\n- Fixed checkout.\n");
    expect(r.transcriptPath).toBeNull();
    expect(r.flags).toContain("Filed under 20261202; today is 20261119.");
  });

  it("rejects an unknown client and a listed non-client, and writes nothing", async () => {
    const { fx, service } = await boot();
    const head = fx.git("rev-parse", "HEAD").trim();
    await expect(service.appendDaily({ date: "20261119", dictation: dictation("Acme Roofing wants a site."), items: [{ text: "Wants a site.", client: "Acme Roofing" }, { text: "Other." }] })).rejects.toThrow(/not a client folder/);
    await expect(service.appendDaily({ date: "20261119", items: [{ text: "x", client: "Northside Dental" }] })).rejects.toThrow(/not a client folder/);
    expect(fx.git("rev-parse", "HEAD").trim()).toBe(head);
    expect(fx.git("status", "--porcelain").trim()).toBe("");
    expect(existsSync(join(fx.vault, "Daily Notes", "RAW", "AI Transcriptions"))).toBe(false);
    expect(existsSync(join(fx.vault, "Daily Notes", "Clients", "Acme Roofing"))).toBe(false);
  });

  it("refuses to write in the owner's RAW notes, config, rule files, or outside the vault", async () => {
    const { fx, service } = await boot();
    const outside = join(fx.dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "target.md"), "outside\n");
    symlinkSync(outside, join(fx.vault, "Linked"), "junction");
    const refused = [
      "Daily Notes/RAW/2026/November.md", "Daily Notes/RAW/new.md", "Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md", ".obsidian/app.json", ".obsidian/notes.md",
      "CLAUDE.md", "Daily Notes/CLAUDE.md", "../CLAUDE.md", "../../escape.md", "Daily Notes/../../escape.md", join(fx.dir, "abs.md"), "Linked/target.md", "Linked/new.md",
      "_Archive/x.md", "Daily Notes/photo.png", "Daily Notes/2026/bad:name.md", "daily notes/2026/Lower.md",
    ];
    for (const p of refused) await expect(service.appendText(p, "- injected\n"), p).rejects.toThrow(VaultError);
    expect(fx.git("status", "--porcelain").trim().replace(/\/$/, "")).toBe("?? Business/Linked"); // only the link this test planted
    expect(existsSync(join(fx.dir, "escape.md"))).toBe(false);
    expect(existsSync(join(outside, "new.md"))).toBe(false);
    // The same call on an ordinary note works, so the refusals above are the rules and not a broken helper.
    await service.appendText("Random notes.md", "- allowed\n");
    expect(fx.read("Random notes.md")).toContain("- allowed");
  });

  it("creates a transcript once: the path is create-only and nothing else under RAW can be written", async () => {
    const { fx, service } = await boot();
    const d = dictation("Just thinking out loud, nothing to file.");
    const first = await service.fileTranscript(d);
    expect(first.path).toBe("Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305.md");
    const text = fx.read(first.path);
    expect(text).toBe('---\ncaptured_at: 2026-11-19T13:05:22-05:00\ndevice: "Test Phone"\nrun: run_1\nmessage: msg_1\n---\n\nJust thinking out loud, nothing to file.\n');
    expect(fx.git("log", "-1", "--format=%an|%s").trim()).toBe(`${AGENT_AUTHOR.name}|notes-agent: transcript ${first.path} [run_1]`);
    await expect(service.appendText(first.path, "more\n")).rejects.toThrow(/permanent/);
    const second = await service.fileTranscript(d);
    expect(second.path).toBe("Daily Notes/RAW/AI Transcriptions/2026/11/2026-11-19 1305-2.md");
    expect(fx.read(first.path)).toBe(text);
    expect(fx.read("Daily Notes/RAW/2026/November.md")).toContain("called dana abt the hero pic");
    expect(fx.deletedLines()).toBe(0);
  });

  it("re-reads when an outside editor saves mid-write, and keeps both texts", async () => {
    let raced = 0;
    const { fx, service } = await boot({
      beforeWrite: (p) => {
        // Obsidian on the same machine saves the file between our read and our write, once.
        if (p === "Daily Notes/2026/November.md" && raced++ === 0) appendFileSync(join(fx!.vault, ...p.split("/")), "- typed in Obsidian at the same moment\n");
      },
    });
    await service.appendDaily({ date: "20261118", items: [{ text: "Added by the agent." }] });
    const text = fx.read("Daily Notes/2026/November.md");
    expect(raced).toBe(2);
    expect(text).toContain("- typed in Obsidian at the same moment\n");
    expect(text).toContain("- Added by the agent.\n");
    expect(text).toContain("- Wrote two blog posts for the **Business** site.\n");
    expect(fx.deletedLines()).toBe(0);
  });

  it("gives up after three tries when the file never stops changing, and writes nothing of its own", async () => {
    let n = 0;
    const { fx, service } = await boot({ git: false, beforeWrite: (p) => appendFileSync(join(fx!.vault, ...p.split("/")), `- churn ${++n}\n`) });
    await expect(service.appendText("Random notes.md", "- mine\n")).rejects.toThrow(/kept changing/);
    expect(n).toBe(3);
    expect(fx.read("Random notes.md")).not.toContain("- mine");
  });

  it("commits an outside edit first, as the owner's, before the agent writes the same file", async () => {
    const { fx, service } = await boot();
    appendFileSync(join(fx.vault, "Daily Notes", "2026", "November.md"), "- edited in Obsidian earlier\n");
    await service.appendDaily({ date: "20261118", items: [{ text: "Agent bullet." }] });
    const log = fx.git("log", "-2", "--format=%an|%s").trim().split("\n");
    expect(log[0]).toBe(`${AGENT_AUTHOR.name}|notes-agent: append Daily Notes/2026/November.md`);
    expect(log[1]).toMatch(/^Test Owner \(.+\)\|external: 1 file changed outside HomeBase$/);
    expect(fx.git("show", "-U0", "--format=", "HEAD").includes("edited in Obsidian earlier")).toBe(false);
    expect(fx.deletedLines()).toBe(0);
  });

  it("refuses to file a secret", async () => {
    const { fx, service } = await boot();
    await expect(service.appendDaily({ date: "20261119", items: [{ text: "The api key is sk-abcdefghijklmnopqrstuvwxyz123456." }] })).rejects.toThrow(/secret/i); // scan-allow: obvious fake key
    expect(fx.git("status", "--porcelain").trim()).toBe("");
  });
});

describe("vault git", () => {
  let fx: Fixture | null = null;
  const gits: VaultGit[] = [];
  afterEach(async () => {
    for (const g of gits.splice(0)) {
      g.stop();
      await g.idle();
    }
    fx?.cleanup();
    fx = null;
  });
  const start = async (o: Partial<ConstructorParameters<typeof VaultGit>[0]> = {}) => {
    const g = new VaultGit({ root: fx!.repo, sweepMs: 0, pushEveryMs: 0, pushDelayMs: 3_600_000, settleMs: 0, ...o });
    gits.push(g);
    await g.start();
    return g;
  };

  it("sweeps outside changes into one external: commit and leaves Obsidian's window state alone", async () => {
    fx = makeVault();
    const g = await start();
    appendFileSync(join(fx.vault, "Random notes.md"), "typed in Obsidian\n");
    fx.write("New from Obsidian.md", "# New\n");
    fx.write(".obsidian/workspace.json", "{}");
    fx.write(".obsidian/workspace-mobile.json", "{}");
    fx.write(".homebase/plans/p.md", "plan");
    const r = await g.sweep();
    expect(r?.files).toBe(2);
    expect(fx.git("log", "-1", "--format=%an|%ae|%s").trim()).toMatch(/^Test Owner \(.+\)\|owner@example\.test\|external: 2 files changed outside HomeBase$/);
    expect(fx.git("status", "--porcelain", "--untracked-files=all").trim().split("\n").map((l) => l.slice(3)).sort()).toEqual([
      "Business/.homebase/plans/p.md", "Business/.obsidian/workspace-mobile.json", "Business/.obsidian/workspace.json",
    ]);
    expect(await g.sweep()).toBeNull();
    expect(g.status.sweptFiles).toBe(2);
  });

  it("leaves a file that was modified a moment ago for the next sweep", async () => {
    fx = makeVault();
    const g = await start({ settleMs: 60_000 });
    appendFileSync(join(fx.vault, "Random notes.md"), "still typing\n");
    expect(await g.sweep()).toBeNull();
    expect(fx.git("status", "--porcelain").trim()).toMatch(/^M "?Business\/Random notes\.md"?$/);
  });

  it("commits a deletion made in Obsidian as the owner's own", async () => {
    fx = makeVault();
    const g = await start();
    rmSync(join(fx.repo, "Untitled.md")); // the owner removing a file in Obsidian (fixture repo only)
    const r = await g.sweep();
    expect(r?.files).toBe(1);
    expect(fx.git("show", "--name-status", "--format=%an", "HEAD")).toMatch(/Test Owner \(.+\)\n\nD\tUntitled\.md/);
  });

  it("pushes plainly to the remote and reports nothing unpushed", async () => {
    fx = makeVault();
    const g = await start();
    appendFileSync(join(fx.vault, "Random notes.md"), "change\n");
    await g.commitAgent(["Business/Random notes.md"], "notes-agent: append Random notes.md [run_1]");
    expect(g.status.unpushed).toBe(1);
    expect(await g.push()).toBe(true);
    expect(g.status).toMatchObject({ unpushed: 0, pushError: null, diverged: false });
    expect(g.status.lastPushAt).not.toBeNull();
    expect(fx.remoteGit("log", "-1", "--format=%an|%s", "main").trim()).toBe(`${AGENT_AUTHOR.name}|notes-agent: append Random notes.md [run_1]`);
  });

  it("fast-forwards at start only when strictly behind and clean", async () => {
    fx = makeVault();
    const other = join(fx.dir, "other");
    execFileSync("git", ["clone", "-q", fx.remote, other]);
    writeFileSync(join(other, "from-elsewhere.md"), "x\n");
    execFileSync("git", ["-C", other, "add", "-A"]);
    execFileSync("git", ["-C", other, "-c", "user.name=E", "-c", "user.email=e@x.test", "commit", "-q", "-m", "elsewhere"]);
    execFileSync("git", ["-C", other, "push", "-q", "origin", "main"]);
    const g = await start();
    expect(g.status.diverged).toBe(false);
    expect(existsSync(join(fx.repo, "from-elsewhere.md"))).toBe(true);
    expect(fx.git("rev-parse", "HEAD").trim()).toBe(fx.remoteGit("rev-parse", "main").trim());
  });

  it("does not merge or push when the remote has commits this machine does not", async () => {
    fx = makeVault();
    const other = join(fx.dir, "other");
    execFileSync("git", ["clone", "-q", fx.remote, other]);
    writeFileSync(join(other, "from-elsewhere.md"), "x\n");
    execFileSync("git", ["-C", other, "add", "-A"]);
    execFileSync("git", ["-C", other, "-c", "user.name=E", "-c", "user.email=e@x.test", "commit", "-q", "-m", "elsewhere"]);
    execFileSync("git", ["-C", other, "push", "-q", "origin", "main"]);
    appendFileSync(join(fx.vault, "Random notes.md"), "local\n");
    fx.git("commit", "-q", "-am", "local work");
    const remoteHead = fx.remoteGit("rev-parse", "main").trim();
    const local = fx.git("rev-parse", "HEAD").trim();
    const g = await start();
    expect(g.status.diverged).toBe(true);
    expect(await g.push()).toBe(false);
    expect(fx.remoteGit("rev-parse", "main").trim()).toBe(remoteHead); // never forced
    expect(fx.git("rev-parse", "HEAD").trim()).toBe(local); // never merged, rebased or reset
    expect(existsSync(join(fx.repo, "from-elsewhere.md"))).toBe(false);
  });

  it("treats a rejected push as divergence instead of retrying or forcing", async () => {
    fx = makeVault();
    const g = await start();
    const other = join(fx.dir, "other");
    execFileSync("git", ["clone", "-q", fx.remote, other]);
    writeFileSync(join(other, "late.md"), "x\n");
    execFileSync("git", ["-C", other, "add", "-A"]);
    execFileSync("git", ["-C", other, "-c", "user.name=E", "-c", "user.email=e@x.test", "commit", "-q", "-m", "late"]);
    execFileSync("git", ["-C", other, "push", "-q", "origin", "main"]);
    const remoteHead = fx.remoteGit("rev-parse", "main").trim();
    appendFileSync(join(fx.vault, "Random notes.md"), "local\n");
    await g.commitAgent(["Business/Random notes.md"], "notes-agent: append Random notes.md");
    expect(await g.push()).toBe(false);
    expect(g.status.diverged).toBe(true);
    expect(g.status.pushError).toBeTruthy();
    expect(fx.remoteGit("rev-parse", "main").trim()).toBe(remoteHead);
  });

  it("suspends agent writes when an agent commit turns out to have removed a line", async () => {
    fx = makeVault();
    const g = await start();
    fx.write("Daily Notes/2026/November.md", fx.read("Daily Notes/2026/November.md").replace("- **Week so far** — mostly interview practice.\n", ""));
    const info = await g.commitAgent(["Business/Daily Notes/2026/November.md"], "notes-agent: append Daily Notes/2026/November.md [planted]");
    expect(info.deletedLines).toBe(1);
    expect(g.status.writesSuspended).toBe(true);
    await expect(g.commitAgent(["Business/Random notes.md"], "notes-agent: append x")).rejects.toThrow(/suspended/);
    const service = new VaultService({ root: fx.vault, git: g, watch: false });
    await expect(service.appendDaily({ date: "20261119", items: [{ text: "x" }] })).rejects.toThrow(/suspended/);
  });
});

describe("decideNotes", () => {
  const env = (mode: "manual" | "auto" | "plan") => ({ cwd: "/vaults/obsidian/Business", profile: "strict" as const, mode });
  it("allows reads inside the vault and the read tools", () => {
    for (const t of ["vault_search", "vault_read", "vault_list", "vault_backlinks", "vault_resolve_names"]) expect(decideNotes(`mcp__vault__${t}`, {}, env("manual")).tier).toBe("auto");
    expect(decideNotes("Read", { file_path: "Daily Notes/2026/November.md" }, env("manual")).tier).toBe("auto");
    expect(decideNotes("Grep", { pattern: "x" }, env("auto")).tier).toBe("auto");
  });
  it("asks before adding in Manual, allows it in Auto, denies it in Plan", () => {
    expect(decideNotes("mcp__vault__vault_append_daily", {}, env("manual"))).toMatchObject({ tier: "ask", risk: "low" });
    expect(decideNotes("mcp__vault__vault_append_daily", {}, env("auto")).tier).toBe("auto");
    expect(decideNotes("mcp__vault__vault_append_daily", {}, env("plan")).tier).toBe("deny");
  });
  it("hard-denies everything else in every mode", () => {
    for (const mode of ["manual", "auto", "plan"] as const) {
      for (const t of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "Skill", "mcp__vault__vault_delete", "mcp__vault__vault_revise_note", "mcp__gmail__gmail_search", "mcp__other__x"]) {
        expect(decideNotes(t, { command: "rm -rf .", file_path: "x.md" }, env(mode)).tier, `${t} in ${mode}`).toBe("deny");
      }
    }
    expect(decideNotes("Read", { file_path: "/etc/passwd" }, env("auto")).tier).toBe("deny");
    expect(decideNotes("Read", { file_path: "../CLAUDE.md" }, env("auto")).tier).toBe("deny");
    expect(decideNotes("Read", { file_path: "/vaults/obsidian/Business/.env" }, env("auto")).tier).toBe("deny");
  });
  it("offers six tools and none that deletes, moves, renames or rewrites", () => {
    expect([...VAULT_TOOL_NAMES]).toEqual(["vault_search", "vault_read", "vault_list", "vault_backlinks", "vault_resolve_names", "vault_append_daily"]);
    expect(VAULT_TOOL_NAMES.some((t) => /delete|remove|move|rename|write|revise|replace/.test(t))).toBe(false);
  });
  it("keeps the unrelated CLAUDE.md above the vault out of the agent's context", () => {
    const fx = makeVault({ remote: false });
    try {
      expect(parentClaudeMd(fx.vault, fx.repo)).toEqual([join(fx.repo, "CLAUDE.md")]);
      const cfg = notesConfig(testConfig(), {}, { vaultRoot: fx.vault, gitRoot: fx.repo, prompt: () => "prompt for today" });
      expect(cfg).toMatchObject({ key: "notes", tools: ["Read", "Glob", "Grep"], modes: ["manual", "auto"], sandboxDir: fx.vault, projectDirs: [], addDirs: [], settings: { claudeMdExcludes: [join(fx.repo, "CLAUDE.md")] } });
      expect(cfg.systemPrompt).toBe("prompt for today");
      expect(cfg.extraDisallowed).toEqual(expect.arrayContaining(["Write", "Edit", "Bash", "PowerShell", "WebFetch", "WebSearch", "Task", "Agent", "Skill"]));
    } finally {
      fx.cleanup();
    }
  });
});
