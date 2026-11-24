import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, watch, writeFileSync, writeSync,
  type FSWatcher,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { VaultCaptureCard, VaultFile } from "@homebase/protocol";
import {
  CLIENTS_DIR, CLIENTS_FILE, TRANSCRIPTS_DIR, appendToDay, assertAdditive, coverageGaps, localTime, looksSecret, parseClients, parseDay, planDaily, recognizerHints, resolveName,
  transcriptFile, transcriptPath, type ClientList, type DailyItem, type Dictation, type NameResolution,
} from "./daily";
import type { VaultGit } from "./git";
import { parseLinks, resolveLink, type Backlink, type NoteLink } from "./links";

/**
 * The vault service (NOTES-PLAN.md 2.4, 3, 5, 7.1): the only code that reads or writes the Obsidian
 * vault for HomeBase. Root confinement, an in-memory index kept fresh by a watcher, ripgrep search,
 * and locked read-before-write with the additive check. There is no delete, rename or move here.
 */

// ---------------------------------------------------------------- note classes (3.1)

export type NoteClass = "append-only" | "living" | "create-only" | "archive" | "closed";

const LIVING_TYPES = new Set(["architecture", "client-profile", "reference", "runbook", "registry", "vision"]);
const LOG_TYPES = new Set(["log", "adr"]);

/** Which class a vault-relative path is in. Path rules win over frontmatter; anything unmatched is append-only. */
export function classify(path: string, type?: string | null): NoteClass {
  const p = path.replace(/\\/g, "/");
  const seg = p.split("/");
  const base = seg.at(-1) ?? "";
  if (seg.some((s) => s.startsWith(".")) || seg[0] === "_generated" || /^claude\.md$/i.test(base) || !/\.md$/i.test(base)) return "closed";
  if (seg[0] === "_Archive") return "archive";
  if (seg[0] === "Daily Notes" && seg[1] === "RAW") {
    return seg[2] === "AI Transcriptions" && seg.length === 6 && /^\d{4}$/.test(seg[3]) && /^\d{2}$/.test(seg[4]) ? "create-only" : "closed";
  }
  if (seg[0] === "Daily Notes") {
    if (seg.length === 3 && /^\d{4}$/.test(seg[1])) return "append-only";
    if (seg[1] === "Clients" && seg.length === 5 && /^\d{4}$/.test(seg[3])) return "append-only";
    if (p === CLIENTS_FILE) return "append-only";
    if (seg[1] === "Clients" && seg.length === 4 && base === "_Profile.md") return "living";
  }
  if (seg[0] === "Interviews" || (seg[0] === "Tech" && seg[1] === "Notes")) return "append-only";
  if (base === "_Index.md") return "living";
  if (seg[0] === "Tech" && seg[1] === "Homelab Architecture") return "living";
  if (type && LOG_TYPES.has(type)) return "append-only";
  if (type && LIVING_TYPES.has(type)) return "living";
  return "append-only";
}

export class VaultError extends Error {
  constructor(public code: "path" | "class" | "exists" | "not_found" | "race" | "secret" | "client" | "input" | "suspended", message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- index

export interface NoteMeta extends VaultFile {
  frontmatter: Record<string, unknown>;
  headings: Array<{ level: number; text: string; line: number }>;
  links: NoteLink[];
  cls: NoteClass;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const fileId = (path: string) => `vf_${createHash("sha1").update(path).digest("hex").slice(0, 20)}`;

/** The small YAML subset the vault's frontmatter uses: scalars, inline lists and dash lists. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; bodyStart: number } {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return { data: {}, bodyStart: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return { data: {}, bodyStart: 0 };
  const data: Record<string, unknown> = {};
  const unq = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");
  let key: string | null = null;
  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\r$/, "");
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      (data[key] as unknown[]).push(unq(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    if (!v) data[key] = null;
    else if (/^\[.*\]$/.test(v)) data[key] = v.slice(1, -1).split(",").map(unq).filter(Boolean);
    else data[key] = unq(v);
  }
  return { data, bodyStart: end + 1 };
}

function describe(path: string, text: string, st: { mtimeMs: number; size: number }): NoteMeta {
  const norm = text.replace(/\r\n?/g, "\n");
  const { data, bodyStart } = parseFrontmatter(norm);
  const lines = norm.split("\n");
  const headings: NoteMeta["headings"] = [];
  const tags = new Set<string>();
  let fence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i + 1 });
    for (const m of lines[i].matchAll(/(?:^|\s)#([A-Za-z][\w/-]*)/g)) tags.add(m[1]);
  }
  const fmTags = data.tags;
  for (const t of Array.isArray(fmTags) ? fmTags : typeof fmTags === "string" ? fmTags.split(/[,\s]+/) : []) if (t) tags.add(String(t).replace(/^#/, ""));
  const base = path.split("/").pop()!.replace(/\.md$/i, "");
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const type = str(data.type);
  return {
    id: fileId(path), path, title: (str(data.title) ?? headings.find((h) => h.level === 1)?.text ?? base).slice(0, 500), type: type ? type.slice(0, 60) : null,
    tags: [...tags].slice(0, 100).map((t) => t.slice(0, 100)), summary: str(data.summary)?.slice(0, 1000) ?? null, mtime: Math.round(st.mtimeMs), size: st.size,
    hash: sha256(text), folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    frontmatter: data, headings, links: parseLinks(norm), cls: classify(path, type),
  };
}

export const toVaultFile = (m: NoteMeta): VaultFile => ({
  id: m.id, path: m.path, title: m.title, type: m.type, tags: m.tags, summary: m.summary, mtime: m.mtime, size: m.size, hash: m.hash, folder: m.folder,
});

// ---------------------------------------------------------------- service

export interface SearchHit {
  path: string;
  title: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
  /** Set when the hit came from the owner's RAW notes, transcripts or an archived version. */
  from?: "raw" | "archive";
}

export interface ReadResult {
  path: string;
  title: string;
  text: string;
  /** SHA-256 of the whole file on disk. */
  hash: string;
  mtime: number;
  /** 1-based line the returned text starts at. */
  startLine: number;
  totalLines: number;
  truncated: boolean;
  cls: NoteClass;
}

export interface CaptureResult {
  date: string;
  files: Array<{ path: string; status: "created" | "appended"; bullets: string[] }>;
  transcriptPath: string | null;
  flags: string[];
  commit: string | null;
}

export interface VaultServiceOptions {
  /** The vault root: the folder Obsidian calls the vault (holds `_Index.md` and `Daily Notes/`). */
  root: string;
  git?: VaultGit | null;
  /** The owner's time zone. "Today" is never the server's clock zone. */
  tz?: string;
  now?: () => number;
  log?: (...a: unknown[]) => void;
  /** Called with index changes: note metadata to upsert and ids to remove. */
  onIndex?: (change: { upserts: VaultFile[]; deletes: string[] }) => void;
  /** Path to the ripgrep executable. Missing: a slower built-in search is used. */
  rg?: string;
  /** Test seam: runs between computing a write and committing it to disk, as an outside editor would. */
  beforeWrite?: (path: string) => void | Promise<void>;
  watch?: boolean;
}

const MAX_READ = 700_000;
const MAX_HITS = 50;
const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", ".homebase", ".stfolder", "node_modules"]);
const UNSAFE_NAME = /[:*?"<>|]|[. ]$/;

export class VaultService {
  readonly root: string;
  readonly tz: string;
  private real: string;
  private git: VaultGit | null;
  private now: () => number;
  private log: (...a: unknown[]) => void;
  private index = new Map<string, NoteMeta>();
  private watcher: FSWatcher | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private rgMissing = false;

  constructor(private o: VaultServiceOptions) {
    this.root = resolve(o.root);
    this.real = realpathSync.native(this.root);
    this.git = o.git ?? null;
    this.tz = o.tz ?? "America/New_York";
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  // ---------- lifecycle and index ----------

  start() {
    this.refresh();
    if (this.o.watch !== false) {
      try {
        this.watcher = watch(this.root, { recursive: true }, (_e, name) => {
          if (name && String(name).split(/[\\/]/).some((s) => SKIP_DIRS.has(s))) return;
          this.scheduleRefresh();
        });
        this.watcher.on("error", () => {});
      } catch (err) {
        this.log(`vault: file watcher unavailable (${(err as Error).message}); falling back to polling`);
      }
      // A safety net for missed events (network mounts, editors that replace files).
      const t = setInterval(() => this.refresh(), 60_000);
      t.unref();
      this.timers.push(t);
    }
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.splice(0)) clearInterval(t);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private scheduleRefresh() {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 400);
    this.refreshTimer.unref();
  }

  private walk(dir: string, out: string[]) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never followed: a link could point outside the vault
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) this.walk(abs, out);
      } else if (e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith(".")) out.push(abs);
    }
  }

  /** Re-reads the tree. Only files whose size or mtime changed are opened again. */
  refresh() {
    const files: string[] = [];
    this.walk(this.root, files);
    const seen = new Set<string>();
    const upserts: VaultFile[] = [];
    for (const abs of files) {
      const path = relative(this.root, abs).split(sep).join("/");
      seen.add(path);
      try {
        const st = statSync(abs);
        const cur = this.index.get(path);
        if (cur && cur.mtime === Math.round(st.mtimeMs) && cur.size === st.size) continue;
        const meta = describe(path, readFileSync(abs, "utf8"), st);
        if (!cur || JSON.stringify(toVaultFile(cur)) !== JSON.stringify(toVaultFile(meta))) upserts.push(toVaultFile(meta));
        this.index.set(path, meta);
      } catch {
        // vanished between the walk and the read; the next pass settles it
      }
    }
    const deletes: string[] = [];
    for (const [path, meta] of this.index) {
      if (seen.has(path)) continue;
      this.index.delete(path);
      deletes.push(meta.id);
    }
    if (upserts.length || deletes.length) this.o.onIndex?.({ upserts, deletes });
  }

  /** Every indexed note's metadata, for the hub. */
  files(): VaultFile[] {
    return [...this.index.values()].map(toVaultFile);
  }

  get size() {
    return this.index.size;
  }

  meta(path: string): NoteMeta | undefined {
    return this.index.get(path);
  }

  list(f: { folder?: string; type?: string; tag?: string } = {}): VaultFile[] {
    const folder = f.folder ? f.folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
    return [...this.index.values()]
      .filter((m) => (!folder || m.path.startsWith(`${folder}/`)) && (!f.type || m.type === f.type) && (!f.tag || m.tags.includes(f.tag.replace(/^#/, ""))))
      .filter((m) => m.cls !== "archive" || folder.startsWith("_Archive"))
      .sort((a, b) => a.path.localeCompare(b.path)).map(toVaultFile);
  }

  // ---------- confinement (3.2 layer 4) ----------

  /** A clean vault-relative path, or a VaultError. Rejects absolute paths, `..`, and control characters. */
  normalize(input: string): string {
    if (typeof input !== "string" || !input.trim() || /[\0-\x1f]/.test(input)) throw new VaultError("path", "That is not a usable path.");
    let p = input.trim().replace(/\\/g, "/");
    if (/^[a-zA-Z]:/.test(p) || p.startsWith("/")) {
      // An absolute path is accepted only when it is inside the vault.
      const abs = resolve(p);
      const rel = relative(this.root, abs);
      if (rel.startsWith("..") || resolve(this.root, rel) !== abs) throw new VaultError("path", "That path is outside the vault.");
      p = rel.split(sep).join("/");
    }
    const seg = p.split("/").filter((s) => s !== "" && s !== ".");
    if (!seg.length || seg.some((s) => s === "..")) throw new VaultError("path", "That path is outside the vault.");
    return seg.join("/");
  }

  /**
   * The absolute path for a vault-relative one, after checking that the real location (symlinks
   * resolved, for the deepest folder that exists) is inside the vault root.
   */
  abs(path: string): string {
    const rel = this.normalize(path);
    const full = join(this.root, ...rel.split("/"));
    let probe = full;
    while (!existsSync(probe)) {
      const up = dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    const real = realpathSync.native(probe);
    const inside = real === this.real || real.startsWith(this.real + sep);
    if (!inside) throw new VaultError("path", "That path leads outside the vault.");
    try {
      if (lstatSync(full).isSymbolicLink()) throw new VaultError("path", "That path is a link; the vault service does not follow links.");
    } catch (err) {
      if (err instanceof VaultError) throw err;
    }
    return full;
  }

  /** May the agent write here, and how? Throws a VaultError that says why not. */
  guardWrite(path: string, want: "append" | "create-transcript"): string {
    const rel = this.normalize(path);
    const cls = classify(rel, this.index.get(rel)?.type);
    if (want === "create-transcript") {
      if (cls !== "create-only") throw new VaultError("class", `Transcripts go only in ${TRANSCRIPTS_DIR}/<YYYY>/<MM>/.`);
    } else if (cls === "closed") {
      throw new VaultError("class", /^Daily Notes\/RAW\//.test(rel)
        ? "Daily Notes/RAW is the owner's own writing. The agent never writes there."
        : `${rel} is closed to the agent (configuration, rule files and non-note files are never written).`);
    } else if (cls === "create-only" || cls === "archive") {
      throw new VaultError("class", `${rel} is permanent once written. It cannot be changed.`);
    }
    this.abs(rel);
    this.checkNames(rel);
    return rel;
  }

  /**
   * Names are matched exactly: a path that differs from an existing one only by case is refused (it would
   * split a folder on Linux and collide on Windows), and new names must be Windows-safe (2.5).
   */
  private checkNames(rel: string) {
    let dir = this.root;
    let fresh = false;
    for (const s of rel.split("/")) {
      if (!fresh) {
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          // unreadable: treated as new
        }
        if (!entries.includes(s)) {
          const clash = entries.find((x) => x.toLowerCase() === s.toLowerCase());
          if (clash) throw new VaultError("path", `"${s}" differs from the existing "${clash}" only by case.`);
          fresh = true;
        }
      }
      if (fresh && UNSAFE_NAME.test(s)) throw new VaultError("path", `"${s}" is not a Windows-safe name (no : * ? " < > | and no trailing dot or space).`);
      dir = join(dir, s);
    }
  }

  // ---------- reading ----------

  read(input: { path: string; heading?: string; day?: string; lines?: [number, number] }): ReadResult {
    const rel = this.normalize(input.path);
    if (!/\.md$/i.test(rel)) throw new VaultError("path", "Only markdown notes can be read here.");
    const abs = this.abs(rel);
    let raw: string;
    let st;
    try {
      raw = readFileSync(abs, "utf8");
      st = statSync(abs);
    } catch {
      throw new VaultError("not_found", `No note at ${rel}.`);
    }
    const all = raw.replace(/\r\n?/g, "\n").split("\n");
    let from = 1;
    let to = all.length;
    if (input.day) {
      const i = all.findIndex((l) => new RegExp(`^##\\s+${input.day!.replace(/\D/g, "")}\\s*$`).test(l));
      if (i < 0) throw new VaultError("not_found", `${rel} has no ## ${input.day} section.`);
      const j = all.findIndex((l, k) => k > i && /^#{1,2}\s/.test(l));
      [from, to] = [i + 1, j < 0 ? all.length : j];
    } else if (input.heading) {
      const want = input.heading.replace(/^#+\s*/, "").trim().toLowerCase();
      const i = all.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").replace(/\s*#*\s*$/, "").trim().toLowerCase() === want);
      if (i < 0) throw new VaultError("not_found", `${rel} has no heading "${input.heading}".`);
      const level = /^#+/.exec(all[i])![0].length;
      const j = all.findIndex((l, k) => k > i && new RegExp(`^#{1,${level}}\\s`).test(l));
      [from, to] = [i + 1, j < 0 ? all.length : j];
    } else if (input.lines) {
      from = Math.max(1, Math.floor(input.lines[0]));
      to = Math.min(all.length, Math.max(from, Math.floor(input.lines[1])));
    }
    let text = all.slice(from - 1, to).join("\n");
    const truncated = text.length > MAX_READ;
    if (truncated) text = text.slice(0, MAX_READ);
    const meta = this.index.get(rel);
    return {
      path: rel, title: meta?.title ?? rel.split("/").pop()!.replace(/\.md$/i, ""), text, hash: sha256(raw), mtime: Math.round(st.mtimeMs), startLine: from,
      totalLines: all.length, truncated, cls: classify(rel, meta?.type),
    };
  }

  private scopeOf(path: string): "raw" | "archive" | null {
    return path.startsWith("Daily Notes/RAW/") ? "raw" : path.startsWith("_Archive/") ? "archive" : null;
  }

  /** Full-text search. RAW (transcripts included) and `_Archive/` are left out unless asked for. */
  async search(q: { query: string; folder?: string; includeRaw?: boolean; includeArchive?: boolean; regex?: boolean; limit?: number }): Promise<{ hits: SearchHit[]; titles: VaultFile[]; truncated: boolean }> {
    const query = String(q.query ?? "").trim();
    if (!query) return { hits: [], titles: [], truncated: false };
    const folder = q.folder ? this.normalize(q.folder) : "";
    if (folder) this.abs(folder);
    const limit = Math.min(MAX_HITS, Math.max(1, q.limit ?? MAX_HITS));
    const allowed = (p: string) => {
      const s = this.scopeOf(p);
      return (!folder || p === folder || p.startsWith(`${folder}/`)) && (s !== "raw" || !!q.includeRaw) && (s !== "archive" || !!q.includeArchive);
    };
    const ql = query.toLowerCase();
    const titles = [...this.index.values()].filter((m) => allowed(m.path) && (m.title.toLowerCase().includes(ql) || m.path.toLowerCase().includes(ql)))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 15).map(toVaultFile);
    let hits: SearchHit[] | null = null;
    if (!this.rgMissing) hits = await this.rgSearch(query, folder, !!q.regex).catch(() => null);
    if (!hits) hits = this.scanSearch(query, !!q.regex);
    hits = hits.filter((h) => allowed(h.path));
    const truncated = hits.length > limit;
    return {
      hits: hits.slice(0, limit).map((h) => ({ ...h, title: this.index.get(h.path)?.title ?? h.path, ...(this.scopeOf(h.path) ? { from: this.scopeOf(h.path)! } : {}) })),
      titles, truncated,
    };
  }

  private rgSearch(query: string, folder: string, regex: boolean): Promise<SearchHit[] | null> {
    return new Promise((done) => {
      const args = ["--json", "--smart-case", "--max-count", "20", "-C", "2", "--max-columns", "600", "--glob", "*.md", "--glob", "!.obsidian/**", "--glob", "!.git/**", "--glob", "!.trash/**"];
      if (!regex) args.push("--fixed-strings");
      args.push("--", query, folder || ".");
      execFile(this.o.rg ?? "rg", args, { cwd: this.root, timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          this.rgMissing = true;
          this.log("vault: ripgrep (rg) is not installed; using the built-in search");
          return done(null);
        }
        if (err && (err as any).code !== 1 && !stdout) return done(null); // exit 1 means no matches
        const hits: SearchHit[] = [];
        let ctx: string[] = [];
        let last: SearchHit | null = null;
        for (const line of String(stdout).split("\n")) {
          if (!line) continue;
          let j: any;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          const text = (j.data?.lines?.text ?? "").replace(/\r?\n$/, "");
          if (j.type === "begin") {
            ctx = [];
            last = null;
          } else if (j.type === "context") {
            if (last && j.data.line_number > last.line && last.after.length < 2) last.after.push(text);
            ctx.push(text);
            if (ctx.length > 2) ctx.shift();
          } else if (j.type === "match") {
            const path = String(j.data?.path?.text ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
            last = { path, title: path, line: j.data.line_number, text, before: ctx, after: [] };
            ctx = [];
            hits.push(last);
            if (hits.length > 400) break;
          }
        }
        done(hits);
      });
    });
  }

  /** The same search without ripgrep: a scan of the indexed notes. */
  private scanSearch(query: string, regex: boolean): SearchHit[] {
    let test: (l: string) => boolean;
    const smart = /[A-Z]/.test(query) ? "" : "i";
    if (regex) {
      try {
        const re = new RegExp(query, smart);
        test = (l) => re.test(l);
      } catch {
        throw new VaultError("input", "That search pattern is not a valid regular expression.");
      }
    } else {
      const ql = smart ? query.toLowerCase() : query;
      test = (l) => (smart ? l.toLowerCase() : l).includes(ql);
    }
    const hits: SearchHit[] = [];
    for (const path of [...this.index.keys()].sort()) {
      let lines: string[];
      try {
        lines = readFileSync(join(this.root, ...path.split("/")), "utf8").replace(/\r\n?/g, "\n").split("\n");
      } catch {
        continue;
      }
      let n = 0;
      for (let i = 0; i < lines.length && n < 20; i++) {
        if (!test(lines[i])) continue;
        n++;
        hits.push({ path, title: path, line: i + 1, text: lines[i].slice(0, 600), before: lines.slice(Math.max(0, i - 2), i), after: lines.slice(i + 1, i + 3) });
      }
      if (hits.length > 400) break;
    }
    return hits;
  }

  /** Notes that link to `path`, each with the linking line. Archived versions are left out. */
  backlinks(path: string): Backlink[] {
    const rel = this.normalize(path);
    const paths = [...this.index.keys()];
    const out: Backlink[] = [];
    for (const m of this.index.values()) {
      // Transcripts and the owner's raw notes are left out, like in search; so are archived versions.
      if (m.path === rel || m.cls === "archive" || m.path.startsWith("Daily Notes/RAW/")) continue;
      let lines: string[] | null = null;
      for (const l of m.links) {
        const r = resolveLink(l.target, m.path, paths);
        if (r.kind !== "ok" || r.path !== rel) continue;
        if (!lines) {
          try {
            lines = readFileSync(join(this.root, ...m.path.split("/")), "utf8").replace(/\r\n?/g, "\n").split("\n");
          } catch {
            lines = [];
          }
        }
        out.push({ path: m.path, title: m.title, line: l.line, context: (lines[l.line - 1] ?? "").trim().slice(0, 400) });
        break;
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Where a wikilink written in `from` leads. */
  resolve(target: string, from: string | null) {
    return resolveLink(target, from, this.index.keys());
  }

  // ---------- clients ----------

  clients(): ClientList {
    try {
      return parseClients(readFileSync(this.abs(CLIENTS_FILE), "utf8"));
    } catch {
      return { clients: [], notClients: [] };
    }
  }

  hints(): string[] {
    return recognizerHints(this.clients());
  }

  private clientFolderExists(folder: string): boolean {
    try {
      return readdirSync(this.abs(CLIENTS_DIR), { withFileTypes: true }).some((e) => e.isDirectory() && e.name === folder);
    } catch {
      return false;
    }
  }

  resolveNames(names: string[]): Array<NameResolution & { folderExists?: boolean }> {
    const list = this.clients();
    return names.slice(0, 50).map((n) => {
      const r = resolveName(list, String(n));
      return r.kind === "client" ? { ...r, folderExists: this.clientFolderExists(r.folder) } : r;
    });
  }

  // ---------- writing (2.4) ----------

  /** One writer at a time across the service, which also gives every file its own lock. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.lock.then(fn, fn);
    this.lock = p.catch(() => {});
    return p;
  }

  private readFresh(abs: string): string | null {
    try {
      return readFileSync(abs, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Read-before-write. The new text is computed from the file as it is on disk right now; if the file
   * changed while that was happening (Obsidian saved it), the write is recomputed on the new text. Three
   * tries, then it fails. An existing file is only ever extended: assertAdditive guards every write.
   */
  private async writeChecked(rel: string, compute: (old: string | null) => string, mode: "additive" | "create"): Promise<{ created: boolean }> {
    const abs = this.abs(rel);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const old = this.readFresh(abs);
      const before = old === null ? null : sha256(old);
      if (mode === "create" && old !== null) throw new VaultError("exists", `${rel} already exists. It is permanent and cannot be changed.`);
      const next = compute(old);
      if (old !== null) assertAdditive(old, next);
      await this.o.beforeWrite?.(rel);
      const now = this.readFresh(abs);
      if ((now === null ? null : sha256(now)) !== before) continue; // changed underneath us: go again on the fresh text
      mkdirSync(dirname(abs), { recursive: true });
      if (old === null) {
        // Exclusive create: fails instead of replacing a file that appeared in the meantime.
        let fd: number;
        try {
          fd = openSync(abs, "wx");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            if (mode === "create") throw new VaultError("exists", `${rel} already exists. It is permanent and cannot be changed.`);
            continue;
          }
          throw err;
        }
        try {
          writeSync(fd, next);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } else {
        const tmp = join(dirname(abs), `.${randomBytes(6).toString("hex")}.hb-tmp`);
        const fd = openSync(tmp, "wx");
        try {
          writeSync(fd, next);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          renameSync(tmp, abs);
        } catch (err) {
          try {
            unlinkSync(tmp); // our own temp file, never a note
          } catch {
            // already gone
          }
          throw err;
        }
      }
      return { created: old === null };
    }
    throw new VaultError("race", `${rel} kept changing while it was being written (another editor has it open). Nothing was written; try again.`);
  }

  private gitPath(rel: string): string {
    return this.git ? relative(this.git.root, join(this.root, ...rel.split("/"))).split(sep).join("/") : rel;
  }

  /** The first free transcript path for a dictation. */
  private freeTranscriptPath(d: Dictation): string {
    for (let n = 1; n < 100; n++) {
      const p = transcriptPath(d.capturedAt, d.tz, n);
      if (!existsSync(this.abs(p))) return p;
    }
    throw new VaultError("exists", "Too many transcripts in the same minute.");
  }

  /**
   * Files one capture (NOTES-PLAN.md 4.1): the transcript, the client month files, the general log with
   * its pointer bullets, all in one commit. The model supplies bullets and routing; this writes the format.
   */
  appendDaily(input: { date: string; items: DailyItem[]; dictation?: Dictation | null; transcriptLink?: string | null; run?: string | null }): Promise<CaptureResult> {
    return this.exclusive(async () => {
      const day = String(input.date ?? "").replace(/\D/g, "");
      const parsed = parseDay(day);
      if (!parsed) throw new VaultError("input", `"${input.date}" is not a date in YYYYMMDD form.`);
      const items = (Array.isArray(input.items) ? input.items : []).slice(0, 40);
      if (!items.length) throw new VaultError("input", "No items to file.");
      if (this.git?.status.writesSuspended) throw new VaultError("suspended", `Agent writes are suspended: ${this.git.status.suspendedReason}. The owner has to look first.`);
      const list = this.clients();
      const flags: string[] = [];
      const d = input.dictation ?? null;

      // Routing. A client must be a folder that exists; an alias is normalized and flagged; anything else is refused.
      const routed: DailyItem[] = items.map((it) => {
        if (!it.client) return it;
        const r = resolveName(list, it.client);
        if (r.kind !== "client" || !this.clientFolderExists(r.folder)) {
          throw new VaultError("client", `"${it.client}" is not a client folder under ${CLIENTS_DIR}. Nothing was written. Ask the owner for the exact name before filing; do not guess.`);
        }
        if (r.via === "alias") flags.push(`Heard "${it.client}" → filed under existing client ${r.folder}.`);
        return { ...it, client: r.folder };
      });
      if (d) {
        for (const c of list.clients) {
          if (!routed.some((i) => i.client === c.folder)) continue;
          const heard = c.aliases.find((a) => new RegExp(`(?<![A-Za-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i").test(d.text));
          const named = new RegExp(c.folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(d.text);
          if (heard && !named && !flags.some((f) => f.includes(`client ${c.folder}.`))) flags.push(`Heard "${heard}" → filed under existing client ${c.folder}.`);
        }
      }
      const all = routed.flatMap((i) => [i.text, i.pointer ?? "", ...(i.sub ?? [])]).join("\n");
      if (looksSecret(all) || (d && looksSecret(d.text))) {
        throw new VaultError("secret", "Refused: this looks like it contains a password, token or key value. The vault's rules forbid writing secrets. Nothing was written.");
      }

      // A dictation that already has its transcript (an earlier call, or an earlier run) is linked, not written again.
      const tPath = d ? this.freeTranscriptPath(d) : input.transcriptLink ? this.normalize(input.transcriptLink) : null;
      const plan = planDaily(day, routed, tPath);
      for (const w of plan.writes) this.guardWrite(w.path, "append");
      if (d && tPath) this.guardWrite(tPath, "create-transcript");

      // An outside edit that is still uncommitted goes in first, as its own commit (2.3).
      if (this.git) await this.git.commitExternal(plan.writes.map((w) => this.gitPath(w.path)));

      const written: string[] = [];
      const files: CaptureResult["files"] = [];
      let commit: string | null = null;
      try {
        if (d && tPath) {
          await this.writeChecked(tPath, () => transcriptFile({ ...d, run: d.run ?? input.run ?? null }, { day, files: plan.writes.map((w) => w.path) }), "create");
          written.push(tPath);
        }
        for (const w of plan.writes) {
          const r = await this.writeChecked(w.path, (old) => appendToDay(old, { title: w.title, frontmatter: w.frontmatter, day, lines: w.lines }), "additive");
          written.push(w.path);
          files.push({ path: w.path, status: r.created ? "created" : "appended", bullets: w.bullets });
        }
      } finally {
        // Whatever reached the disk is committed, so a failure half way never leaves the tree dirty.
        if (this.git && written.length) {
          const general = plan.writes.at(-1)!.path;
          const info = await this.git.commitAgent(written.map((p) => this.gitPath(p)), `notes-agent: append ${general}${input.run ? ` [${input.run}]` : ""}`);
          commit = info.sha;
        }
        this.refresh();
      }
      files.reverse(); // the general log first, as the owner reads it
      const spoken = d ? localTime(d.capturedAt, d.tz).ymd : null;
      const today = localTime(this.now(), this.tz);
      if (spoken && spoken !== day) flags.push(`Filed under ${day}, not the day it was spoken (${spoken}).`);
      else if (!spoken && day !== today.ymd) flags.push(`Filed under ${day}; today is ${today.ymd}.`);
      if (d) {
        const gaps = coverageGaps(d.text, plan.writes.flatMap((w) => w.bullets), list);
        if (gaps.length) flags.push(`Not in the note: ${gaps.join(", ")}`);
      }
      return { date: day, files, transcriptPath: tPath, flags, commit };
    });
  }

  /** A dictation that ended with no bullets (a question back, or a failed run) still gets its transcript. */
  fileTranscript(d: Dictation): Promise<{ path: string; commit: string | null }> {
    return this.exclusive(async () => {
      if (looksSecret(d.text)) throw new VaultError("secret", "The dictation looks like it contains a secret; no transcript was written.");
      const path = this.freeTranscriptPath(d);
      this.guardWrite(path, "create-transcript");
      await this.writeChecked(path, () => transcriptFile(d, { day: null, files: [] }), "create");
      let commit: string | null = null;
      if (this.git) commit = (await this.git.commitAgent([this.gitPath(path)], `notes-agent: transcript ${path}${d.run ? ` [${d.run}]` : ""}`)).sha;
      this.refresh();
      return { path, commit };
    });
  }

  /** A raw additive write, for tests of the invariants. Not exposed as a tool. */
  appendText(path: string, text: string): Promise<{ created: boolean }> {
    return this.exclusive(async () => {
      const rel = this.guardWrite(path, "append");
      const r = await this.writeChecked(rel, (old) => (old === null ? text : `${old}${old.endsWith("\n") || old === "" ? "" : "\n"}${text}`), "additive");
      this.refresh();
      return r;
    });
  }
}

export const cardOf = (r: CaptureResult): VaultCaptureCard => ({
  type: "vault_capture", date: r.date, files: r.files.map((f) => ({ path: f.path, status: f.status, bullets: f.bullets.map((b) => b.slice(0, 4000)) })),
  transcriptPath: r.transcriptPath, flags: r.flags.map((f) => f.slice(0, 500)), commit: r.commit,
});
