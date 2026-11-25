import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { HostPath, MAX_EDIT_BYTES, type FileEntry, type FileJump, type FileKind, type FileListing, type FileOp, type FileRead, type FileRoots, type FileStat } from "@homebase/protocol";
import { expandHome } from "./config";
import { isInside } from "./policy";

/**
 * Files on this machine for the owner (issue #3): browse, open, save, create, rename and delete, as the user the
 * connector runs as. Requests come from the hub, which takes them only from a device that may approve.
 *
 * Rules here, whatever the hub sends:
 *  - off when HB_FILES=0, and always off when the connector runs as root;
 *  - paths are absolute; `~` means this user's home;
 *  - the notes vault (and any folder marked with protectRoot) is read-only: nothing in it, or containing it,
 *    is written, renamed, moved or deleted from the app;
 *  - a save names the version it was based on; if the file changed on disk since (an agent edited it), the save
 *    is refused with `conflict` unless the owner chose to overwrite;
 *  - a file that looks like a secret (.ssh, .env, credential stores) opens only after the owner confirms.
 */

export class FileError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const OFF = /^(0|off|false|no)$/i;
/** HB_FILES: the file browser and editor. Default on. */
export const filesEnabled = (env: NodeJS.ProcessEnv = process.env) => !OFF.test((env.HB_FILES ?? "").trim());
/** True when this process runs as root (Unix). The file browser and the terminal refuse then. */
export const runsAsRoot = () => typeof process.getuid === "function" && process.getuid() === 0;

const MAX_ENTRIES = 2000;
/** Folders whose files are credentials or keys. */
const SECRET_DIR = /^(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.password-store|\.docker)$/i;
const SECRET_FILE: Array<[RegExp, string]> = [
  [/^\.env(\..+)?$/i, "an environment file, which usually holds keys and passwords"],
  [/^(\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd|\.pgpass)$/i, "a credentials file"],
  [/^\.?credentials(\.json)?$/i, "a credentials file"],
  [/^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?)(\.pub)?$/i, "an SSH key"],
  [/\.(pem|key|p12|pfx|keystore|jks|kdbx|gpg|asc)$/i, "a key or certificate store"],
  [/^(secrets?|token|tokens)(\.[a-z]+)?$/i, "a file named for secrets"],
  [/^(\.connector\.json|homebase\.env)$/i, "HomeBase's own token or settings"],
];
const SAFE_ENV = /^\.env\.(example|sample|template|dist|defaults)$/i;

/** Why this path looks like a secret file, or null. */
export function secretReason(p: string): string | null {
  const parts = resolve(p).split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (SAFE_ENV.test(name)) return null;
  const dir = parts.slice(0, -1).find((s) => SECRET_DIR.test(s));
  if (dir) return `It is in ${dir}, a folder of keys and credentials.`;
  for (const [re, why] of SECRET_FILE) if (re.test(name)) return `It looks like ${why}.`;
  return null;
}

const hashOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const realOf = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};
const kindOf = (s: Stats): FileKind => (s.isSymbolicLink() ? "link" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other");
const looksBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

export interface FileServiceOptions {
  enabled?: boolean;
  home?: string;
  host?: string;
  /** Folders that are read-only here (the notes vault). Read at every request: the vault may be found later. */
  protectedRoots?: () => string[];
  /** Quick jumps besides home: the agents' workspaces. */
  workspaces?: () => Array<{ label: string; path: string }>;
  terminal?: () => boolean;
  /** For tests: pretend to run as root. */
  root?: boolean;
  log?: (...a: unknown[]) => void;
}

export class FileService {
  readonly home: string;
  private host: string;

  constructor(private o: FileServiceOptions = {}) {
    this.home = resolve(o.home ?? homedir());
    this.host = o.host ?? hostname();
  }

  get enabled(): boolean {
    return (this.o.enabled ?? filesEnabled()) && !(this.o.root ?? runsAsRoot());
  }

  /** A full path from the app: absolute (or `~`), no control characters. */
  path(input: unknown): string {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw || !HostPath.safeParse(raw).success) throw new FileError("invalid", "A full path is needed.");
    const p = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(this.home, raw.slice(1)) : expandHome(raw);
    if (!isAbsolute(p)) throw new FileError("invalid", `Use a full path, starting from ${sep === "\\" ? "the drive (C:\\...)" : "/"} or from ~.`);
    return resolve(p);
  }

  private protectedRoots(): string[] {
    return (this.o.protectedRoots?.() ?? []).map((r) => realOf(r) ?? resolve(r));
  }

  /** True when the path is in (or is) a read-only folder, by its own spelling or by where a link leads. */
  readOnly(p: string): boolean {
    const real = realOf(p) ?? (realOf(dirname(p)) ? join(realOf(dirname(p))!, basename(p)) : p);
    return this.protectedRoots().some((r) => isInside(p, r) || isInside(real, r));
  }

  /** Refuses a change at `p`: inside the vault, or a folder that holds the vault. */
  private guardChange(p: string, what: string) {
    if (this.readOnly(p)) throw new FileError("read_only", `The notes vault is read-only here: notes are never ${what} from the file browser.`);
    const real = realOf(p) ?? p;
    if (this.protectedRoots().some((r) => isInside(r, p) || isInside(r, real))) throw new FileError("read_only", `This folder holds the notes vault, so it cannot be ${what} here.`);
    if (same(parse(p).root, p)) throw new FileError("invalid", `A whole drive cannot be ${what}.`);
    if (same(p, this.home)) throw new FileError("invalid", `Your home folder cannot be ${what}.`);
  }

  roots(): FileRoots {
    const jumps: FileJump[] = [{ label: "Home", path: this.home, kind: "home" }];
    for (const w of this.o.workspaces?.() ?? []) if (!jumps.some((j) => same(j.path, w.path))) jumps.push({ label: w.label, path: resolve(w.path), kind: "workspace" });
    for (const r of this.protectedRoots()) jumps.push({ label: "Notes vault (read-only)", path: r, kind: "vault" });
    if (sep === "/") jumps.push({ label: "/", path: "/", kind: "root" });
    return { host: this.host, sep: sep === "\\" ? "\\" : "/", home: this.home, jumps, readOnly: this.protectedRoots(), files: this.enabled, terminal: this.o.terminal?.() ?? false };
  }

  list(args: Record<string, unknown>): FileListing {
    const dir = args.path == null || args.path === "" ? this.home : this.path(args.path);
    let st: Stats;
    try {
      st = statSync(dir);
    } catch {
      throw new FileError("not_found", `There is no folder ${dir} on ${this.host}.`);
    }
    if (!st.isDirectory()) throw new FileError("not_dir", `${dir} is a file, not a folder.`);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      throw new FileError("unreadable", `${dir} cannot be read by the connector's user (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    const hidden = args.hidden === true;
    const entries: FileEntry[] = [];
    for (const name of names) {
      const isHidden = name.startsWith(".");
      if (isHidden && !hidden) continue;
      if (entries.length >= MAX_ENTRIES) break;
      const path = join(dir, name);
      try {
        const l = lstatSync(path);
        let target: FileEntry["target"] = undefined;
        if (l.isSymbolicLink()) {
          try {
            const t = statSync(path);
            target = t.isDirectory() ? "dir" : t.isFile() ? "file" : null;
          } catch {
            target = null;
          }
        }
        entries.push({ name, path, kind: kindOf(l), ...(target !== undefined ? { target } : {}), size: l.size, mtime: Math.round(l.mtimeMs), hidden: isHidden });
      } catch {
        entries.push({ name, path, kind: "other", size: 0, mtime: 0, hidden: isHidden });
      }
    }
    const isDir = (e: FileEntry) => e.kind === "dir" || (e.kind === "link" && e.target === "dir");
    entries.sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    const crumbs: FileListing["crumbs"] = [];
    for (let cur = dir; ; cur = dirname(cur)) {
      crumbs.unshift({ label: same(cur, this.home) ? "~" : basename(cur) || cur, path: cur });
      // Inside home the crumbs start at ~; the up button still climbs above it.
      if (dirname(cur) === cur || same(cur, this.home)) break;
    }
    return { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), crumbs, entries, truncated: names.length > MAX_ENTRIES, readOnly: this.readOnly(dir) };
  }

  stat(args: Record<string, unknown>): FileStat {
    const p = this.path(args.path);
    let st: Stats;
    try {
      st = statSync(p);
    } catch {
      return { path: p, exists: false, kind: null, size: 0, mtime: 0, hash: null };
    }
    const hash = st.isFile() && st.size <= MAX_EDIT_BYTES ? hashOf(readFileSync(p)) : null;
    return { path: p, exists: true, kind: kindOf(st), size: st.size, mtime: Math.round(st.mtimeMs), hash };
  }

  read(args: Record<string, unknown>): FileRead {
    const p = this.path(args.path);
    let st: Stats;
    try {
      st = statSync(p);
    } catch {
      throw new FileError("not_found", `There is no file ${p} on ${this.host}.`);
    }
    if (st.isDirectory()) throw new FileError("is_dir", `${p} is a folder.`);
    if (!st.isFile()) throw new FileError("unsupported", `${p} is not a regular file.`);
    const secret = secretReason(p);
    if (secret && args.confirm !== true) throw new FileError("secret", `${basename(p)} may hold secrets. ${secret} Open it anyway?`);
    const base = { path: p, name: basename(p), exists: true, kind: "file" as const, size: st.size, mtime: Math.round(st.mtimeMs), readOnly: this.readOnly(p), secret };
    if (st.size > MAX_EDIT_BYTES) {
      // Only the first bytes, to tell text from binary.
      const head = Buffer.alloc(8000);
      const fd = openSync(p, "r");
      try {
        readSync(fd, head, 0, head.length, 0);
      } finally {
        closeSync(fd);
      }
      return { ...base, hash: null, content: null, binary: looksBinary(head), tooLarge: true, eol: "\n", bom: false };
    }
    let buf: Buffer;
    try {
      buf = readFileSync(p);
    } catch (e) {
      throw new FileError("unreadable", `${p} cannot be read by the connector's user (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    const hash = hashOf(buf);
    if (looksBinary(buf)) return { ...base, hash, content: null, binary: true, tooLarge: false, eol: "\n", bom: false };
    let text = buf.toString("utf8");
    const bom = text.charCodeAt(0) === 0xfeff;
    if (bom) text = text.slice(1);
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    return { ...base, hash, content: text, binary: false, tooLarge: false, eol: crlf > lf ? "\r\n" : "\n", bom };
  }

  /**
   * Saves text. `baseHash` is the hash the editor opened (null for a new file). When the file on disk is no longer
   * that version, nothing is written and the answer is `conflict`, unless `force` is set (the owner chose overwrite).
   */
  write(args: Record<string, unknown>): FileStat {
    const p = this.path(args.path);
    if (typeof args.content !== "string") throw new FileError("invalid", "Nothing to save.");
    this.guardChange(p, "changed");
    const body = Buffer.from((args.bom === true ? "\ufeff" : "") + args.content, "utf8");
    if (body.length > MAX_EDIT_BYTES) throw new FileError("too_large", `Files over ${Math.round(MAX_EDIT_BYTES / 1024)} KB cannot be saved from the editor.`);
    const base = typeof args.baseHash === "string" ? args.baseHash : null;
    let current: Buffer | null = null;
    try {
      const st = statSync(p);
      if (st.isDirectory()) throw new FileError("is_dir", `${p} is a folder.`);
      current = readFileSync(p);
    } catch (e) {
      if (e instanceof FileError) throw e;
      current = null;
    }
    if (args.force !== true) {
      const now = current ? hashOf(current) : null;
      if (now !== base) {
        throw new FileError("conflict", current
          ? (base ? `${basename(p)} changed on disk since you opened it.` : `${basename(p)} already exists.`)
          : `${basename(p)} was deleted or moved on disk since you opened it.`);
      }
    }
    if (!existsSync(dirname(p))) throw new FileError("not_found", `The folder ${dirname(p)} does not exist.`);
    try {
      // Written in place, so the file keeps its owner, permissions and links.
      writeFileSync(p, body);
    } catch (e) {
      throw new FileError("unwritable", `${p} cannot be written by the connector's user (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    this.o.log?.(`files: saved ${p}`);
    const st = statSync(p);
    return { path: p, exists: true, kind: "file", size: st.size, mtime: Math.round(st.mtimeMs), hash: hashOf(body) };
  }

  create(args: Record<string, unknown>): { path: string; kind: "file" | "dir" } {
    const p = this.path(args.path);
    const kind = args.kind === "dir" ? "dir" : "file";
    this.guardChange(p, "created");
    if (existsSync(p)) throw new FileError("exists", `${basename(p)} already exists.`);
    if (!existsSync(dirname(p))) throw new FileError("not_found", `The folder ${dirname(p)} does not exist.`);
    try {
      if (kind === "dir") mkdirSync(p);
      else writeFileSync(p, "", { flag: "wx" });
    } catch (e) {
      throw new FileError("unwritable", `${basename(p)} could not be created (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    this.o.log?.(`files: created ${kind} ${p}`);
    return { path: p, kind };
  }

  rename(args: Record<string, unknown>): { path: string; from: string; to: string } {
    const from = this.path(args.from);
    const to = this.path(args.to);
    this.guardChange(from, "renamed or moved");
    this.guardChange(to, "moved into");
    if (!existsSync(from)) throw new FileError("not_found", `${from} does not exist.`);
    if (existsSync(to) && !same(from, to)) throw new FileError("exists", `${basename(to)} already exists.`);
    if (isInside(to, from) && !same(from, to)) throw new FileError("invalid", "A folder cannot be moved into itself.");
    try {
      renameSync(from, to);
    } catch (e) {
      throw new FileError("unwritable", `Could not rename (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    this.o.log?.(`files: renamed ${from} -> ${to}`);
    return { path: to, from, to };
  }

  delete(args: Record<string, unknown>): { path: string } {
    const p = this.path(args.path);
    this.guardChange(p, "deleted");
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch {
      throw new FileError("not_found", `${p} does not exist.`);
    }
    try {
      // A link is removed itself, never what it points at.
      rmSync(p, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: false });
    } catch (e) {
      throw new FileError("unwritable", `Could not delete ${basename(p)} (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
    }
    this.o.log?.(`files: deleted ${p}`);
    return { path: p };
  }

  /** One request from the app, relayed by the hub. */
  async handle(op: FileOp, args: Record<string, unknown>): Promise<unknown> {
    if (op === "roots") return this.roots();
    if (!this.enabled) {
      throw new FileError("disabled", (this.o.root ?? runsAsRoot())
        ? "The connector runs as root, so the file browser is off. Run the connector as a normal user."
        : "The file browser is turned off on this connector (HB_FILES=0).");
    }
    switch (op) {
      case "list": return this.list(args);
      case "stat": return this.stat(args);
      case "read": return this.read(args);
      case "write": return this.write(args);
      case "create": return this.create(args);
      case "rename": return this.rename(args);
      case "delete": return this.delete(args);
      default: throw new FileError("unsupported", `There is no "${String(op)}" file operation.`);
    }
  }
}

function same(a: string, b: string) {
  return isInside(a, b) && isInside(b, a);
}
