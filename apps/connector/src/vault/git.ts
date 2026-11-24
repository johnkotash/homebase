import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

/**
 * Git for the vault (NOTES-PLAN.md 2.3, 3.2 layer 5). This machine is the only committer and the only
 * pusher. Every call is `git` with a fixed argument list, never a shell string.
 *
 * Never run here: pull, rebase, reset, checkout, stash, push --force. The only merge is a fast-forward
 * at start, and only when the local branch is strictly behind and the tree is clean.
 */

export const AGENT_AUTHOR = { name: "HomeBase Notes Agent", email: "notes-agent@homebase.local" };
/** The Notes agent's commit identity: AGENT_AUTHOR, with the email from HB_NOTES_AUTHOR_EMAIL when that is set. */
export function agentAuthorFrom(env: NodeJS.ProcessEnv = process.env): { name: string; email: string } {
  const email = env.HB_NOTES_AUTHOR_EMAIL?.trim();
  return email && /^[^\s<>@]+@[^\s<>@]+$/.test(email) ? { ...AGENT_AUTHOR, email } : AGENT_AUTHOR;
}

/** Never committed by the sweep: Obsidian's window state, its trash and HomeBase's own scratch folder. */
export const SWEEP_IGNORE = [/(^|\/)\.obsidian\/workspace[^/]*\.json$/, /(^|\/)\.trash\//, /(^|\/)\.homebase\//, /\.hb-tmp$/];

export interface GitStatus {
  branch: string | null;
  head: string | null;
  hasRemote: boolean;
  lastCommitAt: number | null;
  lastPushAt: number | null;
  pushError: string | null;
  unpushed: number;
  lastSweepAt: number | null;
  /** Files committed by the sweep since the service started. */
  sweptFiles: number;
  diverged: boolean;
  writesSuspended: boolean;
  suspendedReason: string | null;
}

export interface CommitInfo {
  sha: string;
  /** Lines removed and files deleted or renamed by the commit, from git itself. */
  deletedLines: number;
  removedFiles: string[];
}

export interface VaultGitOptions {
  /** The repository root (the vault may be a folder inside it). */
  root: string;
  remote?: string;
  log?: (...a: unknown[]) => void;
  now?: () => number;
  agentAuthor?: { name: string; email: string };
  /** Sweep interval; 0 disables the timer (tests call sweep() themselves). */
  sweepMs?: number;
  /** A file modified more recently than this is left for the next sweep. */
  settleMs?: number;
  /** Push this long after the last commit. */
  pushDelayMs?: number;
  /** Push at least this often when there is something to push. */
  pushEveryMs?: number;
  fetchAtStart?: boolean;
  onChange?: () => void;
}

class GitError extends Error {
  constructor(message: string, public stderr: string, public code: number | null) {
    super(message);
  }
}

export class VaultGit {
  readonly root: string;
  private remote: string;
  private log: (...a: unknown[]) => void;
  private now: () => number;
  private agent: { name: string; email: string };
  private queue: Promise<unknown> = Promise.resolve();
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushFailures = 0;
  private owner = { name: "owner", email: "owner@localhost" };
  private st: GitStatus = {
    branch: null, head: null, hasRemote: false, lastCommitAt: null, lastPushAt: null, pushError: null, unpushed: 0, lastSweepAt: null, sweptFiles: 0,
    diverged: false, writesSuspended: false, suspendedReason: null,
  };
  private stopped = false;

  constructor(private o: VaultGitOptions) {
    this.root = resolve(o.root);
    this.remote = o.remote ?? "origin";
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.agent = o.agentAuthor ?? AGENT_AUTHOR;
  }

  get status(): GitStatus {
    return { ...this.st };
  }

  /** One git command. Arguments are passed as a list; nothing goes through a shell. */
  private git(args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
    return new Promise((ok, fail) => {
      execFile("git", ["--literal-pathspecs", "-C", this.root, "-c", "core.quotepath=false", ...args], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...(opts.env ?? {}) }, timeout: opts.timeoutMs ?? 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) return fail(new GitError(`git ${args[0]} failed: ${String(stderr || err.message).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`, String(stderr), (err as any).code ?? null));
        ok(String(stdout));
      });
    });
  }

  /** Git operations run one at a time, in the order they were asked for. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Checks the repository, fetches, and fast-forwards only when strictly behind with a clean tree. Never merges. */
  async start(): Promise<void> {
    await this.serial(async () => {
      const top = (await this.git(["rev-parse", "--show-toplevel"])).trim();
      if (realpathSync.native(resolve(top)).toLowerCase() !== realpathSync.native(this.root).toLowerCase()) throw new Error(`${this.root} is not the root of a git repository (git says ${top}).`);
      this.st.branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null;
      const name = (await this.git(["config", "user.name"]).catch(() => "")).trim();
      const email = (await this.git(["config", "user.email"]).catch(() => "")).trim();
      if (name) this.owner.name = name;
      if (email) this.owner.email = email;
      this.st.hasRemote = (await this.git(["remote"])).split("\n").map((s) => s.trim()).includes(this.remote);
      await this.refresh();
      if (this.st.hasRemote && this.o.fetchAtStart !== false) await this.divergenceCheck();
    });
    const every = (ms: number, fn: () => Promise<unknown>) => {
      if (!ms || ms <= 0) return;
      const t = setInterval(() => void fn().catch((e) => this.log("vault git:", (e as Error).message)), ms);
      t.unref();
      this.timers.push(t);
    };
    every(this.o.sweepMs ?? 5 * 60_000, () => this.sweep());
    every(this.o.pushEveryMs ?? 3_600_000, () => this.push());
    if (this.st.unpushed > 0) this.schedulePush();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.splice(0)) clearInterval(t);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
  }

  /** Waits for queued git work (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined);
  }

  private upstream() {
    return `${this.remote}/${this.st.branch}`;
  }

  private async refresh() {
    this.st.head = (await this.git(["rev-parse", "HEAD"]).catch(() => "")).trim() || null;
    const at = (await this.git(["log", "-1", "--format=%ct"]).catch(() => "")).trim();
    this.st.lastCommitAt = at ? Number(at) * 1000 : null;
    if (this.st.hasRemote && this.st.branch) {
      const n = (await this.git(["rev-list", "--count", `${this.upstream()}..HEAD`]).catch(() => "")).trim();
      this.st.unpushed = n ? Number(n) : 0;
    }
  }

  private async divergenceCheck() {
    try {
      await this.git(["fetch", this.remote], { timeoutMs: 45_000 });
    } catch (err) {
      this.st.pushError = `fetch failed: ${(err as Error).message}`.slice(0, 300);
      this.log(`vault git: ${this.st.pushError}`);
      return;
    }
    const counts = (await this.git(["rev-list", "--left-right", "--count", `HEAD...${this.upstream()}`]).catch(() => "0\t0")).trim().split(/\s+/).map(Number);
    const [ahead, behind] = [counts[0] || 0, counts[1] || 0];
    if (behind === 0) {
      this.st.diverged = false;
    } else if (ahead === 0 && !(await this.dirty()).length) {
      await this.git(["merge", "--ff-only", this.upstream()]);
      this.log(`vault git: fast-forwarded ${behind} commit(s) from ${this.upstream()}`);
      this.st.diverged = false;
    } else {
      // Something pushed from elsewhere. Do not merge: keep working locally, stop pushing, tell the owner.
      this.st.diverged = true;
      this.log(`vault git: the remote has ${behind} commit(s) this machine does not; not merging, pushes are stopped`);
    }
    await this.refresh();
  }

  /** Paths that differ from HEAD, relative to the repository root. A rename is reported as both paths. */
  private async dirty(): Promise<string[]> {
    const out = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const parts = out.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      paths.push(e.slice(3));
      if (/^[RC]/.test(e) || e[1] === "R") {
        const from = parts[++i];
        if (from) paths.push(from);
      }
    }
    return [...new Set(paths)];
  }

  private async commit(paths: string[], message: string, who: "agent" | "owner" | "external"): Promise<string> {
    await this.git(["add", "-A", "--", ...paths]);
    const env: NodeJS.ProcessEnv = who === "agent"
      ? { GIT_AUTHOR_NAME: this.agent.name, GIT_AUTHOR_EMAIL: this.agent.email, GIT_COMMITTER_NAME: this.agent.name, GIT_COMMITTER_EMAIL: this.agent.email }
      : who === "external"
        ? { GIT_AUTHOR_NAME: `${this.owner.name} (${hostname().split(".")[0]})`, GIT_AUTHOR_EMAIL: this.owner.email, GIT_COMMITTER_NAME: this.owner.name, GIT_COMMITTER_EMAIL: this.owner.email }
        : { GIT_AUTHOR_NAME: this.owner.name, GIT_AUTHOR_EMAIL: this.owner.email, GIT_COMMITTER_NAME: this.owner.name, GIT_COMMITTER_EMAIL: this.owner.email };
    await this.git(["commit", "-m", message, "--", ...paths], { env });
    await this.refresh();
    this.schedulePush();
    this.o.onChange?.();
    return this.st.head!;
  }

  /**
   * Commits whatever changed outside the vault service (Obsidian on this machine, an SSH session), as the
   * owner's change. With `only`, just those paths, at once: used before a service write to a file that is
   * already dirty, so the outside edit and the agent's write are separate commits.
   */
  commitExternal(only?: string[]): Promise<{ sha: string; files: number } | null> {
    return this.serial(async () => {
      let paths = (await this.dirty()).filter((p) => !SWEEP_IGNORE.some((re) => re.test(p)));
      if (only) {
        const want = new Set(only);
        paths = paths.filter((p) => want.has(p));
      } else {
        const settle = this.o.settleMs ?? 30_000;
        const now = Date.now();
        paths = paths.filter((p) => {
          try {
            return now - statSync(join(this.root, p)).mtimeMs >= settle;
          } catch {
            return true; // deleted: nothing left to settle
          }
        });
        this.st.lastSweepAt = this.now();
      }
      if (!paths.length) {
        if (!only) this.o.onChange?.();
        return null;
      }
      const sha = await this.commit(paths, `external: ${paths.length} file${paths.length === 1 ? "" : "s"} changed outside HomeBase`, "external");
      this.st.sweptFiles += paths.length;
      this.log(`vault git: committed ${paths.length} outside change(s) as ${sha.slice(0, 7)}`);
      return { sha, files: paths.length };
    });
  }

  sweep() {
    return this.commitExternal();
  }

  /**
   * One commit for one agent tool call, authored by the Notes agent. Afterwards the commit itself is
   * inspected, independent of the tool code: any removed line, deleted or renamed file suspends agent
   * writes until the owner looks (NOTES-PLAN.md 3.2, layer 5).
   */
  commitAgent(paths: string[], message: string): Promise<CommitInfo> {
    return this.serial(async () => {
      if (this.st.writesSuspended) throw new Error(`Agent writes are suspended: ${this.st.suspendedReason ?? "an earlier commit needs the owner's review"}.`);
      const sha = await this.commit(paths, message, "agent");
      const info = await this.inspect(sha);
      if (info.deletedLines > 0 || info.removedFiles.length) {
        this.st.writesSuspended = true;
        this.st.suspendedReason = `commit ${sha.slice(0, 7)} removed ${info.deletedLines} line(s)${info.removedFiles.length ? ` and deleted or renamed ${info.removedFiles.join(", ")}` : ""}`;
        this.log(`vault git: AGENT COMMIT REMOVED CONTENT (${this.st.suspendedReason}); agent writes are suspended`);
        this.o.onChange?.();
      }
      return info;
    });
  }

  /** What a commit removed, read from git. */
  async inspect(sha: string): Promise<CommitInfo> {
    const num = await this.git(["show", "--numstat", "--format=", "--no-renames", sha]);
    let deletedLines = 0;
    for (const l of num.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(l);
      if (m && m[2] !== "-") deletedLines += Number(m[2]);
    }
    const names = await this.git(["show", "--name-status", "--format=", "-M", sha]);
    const removedFiles = names.split("\n").filter((l) => /^[DR]/.test(l)).map((l) => l.split("\t").slice(1).join(" -> "));
    return { sha, deletedLines, removedFiles };
  }

  /** True when the path has uncommitted changes. */
  async isDirty(path: string): Promise<boolean> {
    return (await this.serial(() => this.dirty())).includes(path);
  }

  private schedulePush() {
    if (this.stopped || !this.st.hasRemote) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push().catch(() => {}), this.o.pushDelayMs ?? 120_000);
    this.pushTimer.unref();
  }

  /** A plain push. Never forced. A failure is retried with backoff (1, 2, 4 ... 60 minutes). */
  push(): Promise<boolean> {
    return this.serial(async () => {
      if (!this.st.hasRemote || !this.st.branch) return false;
      if (this.st.diverged) return false;
      await this.refresh();
      if (this.st.unpushed === 0 && this.st.lastPushAt) return true;
      try {
        await this.git(["push", this.remote, this.st.branch], { timeoutMs: 90_000 });
        this.pushFailures = 0;
        this.st.pushError = null;
        this.st.lastPushAt = this.now();
        await this.refresh();
        this.o.onChange?.();
        return true;
      } catch (err) {
        const e = err as GitError;
        this.pushFailures++;
        // A rejected push means the remote moved: that is divergence, not something to retry or force.
        if (/rejected|non-fast-forward|fetch first/i.test(e.stderr ?? "")) this.st.diverged = true;
        this.st.pushError = e.message.slice(0, 300);
        this.log(`vault git: push failed (${this.pushFailures}): ${this.st.pushError}`);
        this.o.onChange?.();
        if (!this.stopped && !this.st.diverged) {
          const delay = Math.min(60, 2 ** (this.pushFailures - 1)) * 60_000;
          if (this.pushTimer) clearTimeout(this.pushTimer);
          this.pushTimer = setTimeout(() => void this.push().catch(() => {}), delay);
          this.pushTimer.unref();
        }
        return false;
      }
    });
  }
}
