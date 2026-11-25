/**
 * Pure helpers for the files, editor and terminal workspace (issue #3). No DOM, no React Native: shared by the
 * workspace view (a DOM component) and the tests.
 */

export type Sep = "/" | "\\";

export const sepOf = (path: string): Sep => (/^[A-Za-z]:[\\/]|^\\\\/.test(path) ? "\\" : "/");

/** "C:\Users\me" + "a.txt" -> "C:\Users\me\a.txt"; "/" + "etc" -> "/etc". */
export function joinPath(dir: string, name: string, sep: Sep = sepOf(dir)): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : `${dir}${sep}${name}`;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (i < 0) return null;
  if (i === 0) return trimmed === "/" ? null : "/";
  const p = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(p) ? `${p}\\` : p;
}

/** Why a new file or folder name will not do, or null. */
export function badName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Type a name.";
  if (n === "." || n === "..") return "That name is reserved.";
  if (/[\\/]/.test(n)) return "A name cannot contain / or \\.";
  if (/[\u0000-\u001f]/.test(n)) return "A name cannot contain control characters.";
  if (n.length > 255) return "That name is too long.";
  return null;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function fmtTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** A key typed while the on-screen Ctrl is held: a letter (or @[\]^_) becomes its control code. */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const c = data.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  if (data === "?") return "\x7f";
  return data;
}

/** The phone key bar: what each key sends. */
export const KEY_BAR: Array<{ label: string; send?: string; ctrl?: true; title: string }> = [
  { label: "Esc", send: "\x1b", title: "Escape" },
  { label: "Tab", send: "\t", title: "Tab" },
  { label: "Ctrl", ctrl: true, title: "Hold Ctrl for the next key" },
  { label: "^C", send: "\x03", title: "Ctrl+C: stop the running command" },
  { label: "←", send: "\x1b[D", title: "Left" },
  { label: "↑", send: "\x1b[A", title: "Up" },
  { label: "↓", send: "\x1b[B", title: "Down" },
  { label: "→", send: "\x1b[C", title: "Right" },
  { label: "|", send: "|", title: "Pipe" },
  { label: "~", send: "~", title: "Tilde" },
  { label: "/", send: "/", title: "Slash" },
  { label: "-", send: "-", title: "Dash" },
];

/** A save's text in the file's own line endings. */
export const withEol = (lines: string[], eol: "\n" | "\r\n") => lines.join(eol);

/** The folder a session's files open in: its own folder, else the project's, else its last run's, else the agent's first. */
export function startFolder(i: {
  threadCwd?: string | null; projectCwd?: string | null; lastRunCwd?: string | null; agentDefault?: string | null; workspaces?: Array<{ cwd: string }> | null;
}): string | null {
  return i.threadCwd || i.lastRunCwd || i.projectCwd || i.agentDefault || i.workspaces?.[0]?.cwd || null;
}
