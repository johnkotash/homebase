import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { FolderAccess, FolderList, FolderPath, type AgentFolderFacts, type ApprovedFolder, type FolderCheck, type FolderEntry, type FolderListing, type FolderOp } from "@homebase/protocol";
import { expandHome } from "./config";
import { isInside } from "./policy";

/**
 * Folders an agent may be given, decided on this machine (ARCHITECTURE.md 6.6).
 *
 * The allowlist is the real fence. It has three parts: the agent's sandbox, the folders in the
 * connector's config file (`projectDirs`, `addDirs`), and the folders the owner approved from the app,
 * kept in `approved-folders.json` next to that config. A run's working directory and every extra folder
 * are checked against it here, right before a process starts; whatever the hub asks for, nothing else is
 * ever used.
 *
 * The app can also browse this machine to pick a folder. That is limited to the `browseRoots` from the
 * config file (default: the home folder), lists folder names only, and never goes into credential,
 * settings or system folders or into HomeBase's own data.
 */

export class FolderError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface FolderRules {
  /** The account's home folder. It cannot be added itself, and hidden folders in it are off limits. */
  home: string;
  /** Where the app may browse and approve. Nothing outside these is listed or accepted. */
  roots: string[];
  /**
   * HomeBase's own files and folders (its data folder, the connector's token and config). A folder that is
   * one of these, is inside one, or contains one is refused.
   */
  privatePaths: string[];
  /** Folders that belong to one agent only (the notes vault). Same rule as privatePaths. */
  protectedRoots?: () => string[];
  /** Operating-system folders. Left out: the usual ones for this platform. */
  systemDirs?: string[];
}

export function defaultSystemDirs(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "win32") {
    return [env.SystemRoot ?? "C:\\Windows", env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", env.ProgramData ?? "C:\\ProgramData"]
      .filter(Boolean).map((d) => resolve(d));
  }
  return ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc", "/sys", "/var", "/root", "/run", "/private/etc", "/private/var", "/System", "/Library"];
}

/**
 * Credential and tool-settings folders, wherever they are, and a repository's own `.git`. Folders that are plainly
 * named for what they hold (keystores, secrets, credentials, private keys) are treated the same.
 */
const SECRET_SEGMENT = /^(\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.claude|\.codex|\.docker|\.password-store|\.git|keystores?|secrets?|credentials?|(private|ssh|api)[-_ ]?keys?)$/i;
/** The first folder under home: hidden ones and the per-user application data folders. */
const HOME_PRIVATE = /^[.$]|^(AppData|Application Data|Local Settings|Library|NTUSER)/i;
/** Personal catch-all folders directly in home. Too broad to hand over for writing. */
const BROAD = /^(Documents|Desktop|Downloads|Pictures|Music|Videos|Movies|OneDrive.*|Dropbox|Google Drive|iCloud.*)$/i;
/** Not shown in the browser: noise, not secrets. */
const SKIP_NAME = /^(node_modules|System Volume Information|lost\+found)$/i;
const MAX_ENTRIES = 400;

const same = (a: string, b: string) => isInside(a, b) && isInside(b, a);
const realOf = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const segments = (p: string) => resolve(p).split(/[\\/]+/).filter(Boolean);

/** Why the folder browser will not go into (or list) this folder, or null. `p` is a real, absolute path. */
export function enterBlock(p: string, rules: FolderRules): string | null {
  if (!rules.roots.some((r) => isInside(p, r))) return "Outside the folders this connector lets the app browse. To change that, edit browseRoots in the connector's config file.";
  if (segments(p).some((s) => SECRET_SEGMENT.test(s))) return "A credential or settings folder. Agents are never given these.";
  if (isInside(p, rules.home) && !same(p, rules.home)) {
    const first = relative(resolve(rules.home), resolve(p)).split(/[\\/]+/)[0] ?? "";
    if (HOME_PRIVATE.test(first)) return "A hidden or application-data folder in your home folder. These hold app settings and sign-ins.";
  }
  if ((rules.systemDirs ?? defaultSystemDirs()).some((d) => isInside(p, d))) return "A system folder.";
  if (rules.privatePaths.some((d) => isInside(p, d))) return "HomeBase's own data. Agents are not given the hub's database, the connector's token or its settings.";
  if ((rules.protectedRoots?.() ?? []).some((d) => isInside(p, d))) return "The notes vault. It is reachable only through the Notes agent.";
  return null;
}

/** Why this folder can never be added for an agent, or null. A folder can be fine to open and still not addable. */
export function addBlock(p: string, rules: FolderRules): string | null {
  const enter = enterBlock(p, rules);
  if (enter) return enter;
  if (same(parse(resolve(p)).root, p)) return "A whole drive is too much to hand to an agent. Pick a folder inside it.";
  if (same(p, rules.home)) return "Your whole home folder cannot be added: it holds sign-ins, keys and app data. Pick a folder inside it.";
  if (isInside(rules.home, p)) return "This folder contains your home folder. Pick a folder inside your home folder.";
  if (rules.privatePaths.some((d) => isInside(d, p))) return "This folder contains HomeBase's own data (its database, the connector's token or its settings). Pick a folder next to it.";
  if ((rules.protectedRoots?.() ?? []).some((d) => isInside(d, p))) return "This folder contains the notes vault, which only the Notes agent may reach. Pick a folder next to it.";
  return null;
}

/** The most a folder can be approved for, and what the owner should know first. */
export function folderAdvice(p: string, rules: FolderRules): { maxAccess: FolderAccess; warnings: string[] } {
  const warnings: string[] = [];
  let maxAccess: FolderAccess = "write";
  const inHome = same(dirname(resolve(p)), rules.home);
  if (inHome && BROAD.test(basename(p))) {
    maxAccess = "read";
    warnings.push(`${basename(p)} is a catch-all folder: everything in it becomes readable. It can be added read-only at most; for an agent to work somewhere, pick the project folder inside it.`);
  } else if (inHome) {
    warnings.push("This folder sits directly in your home folder. Check that it holds only what an agent should see.");
  }
  let repos = 0;
  try {
    for (const d of readdirSync(p, { withFileTypes: true }).slice(0, 300)) if (d.isDirectory() && existsSync(join(p, d.name, ".git"))) repos++;
  } catch {
    // unreadable: the check itself will say so
  }
  if (repos > 1 && !existsSync(join(p, ".git"))) warnings.push(`This folder holds ${repos} repositories. All of them become reachable, not one project.`);
  return { maxAccess, warnings };
}

// ---------------------------------------------------------------- the approved-folders file

interface StoredFolder {
  path: string;
  label: string;
  access: FolderAccess;
  addedAt: number;
  addedBy: string | null;
}

/**
 * The folders approved from the app, in a small JSON file next to the connector's Claude config. The
 * hand-edited config file is never rewritten. Writes go to a temporary file first and are renamed into
 * place, so a crash cannot leave half a list behind.
 */
export class FolderStore {
  constructor(readonly file: string) {}

  load(): StoredFolder[] {
    if (!existsSync(this.file)) return [];
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8"));
      const list = Array.isArray(j?.folders) ? j.folders : [];
      return list
        .filter((f: any) => FolderPath.safeParse(f?.path).success && isAbsolute(f.path) && FolderAccess.safeParse(f?.access).success)
        .map((f: any) => ({ path: resolve(f.path), label: String(f.label ?? basename(f.path)).slice(0, 80), access: f.access, addedAt: Number(f.addedAt) || 0, addedBy: typeof f.addedBy === "string" ? f.addedBy : null }));
    } catch {
      // Unreadable: treated as empty. The bad file is kept beside the new one on the next save.
      return [];
    }
  }

  save(folders: StoredFolder[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    if (existsSync(this.file)) {
      try {
        JSON.parse(readFileSync(this.file, "utf8"));
      } catch {
        renameSync(this.file, `${this.file}.bad-${Date.now()}`);
      }
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, note: "Folders approved from the HomeBase app. Edit with the connector stopped.", folders }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

// ---------------------------------------------------------------- the service

export interface FolderServiceOptions {
  /** The agent's own folders from the connector's config file. */
  config: { sandboxDir: string; projectDirs: Array<{ label: string; cwd: string }>; addDirs: string[]; browseRoots?: string[]; appFolders?: boolean };
  storePath: string;
  privatePaths: string[];
  protectedRoots?: () => string[];
  home?: string;
  systemDirs?: string[];
  host?: string;
  /** Called after the allowlist changed, so the agent's registration can be sent again. */
  onChange?: () => void;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

export interface RunFolders {
  /** Extra folders the agent may read but not change. */
  read: string[];
  /** Extra folders the agent may also change. */
  write: string[];
  /** What was asked for and not given, in words for the run's timeline. */
  notes: string[];
}

export class FolderService {
  readonly rules: FolderRules;
  private store: FolderStore;
  private host: string;
  private now: () => number;

  constructor(private o: FolderServiceOptions) {
    const home = resolve(o.home ?? homedir());
    const roots = (o.config.browseRoots?.length ? o.config.browseRoots : [home]).map((r) => realOf(resolve(expandHome(r))) ?? resolve(expandHome(r)));
    this.rules = {
      home: realOf(home) ?? home, roots, protectedRoots: o.protectedRoots, systemDirs: o.systemDirs,
      privatePaths: [...o.privatePaths, o.storePath].map((p) => resolve(p)),
    };
    this.store = new FolderStore(o.storePath);
    this.host = o.host ?? hostname();
    this.now = o.now ?? Date.now;
  }

  /** True when the owner may browse this machine and approve folders from the app. */
  get browse(): boolean {
    return this.o.config.appFolders !== false;
  }

  /** Everything this connector accepts, most trusted source first: the sandbox, the config file, then the app's approvals. */
  approved(): ApprovedFolder[] {
    const out: ApprovedFolder[] = [];
    const add = (f: ApprovedFolder) => {
      const hit = out.find((x) => same(x.path, f.path));
      if (!hit) return void out.push(f);
      // The same folder from two sources: the wider access holds, the first source keeps its name.
      if (f.access === "write") hit.access = "write";
      if (!f.missing) hit.missing = undefined;
    };
    const c = this.o.config;
    add({ path: resolve(c.sandboxDir), label: "sandbox", access: "write", source: "sandbox" });
    for (const d of c.projectDirs) add({ path: resolve(d.cwd), label: d.label, access: "write", source: "config" });
    for (const d of c.addDirs) add({ path: resolve(d), label: basename(d), access: "read", source: "config" });
    for (const f of this.store.load()) {
      const real = realOf(f.path);
      // A folder approved from the app is used only while it is still what was approved: the same real
      // folder, and still acceptable. One that was swapped for a link to somewhere else no longer counts.
      if (real && (!same(real, f.path) || !isDir(real) || addBlock(real, this.rules))) continue;
      const max = real ? folderAdvice(real, this.rules).maxAccess : f.access;
      add({ path: f.path, label: f.label, access: max === "read" ? "read" : f.access, source: "app", addedAt: f.addedAt, ...(real ? {} : { missing: true }) });
    }
    return out;
  }

  /** The folders a run may start in, the sandbox first. This is what older apps show as "working directory". */
  workspaces(): Array<{ label: string; cwd: string }> {
    mkdirSync(this.o.config.sandboxDir, { recursive: true });
    return this.approved().filter((f) => f.access === "write" && !f.missing).map((f) => ({ label: f.label, cwd: f.path }));
  }

  facts(): AgentFolderFacts {
    return {
      browse: this.browse, host: this.host, sep: sep === "\\" ? "\\" : "/",
      roots: this.browse ? this.rules.roots.map((r) => ({ label: same(r, this.rules.home) ? "Home" : basename(r) || r, path: r })) : [],
      approved: this.approved().slice(0, 300),
    };
  }

  private match(requested: string): ApprovedFolder | undefined {
    const want = resolve(requested);
    const real = realOf(want);
    return this.approved().find((f) => {
      if (f.missing) return false;
      // Folders from the app are matched by their real path, so a link cannot stand in for one.
      if (f.source === "app") return !!real && same(real, f.path);
      return same(want, f.path);
    });
  }

  /** The run's working directory, or null when the request is not an approved read & write folder. No request: the sandbox. */
  resolveCwd(requested: string | null): string | null {
    if (!requested) {
      mkdirSync(this.o.config.sandboxDir, { recursive: true });
      return resolve(this.o.config.sandboxDir);
    }
    const hit = this.match(requested);
    return hit && hit.access === "write" ? hit.path : null;
  }

  /**
   * The extra folders of a run: the config file's `addDirs` (always, read-only), plus what the hub asked
   * for, as far as it is approved here. A folder approved read-only is never given for writing.
   */
  resolveExtras(requested: unknown, cwd: string): RunFolders {
    const out: RunFolders = { read: [], write: [], notes: [] };
    const seen = new Set<string>();
    const put = (path: string, access: FolderAccess) => {
      const key = resolve(path).toLowerCase();
      if (seen.has(key) || same(path, cwd)) return;
      seen.add(key);
      out[access].push(path);
    };
    for (const d of this.o.config.addDirs) if (isDir(d)) put(resolve(d), "read");
    if (requested == null) return out;
    const asked = FolderList.safeParse(requested);
    if (!asked.success) {
      out.notes.push("The list of extra folders could not be read, so none was added.");
      return out;
    }
    for (const f of asked.data) {
      if (!isAbsolute(f.path)) {
        out.notes.push(`Not added: ${f.path} is not a full path.`);
        continue;
      }
      const hit = this.match(f.path);
      if (!hit) {
        out.notes.push(`Not added: ${f.path} is not approved on this connector (${this.host}).`);
        continue;
      }
      if (f.access === "write" && hit.access !== "write") out.notes.push(`${hit.label} is approved read-only on this connector, so it was added read-only.`);
      put(hit.path, f.access === "write" && hit.access === "write" ? "write" : "read");
    }
    return out;
  }

  // ---------------------------------------------------------------- the browser

  private resolveInput(input: unknown): string {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw || !FolderPath.safeParse(raw).success) throw new FolderError("invalid", "Type the full path of a folder.");
    const p = expandHome(raw);
    if (!isAbsolute(p)) throw new FolderError("invalid", `Type the full path, starting from ${sep === "\\" ? "the drive (C:\\...)" : "/"} or from ~.`);
    return resolve(p);
  }

  check(input: unknown): FolderCheck {
    const want = this.resolveInput(input);
    const real = realOf(want);
    const none = (reason: string): FolderCheck => ({ path: want, label: basename(want) || want, ok: false, reason, approved: null, source: null, maxAccess: "read", warnings: [], git: false });
    if (!real) return none(`There is no such folder on ${this.host}.`);
    if (!isDir(real)) return none("That is a file, not a folder.");
    // A folder that is already approved (the sandbox, or one from the config file) is fine as it is.
    const known = this.approved().find((f) => !f.missing && (same(f.path, real) || same(f.path, want)));
    const reason = known ? null : addBlock(real, this.rules);
    const advice = reason ? { maxAccess: "read" as FolderAccess, warnings: [] } : folderAdvice(real, this.rules);
    return {
      path: known?.path ?? real, label: known?.label ?? (basename(real) || real), ok: !reason, reason, approved: known?.access ?? null, source: known?.source ?? null,
      maxAccess: known && known.source !== "app" ? known.access : advice.maxAccess, warnings: advice.warnings, git: existsSync(join(real, ".git")),
    };
  }

  list(input: unknown): FolderListing {
    const want = input == null || input === "" ? this.rules.roots[0] : this.resolveInput(input);
    const real = want ? realOf(want) : null;
    if (!real || !isDir(real)) throw new FolderError("not_found", `There is no such folder on ${this.host}.`);
    const blocked = enterBlock(real, this.rules);
    if (blocked) throw new FolderError("blocked", blocked);
    let names: string[];
    let hidden = 0;
    try {
      const all = readdirSync(real, { withFileTypes: true });
      // Real folders only: a link could point anywhere.
      names = all.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      throw new FolderError("unreadable", "This folder cannot be read by the connector.");
    }
    const approved = this.approved();
    const entries: FolderEntry[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
      const path = join(real, name);
      if (/^[.$]/.test(name) || SKIP_NAME.test(name) || enterBlock(path, this.rules)) {
        hidden++;
        continue;
      }
      if (entries.length >= MAX_ENTRIES) continue;
      const known = approved.find((f) => same(f.path, path));
      entries.push({ name, path, git: existsSync(join(path, ".git")), approved: known?.access ?? null, blocked: known ? null : addBlock(path, this.rules), canOpen: true });
    }
    const root = this.rules.roots.find((r) => isInside(real, r))!;
    const crumbs: Array<{ label: string; path: string }> = [];
    for (let cur = real; ; cur = dirname(cur)) {
      crumbs.unshift({ label: same(cur, this.rules.home) ? "Home" : basename(cur) || cur, path: cur });
      if (same(cur, root) || dirname(cur) === cur) break;
    }
    return {
      self: this.check(real), parent: same(real, root) ? null : dirname(real), crumbs, entries,
      hidden, truncated: names.length - hidden > entries.length,
    };
  }

  /** Adds a folder to the allowlist, or changes what it is approved for. An explicit owner action from the app. */
  approve(args: Record<string, unknown>, by: string | null): ApprovedFolder {
    const access = FolderAccess.safeParse(args.access);
    if (!access.success) throw new FolderError("invalid", "Choose read-only or read & write.");
    const c = this.check(args.path);
    if (!c.ok) throw new FolderError("blocked", c.reason ?? "This folder cannot be added.");
    if (c.source && c.source !== "app") {
      if (access.data === "write" && c.approved !== "write") throw new FolderError("blocked", `${c.label} is listed read-only in the connector's config file. Change it there.`);
      return this.approved().find((f) => same(f.path, c.path))!;
    }
    if (access.data === "write" && c.maxAccess !== "write") throw new FolderError("blocked", c.warnings[0] ?? "This folder can be added read-only at most.");
    const label = (typeof args.label === "string" && args.label.trim() ? args.label.trim() : c.label).slice(0, 80);
    const list = this.store.load().filter((f) => !same(f.path, c.path));
    const entry: StoredFolder = { path: c.path, label, access: access.data, addedAt: this.now(), addedBy: by };
    this.store.save([...list, entry]);
    this.o.log?.(`folder approved from the app: ${c.path} (${access.data})`);
    this.o.onChange?.();
    return { path: entry.path, label, access: entry.access, source: "app", addedAt: entry.addedAt };
  }

  /** Takes a folder off the allowlist. Only folders that were approved from the app; the config file's own stay. */
  forget(args: Record<string, unknown>): { path: string; label: string } {
    const want = this.resolveInput(args.path);
    const list = this.store.load();
    const hit = list.find((f) => same(f.path, want));
    if (!hit) {
      if (this.approved().some((f) => same(f.path, want))) throw new FolderError("blocked", "This folder comes from the connector's config file. Remove it there.");
      throw new FolderError("not_found", "That folder is not on the approved list.");
    }
    this.store.save(list.filter((f) => f !== hit));
    this.o.log?.(`folder removed from the approved list: ${hit.path}`);
    this.o.onChange?.();
    return { path: hit.path, label: hit.label };
  }

  /** One request from the app's folder browser, relayed by the hub. */
  async handle(op: FolderOp, args: Record<string, unknown>, meta: { deviceId?: string | null; canApprove: boolean }): Promise<unknown> {
    if (!this.browse) throw new FolderError("disabled", "This connector does not take folders from the app (appFolders is off in its config file).");
    switch (op) {
      case "roots": return this.facts();
      case "list": return this.list(args.path);
      case "check": return this.check(args.path);
      case "approve":
        if (!meta.canApprove) throw new FolderError("forbidden", "This device cannot approve folders.");
        return this.approve(args, meta.deviceId ?? null);
      case "forget":
        if (!meta.canApprove) throw new FolderError("forbidden", "This device cannot change the approved folders.");
        return this.forget(args);
      default: throw new FolderError("unsupported", `There is no "${String(op)}" folder operation.`);
    }
  }
}

/**
 * A Claude Code permission-rule pattern for everything under a folder: `//c/Users/me/docs/**` for
 * C:\Users\me\docs, `//srv/docs/**` for /srv/docs. Used to deny file edits in a read-only folder inside
 * the CLI itself, on top of the connector's own check at the approval tool.
 */
export function editDenyRule(dir: string): string {
  const abs = resolve(dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const posix = /^[A-Za-z]:/.test(abs) ? `/${abs[0].toLowerCase()}${abs.slice(2)}` : abs;
  return `Edit(/${posix}/**)`;
}
