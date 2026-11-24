/**
 * Daily-note formatting for the vault (NOTES-PLAN.md 3.2, 4). Pure functions: no file system, no git.
 *
 * The service writes the structure (month files, day headers, client files, pointer bullets, transcript
 * links). The model only supplies bullets and routing.
 */

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

// ---------------------------------------------------------------- additive invariant

export class AdditiveError extends Error {
  constructor(public line: number, public text: string) {
    super(`Refused: the write would change or remove line ${line} ("${text.slice(0, 80)}"). Journals are append-only.`);
  }
}

const splitLines = (s: string) => {
  const l = s.split("\n");
  if (l.at(-1) === "") l.pop(); // the final newline is a terminator, not a line
  return l;
};

/**
 * Every line of `old` must appear in `next`, in the same order, byte for byte. Throws otherwise.
 * The one exception is the `updated:` line inside the frontmatter, which the service itself may rewrite.
 */
export function assertAdditive(old: string, next: string): void {
  const a = splitLines(old);
  const b = splitLines(next);
  const fmEnd = a[0]?.trimEnd() === "---" ? a.findIndex((l, i) => i > 0 && l.trimEnd() === "---") : -1;
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const stamp = i > 0 && i < fmEnd && /^updated:/.test(a[i]);
    while (j < b.length && !(b[j] === a[i] || (stamp && /^updated:/.test(b[j])))) j++;
    if (j >= b.length) throw new AdditiveError(i + 1, a[i]);
    j++;
  }
}

// ---------------------------------------------------------------- dates in the owner's time zone

export interface LocalTime {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  /** YYYYMMDD */
  ymd: string;
  /** Minutes east of UTC. */
  offsetMin: number;
  /** ISO 8601 with the zone's offset. */
  iso: string;
  weekday: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function validTz(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone. The server's own clock zone is never used. */
export function localTime(ms: number, tz: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const n = (k: string) => Number(parts[k]);
  const t = { year: n("year"), month: n("month"), day: n("day"), hour: n("hour") % 24, minute: n("minute"), second: n("second") };
  const offsetMin = Math.round((Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return {
    ...t, offsetMin, weekday: parts.weekday,
    ymd: `${t.year}${pad(t.month)}${pad(t.day)}`,
    iso: `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
  };
}

/** A real calendar day as YYYYMMDD, or null. */
export function parseDay(ymd: string): { year: number; month: number; day: number; monthName: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day || year < 2000 || year > 2100) return null;
  return { year, month, day, monthName: MONTHS[month - 1] };
}

// ---------------------------------------------------------------- paths

export const DAILY_DIR = "Daily Notes";
export const CLIENTS_DIR = `${DAILY_DIR}/Clients`;
export const CLIENTS_FILE = `${DAILY_DIR}/Clients.md`;
export const TRANSCRIPTS_DIR = `${DAILY_DIR}/RAW/AI Transcriptions`;

export const generalLogPath = (ymd: string) => {
  const d = parseDay(ymd)!;
  return `${DAILY_DIR}/${d.year}/${d.monthName}.md`;
};
export const clientLogPath = (client: string, ymd: string) => {
  const d = parseDay(ymd)!;
  return `${CLIENTS_DIR}/${client}/${d.year}/${d.monthName}.md`;
};
/** `Daily Notes/RAW/AI Transcriptions/<YYYY>/<MM>/<YYYY-MM-DD HHmm>.md`; a second one in the same minute gets `-2`. */
export function transcriptPath(capturedAt: number, tz: string, n = 1): string {
  const t = localTime(capturedAt, tz);
  return `${TRANSCRIPTS_DIR}/${t.year}/${pad(t.month)}/${t.year}-${pad(t.month)}-${pad(t.day)} ${pad(t.hour)}${pad(t.minute)}${n > 1 ? `-${n}` : ""}.md`;
}
const noExt = (p: string) => p.replace(/\.md$/i, "");

// ---------------------------------------------------------------- Clients.md

export interface ClientEntry {
  folder: string;
  aliases: string[];
}
export interface ClientList {
  clients: ClientEntry[];
  notClients: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** Reads the client table and the "Not clients" list out of `Daily Notes/Clients.md`. */
export function parseClients(md: string): ClientList {
  const clients: ClientEntry[] = [];
  const notClients: string[] = [];
  let section = "";
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      section = h[1].toLowerCase();
      continue;
    }
    if (line.startsWith("|")) {
      // Cells are split on unescaped pipes: a wikilink alias inside a table is written `\|`.
      const cells = line.replace(/^\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
      if (cells.length < 2 || /^:?-{2,}/.test(cells[0]) || /^folder$/i.test(cells[0])) continue;
      const link = /\[\[\s*(?:Daily Notes\/)?Clients\/([^/\]|\\]+)\//.exec(cells[0]);
      const folder = (link ? link[1] : cells[0].replace(/\[\[|\]\]/g, "").split(/\\?\|/).pop() ?? "").trim();
      if (!folder) continue;
      clients.push({ folder, aliases: cells[1].split(",").map((a) => a.trim()).filter(Boolean) });
    } else if (section.startsWith("not clients") && line && !/^(names that|if one of)/i.test(line)) {
      for (const group of line.split(",")) for (const v of group.split(" / ")) {
        const name = v.trim().replace(/\.$/, "");
        if (name) notClients.push(name);
      }
    }
  }
  return { clients, notClients };
}

export type NameResolution =
  | { name: string; kind: "client"; folder: string; via: "folder" | "alias"; alias?: string }
  | { name: string; kind: "not_client"; listed: string }
  | { name: string; kind: "unknown" };

/** Folder first, then "Also heard as", then the "Not clients" list. Nothing is guessed. */
export function resolveName(list: ClientList, name: string): NameResolution {
  const n = norm(name);
  if (!n) return { name, kind: "unknown" };
  for (const c of list.clients) if (norm(c.folder) === n) return { name, kind: "client", folder: c.folder, via: "folder" };
  for (const c of list.clients) for (const a of c.aliases) if (norm(a) === n) return { name, kind: "client", folder: c.folder, via: "alias", alias: a };
  for (const x of list.notClients) if (norm(x) === n) return { name, kind: "not_client", listed: x };
  return { name, kind: "unknown" };
}

/** Names worth handing to a speech recognizer: folders and aliases. */
export const recognizerHints = (list: ClientList) => [...new Set(list.clients.flatMap((c) => [c.folder, ...c.aliases]).filter((s) => s.length <= 80))].slice(0, 300);

// ---------------------------------------------------------------- month files

/**
 * Adds lines under `## <day>` in a month file and returns the new text. A missing file is created with
 * its title (and frontmatter for a client file); a missing day header is inserted in ascending order.
 * Existing lines are never touched: the result always passes assertAdditive against `old`.
 */
export function appendToDay(old: string | null, o: { title: string; frontmatter?: string; day: string; lines: string[] }): string {
  if (old === null || old.trim() === "") {
    const head = `${o.frontmatter ? `${o.frontmatter}\n\n` : ""}# ${o.title}\n\n## ${o.day}\n${o.lines.join("\n")}\n`;
    return old ? `${old}${old.endsWith("\n") ? "" : "\n"}${head}` : head;
  }
  const eol = old.includes("\r\n") ? "\r" : "";
  const lines = old.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const add = o.lines.map((l) => l + eol);
  const isBlank = (l: string) => l.trim() === "";
  const dayOf = (l: string) => /^##\s+(\d{8})\s*$/.exec(l)?.[1] ?? null;
  const at = lines.findIndex((l) => dayOf(l) === o.day);
  if (at >= 0) {
    let end = lines.findIndex((l, i) => i > at && /^#{1,2}\s/.test(l));
    if (end < 0) end = lines.length;
    while (end > at + 1 && isBlank(lines[end - 1])) end--; // after the last bullet, before the blank line
    lines.splice(end, 0, ...add);
  } else {
    const later = lines.findIndex((l) => {
      const d = dayOf(l);
      return d !== null && d > o.day;
    });
    if (later >= 0) {
      const block = [`## ${o.day}${eol}`, ...add, eol];
      if (later > 0 && !isBlank(lines[later - 1])) block.unshift(eol);
      lines.splice(later, 0, ...block);
    } else {
      if (!isBlank(lines.at(-1) ?? "")) lines.push(eol);
      lines.push(`## ${o.day}${eol}`, ...add);
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- bullets

export interface DailyItem {
  /** One distinct item, in the owner's voice. */
  text: string;
  /** Exact folder name under Daily Notes/Clients, when the item is about a client. */
  client?: string;
  /** Indented sub-bullets (figures, details). */
  sub?: string[];
  /** One line for the pointer bullet in the general log. Defaults to a shortened `text`. */
  pointer?: string;
}

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").replace(/^\s*[-*+]\s+/, "").replace(/^#+\s*/, "").trim();
const plain = (s: string) => s.replace(/\*\*|__/g, "");

function pointerText(items: DailyItem[]): string {
  const parts = items.map((i) => {
    const p = oneLine(i.pointer ?? "");
    if (p) return p;
    const t = plain(oneLine(i.text));
    const first = /^(.{20,160}?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
    return first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first;
  });
  const joined = parts.join("; ");
  return joined.length > 320 ? `${joined.slice(0, 317).trimEnd()}…` : joined;
}

export interface DailyPlan {
  day: string;
  /** Files to write, in order. The general log is last. */
  writes: Array<{ path: string; title: string; frontmatter?: string; lines: string[]; bullets: string[] }>;
}

/**
 * Lays out one capture: client items go to the client's month file, with one pointer bullet per client
 * in the general log; everything else goes to the general log. Each top-level bullet written from a
 * dictation ends with a link to its transcript.
 */
export function planDaily(day: string, items: DailyItem[], transcript: string | null): DailyPlan {
  const d = parseDay(day);
  if (!d) throw new Error(`"${day}" is not a date in YYYYMMDD form.`);
  const src = transcript ? ` ([[${noExt(transcript)}|src]])` : "";
  const month = `${d.monthName} ${d.year}`;
  const general: string[] = [];
  const generalBullets: string[] = [];
  const byClient = new Map<string, DailyItem[]>();
  const order: Array<{ client: string } | { item: DailyItem }> = [];
  for (const raw of items) {
    const item = { ...raw, text: oneLine(raw.text), sub: (raw.sub ?? []).map(oneLine).filter(Boolean) };
    if (!item.text) continue;
    if (item.client) {
      if (!byClient.has(item.client)) {
        byClient.set(item.client, []);
        order.push({ client: item.client });
      }
      byClient.get(item.client)!.push(item);
    } else order.push({ item });
  }
  const writes: DailyPlan["writes"] = [];
  for (const [client, list] of byClient) {
    const lines: string[] = [];
    const bullets: string[] = [];
    for (const i of list) {
      const b = `- ${i.text}${src}`;
      lines.push(b, ...i.sub!.map((s) => `  - ${s}`));
      bullets.push(b, ...i.sub!.map((s) => `  - ${s}`));
    }
    writes.push({ path: clientLogPath(client, day), title: `${client} — ${month}`, frontmatter: `---\nclient: ${client}\n---`, lines, bullets });
  }
  for (const o of order) {
    if ("client" in o) {
      const b = `- **[[Clients/${o.client}/${d.year}/${d.monthName}|${o.client}]]** — ${pointerText(byClient.get(o.client)!)}${src}`;
      general.push(b);
      generalBullets.push(b);
    } else {
      const b = `- ${o.item.text}${src}`;
      const subs = o.item.sub!.map((s) => `  - ${s}`);
      general.push(b, ...subs);
      generalBullets.push(b, ...subs);
    }
  }
  if (!general.length) throw new Error("Nothing to file: every item was empty.");
  writes.push({ path: generalLogPath(day), title: month, lines: general, bullets: generalBullets });
  return { day, writes };
}

// ---------------------------------------------------------------- transcripts

export interface Dictation {
  id: string;
  /** Exactly what the owner sent. */
  text: string;
  capturedAt: number;
  tz: string;
  device: string | null;
  message: string | null;
  run: string | null;
}

const yq = (s: string) => JSON.stringify(s);

/** The transcript file: frontmatter written by the service, then the dictation verbatim. No cleanup, no summary. */
export function transcriptFile(d: Dictation, o: { day?: string | null; files: string[] }): string {
  const t = localTime(d.capturedAt, d.tz);
  const fm = [
    "---",
    `captured_at: ${t.iso}`,
    `device: ${yq(d.device ?? "unknown")}`,
    ...(d.run ? [`run: ${d.run}`] : []),
    ...(d.message ? [`message: ${d.message}`] : []),
    ...(o.day ? [`daily: ${yq(`[[${noExt(generalLogPath(o.day))}#${o.day}]]`)}`] : []),
    ...(o.files.length ? ["files:", ...o.files.map((f) => `  - ${yq(`[[${noExt(f)}]]`)}`)] : []),
    "---",
    "",
  ].join("\n");
  return `${fm}\n${d.text}${d.text.endsWith("\n") ? "" : "\n"}`;
}

// ---------------------------------------------------------------- coverage

const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const MONTH_RE = MONTHS.join("|").toLowerCase();
const STOP = new Set(["i", "i'm", "i'll", "i've", "i'd", "ok", "okay", "the", "a", "an", "and", "but", "so", "also", "then", "we", "he", "she", "they", "it", "this", "that", "there", "today", "tomorrow", "yesterday", "let's", "lets", "my", "our", "his", "her", "yes", "no", "not", "need", "got", "just", "still", "add", "note", "notes", "daily", "update", "please", "can", "will", "is", "was", "if", "when", "for", "to", "in", "on", "at", "of"]);
const squash = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/,(?=\d{3})/g, "");

/**
 * Numbers, money, dates, times, capitalized names and known client aliases that are in the transcript and
 * in none of the bullets. Computed in code so a dropped figure is visible without rereading the dictation.
 */
export function coverageGaps(transcript: string, bullets: string[], list: ClientList): string[] {
  const hay = squash(bullets.join("\n"));
  const has = (s: string) => hay.includes(squash(s));
  const out: string[] = [];
  const seen = new Set<string>();
  const miss = (label: string, ...alts: string[]) => {
    const k = squash(label);
    if (seen.has(k)) return;
    seen.add(k);
    if (![label, ...alts].some((a) => a && has(a))) out.push(label);
  };
  let text = transcript;
  // Known clients first: an alias counts as covered when the bullets name the client's folder.
  for (const c of list.clients) for (const name of [c.folder, ...c.aliases]) {
    const re = new RegExp(`(?<![A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "i");
    if (re.test(text)) {
      miss(name, c.folder, ...c.aliases);
      text = text.replace(new RegExp(re.source, "gi"), " ");
    }
  }
  for (const m of text.matchAll(/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?\b/gi)) miss(m[0].replace(/\s+/g, " ").trim(), m[0].replace(/[$\s]/g, ""));
  text = text.replace(/\$\s?\d[\d,]*(?:\.\d+)?/g, " ");
  for (const m of text.matchAll(/\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi)) miss(m[0].trim(), m[0].replace(/[\s.]/g, ""));
  text = text.replace(/\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi, " ");
  for (const m of text.matchAll(new RegExp(`\\b(?:${MONTH_RE})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"))) miss(m[0], m[0].replace(/(st|nd|rd|th)$/i, ""));
  for (const m of text.matchAll(new RegExp(`\\b(?:${WEEKDAYS})\\b`, "gi"))) miss(m[0][0].toUpperCase() + m[0].slice(1).toLowerCase());
  for (const m of text.matchAll(/(?<![\w$])\d[\d,]*(?:\.\d+)?%?(?:st|nd|rd|th)?(?![\w])/g)) {
    const bare = m[0].replace(/(st|nd|rd|th)$/i, "");
    miss(m[0], bare);
  }
  // Capitalized names that are not just the first word of a sentence.
  for (const m of text.matchAll(/(?<=[a-z0-9,;:]\s)([A-Z][\w'’&-]*(?:\s+[A-Z][\w'’&-]*)*)/g)) {
    const words = m[1].split(/\s+/);
    if (words.every((w) => STOP.has(w.toLowerCase()) || new RegExp(`^(?:${WEEKDAYS}|${MONTH_RE})$`, "i").test(w))) continue;
    miss(m[1]);
  }
  return out.slice(0, 20);
}

// ---------------------------------------------------------------- secrets

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bglpat-[A-Za-z0-9_-]{16,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./,
  /\b(?:password|passwd|pwd|api[ _-]?key|secret|access[ _-]?token|auth[ _-]?token)\b\s*(?:is|[:=])\s*["'`]?(?=\S*\d)[^\s"'`]{8,}/i,
];

/** True when text looks like it carries a password, token or key value. The vault's rules forbid writing one. */
export const looksSecret = (text: string) => SECRET_PATTERNS.some((re) => re.test(text));
