/**
 * Wikilink parsing and resolution for the vault (NOTES-PLAN.md 5.2). Pure functions.
 * Handles `[[path]]`, `[[path|alias]]`, `[[path#heading]]`, `![[embed]]` and markdown links to `.md` files.
 */

export interface NoteLink {
  /** What the link points at, as written, without heading or alias. */
  target: string;
  heading: string | null;
  alias: string | null;
  embed: boolean;
  /** 1-based line in the source note. */
  line: number;
}

const WIKI = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MD = /(?<!!)\[([^\]\n]*)\]\(([^)\s]+?\.md)(#[^)\s]*)?\)/gi;

export function parseLinks(text: string): NoteLink[] {
  const out: NoteLink[] = [];
  let fence = false;
  text.replace(/\r\n?/g, "\n").split("\n").forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    for (const m of raw.matchAll(WIKI)) {
      // Inside a table the alias pipe is written `\|`.
      const [left, ...rest] = m[2].split(/\\?\|/);
      const [target, ...h] = left.split("#");
      if (!target.trim() && !h.length) continue;
      out.push({ target: target.trim(), heading: h.length ? h.join("#").trim() : null, alias: rest.length ? rest.join("|").trim() : null, embed: m[1] === "!", line: i + 1 });
    }
    for (const m of raw.matchAll(MD)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(m[2])) continue; // a URL, not a note
      let target = m[2];
      try {
        target = decodeURIComponent(target);
      } catch {
        // keep as written
      }
      out.push({ target, heading: m[3] ? m[3].slice(1) : null, alias: m[1] || null, embed: false, line: i + 1 });
    }
  });
  return out;
}

export type Resolution = { kind: "ok"; path: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "dead" };

const strip = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\.md$/i, "");

/**
 * Resolution order: exact vault-relative path, then a path relative to the linking note's folder, then
 * a unique path-suffix match (the daily log links `[[Clients/<Client>/2026/August]]`, relative to
 * `Daily Notes/`), then a unique base name. Ambiguous and dead links are reported, never guessed.
 */
export function resolveLink(target: string, from: string | null, paths: Iterable<string>): Resolution {
  const want = strip(target).toLowerCase();
  if (!want) return from ? { kind: "ok", path: from } : { kind: "dead" };
  const all = [...paths];
  const keyed = all.map((p) => ({ p, k: strip(p).toLowerCase() }));
  const exact = keyed.find((x) => x.k === want);
  if (exact) return { kind: "ok", path: exact.p };
  if (from && from.includes("/")) {
    const rel = `${from.slice(0, from.lastIndexOf("/"))}/${strip(target)}`.toLowerCase();
    const hit = keyed.find((x) => x.k === rel);
    if (hit) return { kind: "ok", path: hit.p };
  }
  const suffix = keyed.filter((x) => x.k.endsWith(`/${want}`));
  if (suffix.length === 1) return { kind: "ok", path: suffix[0].p };
  if (suffix.length > 1) {
    // Prefer the candidate nearest the linking note (longest shared folder prefix), when that is unique.
    if (from) {
      const share = (p: string) => {
        const a = p.split("/");
        const b = from.split("/");
        let n = 0;
        while (n < a.length && n < b.length && a[n] === b[n]) n++;
        return n;
      };
      const ranked = suffix.map((x) => ({ ...x, s: share(x.p) })).sort((a, b) => b.s - a.s);
      if (ranked[0].s > ranked[1].s) return { kind: "ok", path: ranked[0].p };
    }
    return { kind: "ambiguous", candidates: suffix.map((x) => x.p).slice(0, 10) };
  }
  if (!want.includes("/")) {
    const base = keyed.filter((x) => x.k.split("/").pop() === want);
    if (base.length === 1) return { kind: "ok", path: base[0].p };
    if (base.length > 1) return { kind: "ambiguous", candidates: base.map((x) => x.p).slice(0, 10) };
  }
  return { kind: "dead" };
}

export interface Backlink {
  path: string;
  title: string;
  line: number;
  /** The linking line, as context. */
  context: string;
}
