import { z } from "zod";

/**
 * Files, the editor and the terminal on the connector's machine (issue #3).
 *
 * The owner browses, edits and runs a shell on the machine where a connector runs, as the user that
 * connector runs as. Everything travels over the hub's authenticated WebSocket: a device asks the hub,
 * the hub relays to the connector of the agent the device names, and the answer goes back to that one
 * socket. Nothing is stored on the hub except audit-log lines (path, device, time; never contents or keystrokes).
 *
 * Owner only: the hub takes these frames only from a device that may approve, and the connector refuses
 * when its own switch (`HB_FILES`, `HB_TERMINAL`) is off or when it runs as root.
 */

/** An agent whose connector serves files to the owner. The session screen shows the Files button for it. */
export const FILES_CAPABILITY = "host-files";
/** An agent whose connector opens a shell for the owner. */
export const TERMINAL_CAPABILITY = "host-terminal";

export const FILE_OPS = ["roots", "list", "read", "stat", "write", "create", "rename", "delete"] as const;
export const FileOp = z.enum(FILE_OPS);
export type FileOp = z.infer<typeof FileOp>;
/** Operations that change something on disk. Each one that succeeds is written to the hub's audit log. */
export const FILE_WRITE_OPS: readonly FileOp[] = ["write", "create", "rename", "delete"];

/** The largest file the editor opens or saves, in bytes. Frames are capped at 1 MiB on the hub. */
export const MAX_EDIT_BYTES = 400 * 1024;
/** A path on the connector's machine: absolute, no control characters. */
export const HostPath = z.string().min(1).max(4096).regex(/^[^\u0000-\u001f]+$/);

export type FileKind = "file" | "dir" | "link" | "other";
export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  /** For a link: what it points at, when that is a folder or a file. */
  target?: "file" | "dir" | null;
  size: number;
  mtime: number;
  hidden: boolean;
}
export interface FileJump {
  label: string;
  path: string;
  kind: "home" | "workspace" | "vault" | "root";
}
export interface FileRoots {
  host: string;
  sep: "/" | "\\";
  home: string;
  jumps: FileJump[];
  /** Folders shown read-only: nothing in them can be written, renamed or deleted from the app (the notes vault). */
  readOnly: string[];
  files: boolean;
  terminal: boolean;
}
export interface FileListing {
  path: string;
  parent: string | null;
  crumbs: Array<{ label: string; path: string }>;
  entries: FileEntry[];
  truncated: boolean;
  readOnly: boolean;
}
export interface FileStat {
  path: string;
  exists: boolean;
  kind: FileKind | null;
  size: number;
  mtime: number;
  /** sha256 of the bytes, for files the editor could open. */
  hash: string | null;
}
export interface FileRead extends FileStat {
  name: string;
  /** The text, or null for a binary or too-large file. */
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  eol: "\n" | "\r\n";
  bom: boolean;
  readOnly: boolean;
  /** Why this looks like a secret file, when it does (the owner confirmed opening it). */
  secret: string | null;
}

// ---------------------------------------------------------------- terminal

export const TERM_MAX_INPUT = 64 * 1024;
export const TERM_MAX_OUTPUT = 256 * 1024;
export const TermSize = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) });

// ---------------------------------------------------------------- languages (pure, shared by the editor and tests)

export type EditorLanguage = "json" | "python" | "shell" | "javascript" | "typescript" | "jsx" | "tsx" | "markdown" | "yaml" | "css" | "html" | "plain";

const BY_EXT: Record<string, EditorLanguage> = {
  json: "json", jsonc: "json", json5: "json", webmanifest: "json",
  py: "python", pyw: "python", pyi: "python",
  sh: "shell", bash: "shell", zsh: "shell", ksh: "shell", env: "shell",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", xhtml: "html", svg: "html", xml: "html", vue: "html",
};
const BY_NAME: Record<string, EditorLanguage> = {
  ".bashrc": "shell", ".bash_profile": "shell", ".profile": "shell", ".zshrc": "shell", ".bash_aliases": "shell", "bashrc": "shell",
  ".env": "shell", "dockerfile": "shell", "makefile": "shell", "package.json": "json", "tsconfig.json": "json",
};

/** The editor's language for a file name, by name, then extension, then a `#!` line. */
export function languageFor(name: string, firstLine = ""): EditorLanguage {
  const base = name.replace(/^.*[\\/]/, "").toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  if (/^\.env(\.|$)/.test(base)) return "shell";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  if (/^#!.*\b(ba|z|k)?sh\b/.test(firstLine)) return "shell";
  if (/^#!.*\bpython/.test(firstLine)) return "python";
  if (/^#!.*\bnode\b/.test(firstLine)) return "javascript";
  return "plain";
}

/** How a file is indented: tabs, or spaces and how many. Looks at the first lines that start with whitespace. */
export function detectIndent(text: string): { tabs: boolean; size: number } {
  let tabs = 0;
  let spaces = 0;
  const widths = new Map<number, number>();
  let prev = 0;
  let seen = 0;
  for (const line of text.split(/\r?\n/, 2000)) {
    if (!line.trim()) continue;
    const m = /^[ \t]*/.exec(line)![0];
    if (m.startsWith("\t")) tabs++;
    else if (m.length) {
      spaces++;
      const d = Math.abs(m.length - prev);
      if (d >= 2 && d <= 8) widths.set(d, (widths.get(d) ?? 0) + 1);
    }
    prev = m.startsWith("\t") ? prev : m.length;
    if (++seen > 1000) break;
  }
  if (tabs > spaces) return { tabs: true, size: 4 };
  const best = [...widths].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return { tabs: false, size: best ? best[0] : 2 };
}
