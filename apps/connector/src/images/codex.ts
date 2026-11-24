import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { killTree } from "../adapters/claude-code";

/**
 * OpenAI images through the official Codex CLI, under the "Sign in with ChatGPT" login that is already
 * on this machine (docs/MULTI-PROVIDER-PLAN.md 2). HomeBase only starts the unmodified CLI:
 *
 *   codex --version                 is it installed
 *   codex login status              is it signed in, and with what (a flag and a word; nothing is kept)
 *   codex app-server                account/rateLimits/read: plan name, percent used, reset time
 *   codex exec --json -s read-only  one image, made by Codex's built-in image tool
 *
 * It never opens ~/.codex/auth.json, never asks the CLI for the account, and removes every OpenAI key
 * and endpoint variable from the child's environment, so a run cannot quietly bill an API key.
 */

/** Variables that would change who pays for a Codex call, or where it goes. */
const OPENAI_ENV = /^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|OPENAI_ORG(_ID|ANIZATION)?|OPENAI_PROJECT(_ID)?|AZURE_OPENAI_.*)$/i;

export function codexEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; stripped: number } {
  const env: NodeJS.ProcessEnv = {};
  let stripped = 0;
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (OPENAI_ENV.test(k)) stripped++;
    else env[k] = v;
  }
  return { env, stripped };
}

export interface CodexCommand {
  /** The executable to start, without a shell. */
  cmd: string;
  /** Arguments that come before Codex's own (the JS entry point, when Codex is an npm install). */
  pre: string[];
}

/**
 * How to start Codex without a shell. `HB_CODEX_COMMAND` names it outright (a binary, or a .js/.mjs
 * entry run with this Node). Otherwise it is looked up on PATH. On Windows the npm install is a .cmd
 * shim, which Node will not spawn without a shell, so its JS entry is run with this Node instead.
 */
export function resolveCodex(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CodexCommand | null {
  const asCommand = (file: string): CodexCommand | null => {
    if (!existsSync(file)) return null;
    if (/\.(c|m)?js$/i.test(file)) return { cmd: process.execPath, pre: [file] };
    if (/\.(cmd|bat|ps1)$/i.test(file) || (platform === "win32" && !/\.exe$/i.test(file))) {
      const js = join(dirname(file), "node_modules", "@openai", "codex", "bin", "codex.js");
      return existsSync(js) ? { cmd: process.execPath, pre: [js] } : null;
    }
    return { cmd: file, pre: [] };
  };
  const override = env.HB_CODEX_COMMAND?.trim();
  if (override) return asCommand(resolve(override.replace(/^~(?=[\\/])/, homedir())));
  const dirs = [...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin"), join(homedir(), ".npm-global", "bin")];
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  for (const d of dirs) for (const n of names) {
    const hit = asCommand(join(d, n));
    if (hit) return hit;
  }
  return null;
}

/** Codex's own home, where its image tool saves files. Only the generated_images folder under it is ever read. */
export const codexHome = (env: NodeJS.ProcessEnv = process.env) => resolve(env.CODEX_HOME?.trim() || join(homedir(), ".codex"));

export interface CodexStatus {
  installed: boolean;
  version: string | null;
  signedIn: boolean | null;
  /** "chatgpt" or "api_key". */
  method: string | null;
  checkedAt: number;
}

export interface CodexLimits {
  plan: string | null;
  usedPercent: number | null;
  windowMins: number | null;
  /** Milliseconds since epoch. */
  resetsAt: number | null;
  limitReached: boolean;
}

export interface CodexImageRequest {
  /** The image brief, as it goes to Codex. */
  prompt: string;
  /** Absolute paths of reference images (already checked by the caller). */
  references: string[];
  /** A folder Codex is started in. It runs read-only, so nothing is written there. */
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type CodexImageResult =
  | { ok: true; file: string; threadId: string; note: string; seconds: number; usage: Record<string, unknown> | null }
  | { ok: false; reason: "failed" | "limit" | "refused" | "timeout" | "cancelled"; message: string; seconds: number };

/** What the image tools need from Codex. A fake stands in for it in tests. */
export interface CodexClient {
  status(): Promise<CodexStatus>;
  limits(): Promise<CodexLimits | null>;
  image(req: CodexImageRequest): Promise<CodexImageResult>;
}

/** Reads `codex login status` output down to a flag and a method. The text itself is dropped. */
export function parseLoginStatus(text: string): { signedIn: boolean; method: string | null } {
  const t = text.toLowerCase();
  if (/not logged in|logged out|no credentials|please (?:log|sign) in/.test(t)) return { signedIn: false, method: null };
  if (/logged in/.test(t)) return { signedIn: true, method: /chatgpt/.test(t) ? "chatgpt" : /api key/.test(t) ? "api_key" : null };
  return { signedIn: false, method: null };
}

/** The words Codex's last line uses when the plan ran out or the request was turned down. */
export function classifyFailure(text: string): "limit" | "refused" | "failed" {
  if (/usage limit|rate limit|quota|limit reached|try again (?:at|in)|too many requests/i.test(text)) return "limit";
  if (/content policy|safety system|policy violation|not allowed to|can(?:no|')t (?:help|create|generate|assist) with|unable to (?:create|generate) (?:that|this)|violat/i.test(text)) return "refused";
  return "failed";
}

/** The brief Codex gets: one image from its built-in tool and nothing else. */
export function codexBrief(prompt: string, references: number): string {
  return [
    "Use your built-in image generation tool to create exactly ONE image. Do not write code, SVG or scripts, do not run shell commands, do not make variations and do not retry.",
    references ? `The attached image${references === 1 ? " is a reference asset" : "s are reference assets"}: use ${references === 1 ? "it" : "them"} as the brief says and keep ${references === 1 ? "it" : "them"} recognisable.` : "",
    "", "Image brief:", prompt.trim(), "",
    "When the image exists, reply with one short sentence saying what you made.",
  ].filter((l, i) => l || i > 1).join("\n");
}

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

export interface CodexOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seams. */
  spawnFn?: typeof spawn;
  execFn?: typeof execFile;
  now?: () => number;
}

/** The real thing: every call starts the Codex CLI found on this machine. */
export class CodexCli implements CodexClient {
  private env: NodeJS.ProcessEnv;
  private spawnFn: typeof spawn;
  private execFn: typeof execFile;
  private now: () => number;

  constructor(o: CodexOptions = {}) {
    this.env = o.env ?? process.env;
    this.spawnFn = o.spawnFn ?? spawn;
    this.execFn = o.execFn ?? execFile;
    this.now = o.now ?? Date.now;
  }

  private run(c: CodexCommand, args: string[], timeout = 20_000): Promise<{ code: number; out: string }> {
    return new Promise((done) => {
      this.execFn(c.cmd, [...c.pre, ...args], { env: codexEnv(this.env).env, timeout, windowsHide: true }, (err, stdout, stderr) =>
        done({ code: err ? 1 : 0, out: `${String(stdout ?? "")}\n${String(stderr ?? "")}` }));
    });
  }

  async status(): Promise<CodexStatus> {
    const at = this.now();
    const c = resolveCodex(this.env);
    if (!c) return { installed: false, version: null, signedIn: null, method: null, checkedAt: at };
    const v = await this.run(c, ["--version"]);
    if (v.code !== 0) return { installed: false, version: null, signedIn: null, method: null, checkedAt: at };
    const version = v.out.trim().split(/\s+/).find((w) => /^\d+\.\d+/.test(w)) ?? null;
    const login = parseLoginStatus((await this.run(c, ["login", "status"])).out);
    return { installed: true, version, signedIn: login.signedIn, method: login.method, checkedAt: at };
  }

  /** Plan and usage from `codex app-server`. No model call. Null when the CLI does not answer. */
  limits(): Promise<CodexLimits | null> {
    const c = resolveCodex(this.env);
    if (!c) return Promise.resolve(null);
    return new Promise((done) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(c.cmd, [...c.pre, "app-server"], { env: codexEnv(this.env).env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
      } catch {
        return done(null);
      }
      let settled = false;
      const finish = (v: CodexLimits | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree(child);
        done(v);
      };
      const timer = setTimeout(() => finish(null), 15_000);
      timer.unref();
      const send = (m: object) => {
        try {
          child.stdin?.write(JSON.stringify(m) + "\n");
        } catch {
          // the process is already gone
        }
      };
      child.once("error", () => finish(null));
      child.once("close", () => finish(null));
      child.stdin?.on("error", () => {});
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.id === 1) {
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 2 });
        } else if (m.id === 2) {
          const r = m.result?.rateLimits;
          if (!r) return finish(null);
          const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
          const p = r.primary ?? null;
          const resets = num(p?.resetsAt);
          finish({
            plan: typeof r.planType === "string" ? r.planType.slice(0, 40) : null,
            usedPercent: p ? Math.max(0, Math.min(100, num(p.usedPercent) ?? 0)) : null,
            windowMins: p ? num(p.windowDurationMins) : null,
            resetsAt: resets == null ? null : resets * 1000,
            limitReached: r.rateLimitReachedType != null,
          });
        }
      });
      // Only the rate limits are asked for. `account/read` (which carries the email) is never sent.
      send({ method: "initialize", id: 1, params: { clientInfo: { name: "homebase", title: "HomeBase", version: "0.1.0" } } });
    });
  }

  image(req: CodexImageRequest): Promise<CodexImageResult> {
    const started = this.now();
    const seconds = () => Math.round((this.now() - started) / 100) / 10;
    const c = resolveCodex(this.env);
    if (!c) return Promise.resolve({ ok: false, reason: "failed", message: "The Codex CLI is not installed on this machine.", seconds: 0 });
    // --ignore-user-config keeps the owner's own Codex MCP servers, plugins and hooks out of the call; the login is still used.
    // -s read-only: Codex writes nothing here. Its image tool saves under its own home, and HomeBase copies the file out.
    const args = [...c.pre, "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-C", req.cwd, "-s", "read-only", "--json"];
    // `-i` takes several values, so it goes last; the brief goes in on stdin, where nothing can be mistaken for a file.
    if (req.references.length) args.push("-i", ...req.references);
    else args.push("-");
    return new Promise((done) => {
      let child: ChildProcess;
      try {
        child = this.spawnFn(c.cmd, args, { env: codexEnv(this.env).env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: process.platform !== "win32" });
      } catch (err) {
        return done({ ok: false, reason: "failed", message: `Could not start Codex: ${(err as Error).message}`, seconds: 0 });
      }
      let threadId: string | null = null;
      let note = "";
      let failure: string | null = null;
      let usage: Record<string, unknown> | null = null;
      let stderr = "";
      let ended: "timeout" | "cancelled" | null = null;
      const stop = (why: "timeout" | "cancelled") => {
        ended = ended ?? why;
        killTree(child);
      };
      const timer = setTimeout(() => stop("timeout"), req.timeoutMs ?? 5 * 60_000);
      timer.unref();
      const onAbort = () => stop("cancelled");
      req.signal?.addEventListener("abort", onAbort, { once: true });
      if (req.signal?.aborted) onAbort();

      child.stdin?.on("error", () => {});
      child.stdin?.end(codexBrief(req.prompt, req.references.length));
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id;
        else if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") note = ev.item.text;
        else if (ev.type === "turn.completed") usage = ev.usage ?? null;
        else if (ev.type === "turn.failed" || ev.type === "error") failure = String(ev.error?.message ?? ev.message ?? "Codex reported an error").slice(0, 600);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => {
        stderr = (stderr + d).slice(-1500);
      });
      const settle = (r: CodexImageResult) => {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        done(r);
      };
      child.once("error", (err) => settle({ ok: false, reason: "failed", message: `Could not start Codex: ${err.message}`, seconds: seconds() }));
      child.once("close", (code) => {
        if (ended === "cancelled") return settle({ ok: false, reason: "cancelled", message: "The run was cancelled.", seconds: seconds() });
        if (ended === "timeout") return settle({ ok: false, reason: "timeout", message: "OpenAI took too long, so the request was stopped.", seconds: seconds() });
        // There is no event for the image itself. Codex saves what its image tool makes under generated_images/<thread id>/.
        const dir = threadId && /^[\w-]{8,80}$/.test(threadId) ? join(codexHome(this.env), "generated_images", threadId) : null;
        let files: string[] = [];
        try {
          files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => IMAGE_FILE.test(f)).sort() : [];
        } catch {
          files = [];
        }
        if (dir && files.length) return settle({ ok: true, file: join(dir, files[files.length - 1]), threadId: threadId!, note: note.slice(0, 400), seconds: seconds(), usage });
        const why = failure ?? (note || stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/models cache/i.test(l)).slice(-2).join(" ") || `Codex exited with code ${code}`);
        settle({ ok: false, reason: classifyFailure(why), message: why.slice(0, 600), seconds: seconds() });
      });
    });
  }
}
