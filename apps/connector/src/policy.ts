import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { PermissionMode, Risk } from "@homebase/protocol";

/**
 * Risk classification happens here, on the connector, where the tool call originates
 * (ARCHITECTURE.md 9.4). The hub can add friction but can never loosen this.
 */
export type Verdict =
  | { tier: "auto"; reason: string; /** Allowed here because another layer does the asking; kept off the "auto-approved" audit trail. */ silent?: boolean }
  | { tier: "ask"; risk: Risk; reason: string }
  | { tier: "deny"; reason: string };

export type PermissionProfile = "standard" | "strict";
export type { PermissionMode };

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "LS", "TodoWrite"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const HARD_DENY: Array<[RegExp, string]> = [
  [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, "recursive delete of a root or home directory"],
  [/\b(cat|type|curl|scp|nc|more|less|head|tail|cp|copy|gc|get-content)\b.*(\.env|id_rsa|\.aws\/credentials|\.ssh\/|\.credentials\.json|\.claude[\\/]|\.claude\.json|\.connector\.json)/i, "credential exfiltration pattern"],
  [/\bcurl\b.*\|\s*(ba)?sh\b/i, "piping a download into a shell"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
];

const HIGH: Array<[RegExp, string]> = [
  [/\b(deploy|wrangler\s+deploy|vercel\s+--prod|netlify\s+deploy)\b/i, "deploy"],
  [/\bgit\s+push\b.*\b(main|master|production|release)\b.*(--force|-f)\b|\bgit\s+push\s+(--force|-f)\b/i, "force push to a protected branch"],
  [/\b(delete|drop\s+table|truncate|rm\s+-r)\b/i, "deleting data"],
  [/\b(pay|payment|refund|charge|invoice\s+send|stripe)\b/i, "spending or moving money"],
  [/\b(dns|nameserver|cloudflare\s+zone)\b/i, "DNS change"],
  [/\b(secret|api[_-]?key|token|password)\b/i, "touches secrets"],
];

const MEDIUM: Array<[RegExp, string]> = [
  [/\bgit\s+push\b|\bpush\b/i, "git push"],
  [/\bgit\s+commit\b/i, "git commit"],
  [/\b(npm|pnpm|yarn|pip)\s+(install|add|i)\b/i, "package install"],
  [/\b(send|email|reply)\b/i, "outbound message to a client"],
];

function textOf(tool: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    return [tool, o.command, o.subject, o.to, o.description, o.action].filter((x) => typeof x === "string").join(" ");
  }
  return tool;
}

function insideRoot(path: unknown, cwd: string | null): boolean {
  if (typeof path !== "string" || !cwd) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = norm(path);
  if (p.includes("..")) return false;
  if (!/^([a-zA-Z]:)?\//.test(p)) return true; // relative paths resolve inside cwd
  return p === norm(cwd) || p.startsWith(norm(cwd) + "/");
}

/** The Manual-mode policy: reads pass, everything else asks (or is blocked). */
export function classify(tool: string, input: unknown, ctx: { cwd: string | null; profile?: PermissionProfile } = { cwd: null }): Verdict {
  const text = textOf(tool, input);
  for (const [re, why] of HARD_DENY) if (re.test(text)) return { tier: "deny", reason: `Hard deny: ${why}` };

  if (READ_ONLY_TOOLS.has(tool) || /^mcp__.+__(get|list|read|search)/.test(tool)) return { tier: "auto", reason: "Read-only tool" };

  if (EDIT_TOOLS.has(tool)) {
    const path = (input as any)?.file_path ?? (input as any)?.path;
    if (!insideRoot(path, ctx.cwd)) return { tier: "deny", reason: "Hard deny: edit outside the run's working directory" };
    return ctx.profile === "strict"
      ? { tier: "ask", risk: "low", reason: "File edit (strict profile)" }
      : { tier: "auto", reason: "File edit inside the working directory" };
  }

  for (const [re, why] of HIGH) if (re.test(text)) return { tier: "ask", risk: "high", reason: `Matches rule: ${why}` };
  for (const [re, why] of MEDIUM) if (re.test(text)) return { tier: "ask", risk: "medium", reason: `Matches rule: ${why}` };

  if (tool === "Bash" || tool === "PowerShell") return { tier: "ask", risk: "medium", reason: "Shell command" };
  if (/^mcp__/.test(tool)) return { tier: "ask", risk: "medium", reason: "MCP write" };
  return { tier: "ask", risk: "medium", reason: "Unclassified tool" };
}

// ---------------------------------------------------------------- paths

const slash = (p: string) => p.replace(/\\/g, "/");
const canon = (p: string) => {
  const s = slash(resolve(p)).replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

export function isInside(path: string, root: string): boolean {
  const p = canon(path);
  const r = canon(root);
  return p === r || p.startsWith(r + "/");
}

/** Credential stores and secret files. Never readable or writable by the agent, whatever the owner taps, in every mode. */
const PROTECTED_ROOTS: string[] = [];

/** Marks a directory as off limits to every agent that goes through the generic policy (the notes vault). */
export function protectRoot(dir: string) {
  const abs = resolve(dir);
  if (!PROTECTED_ROOTS.includes(abs)) PROTECTED_ROOTS.push(abs);
}

/** The directories marked with protectRoot, for checks that need the list (a folder that contains one). */
export const protectedRoots = (): string[] => [...PROTECTED_ROOTS];

export function isProtected(abs: string): boolean {
  return PROTECTED_ROOTS.some((r) => isInside(abs, r));
}

/** True when a shell command names a protected directory, by its full path or its `~/` form. */
export function mentionsProtected(command: string): boolean {
  const c = command.replace(/\\/g, "/").toLowerCase();
  return PROTECTED_ROOTS.some((r) => {
    const full = r.replace(/\\/g, "/").toLowerCase();
    const home = homedir().replace(/\\/g, "/").toLowerCase();
    const tilde = full.startsWith(`${home}/`) ? `~/${full.slice(home.length + 1)}` : null;
    return c.includes(full) || (!!tilde && (c.includes(tilde) || c.includes(`$home/${tilde.slice(2)}`)));
  });
}

export function isSensitivePath(abs: string): boolean {
  const p = canon(abs);
  const home = canon(homedir());
  if (p === `${home}/.claude.json` || p.startsWith(`${home}/.claude/`) || p === `${home}/.claude`) return true;
  return /(^|\/)(\.ssh|\.aws|\.gnupg|\.azure|\.kube)(\/|$)/.test(p)
    || /(^|\/)\.env(\.[^/]*)?$/.test(p)
    || /(^|\/)(\.credentials\.json|credentials\.json|\.netrc|\.npmrc|\.pypirc|\.connector\.json|id_(rsa|dsa|ecdsa|ed25519)[^/]*)$/.test(p)
    || /\.(pem|pfx|p12|key)$/.test(p);
}

// ---------------------------------------------------------------- Auto mode: shell commands

/**
 * Auto mode lets the agent run ordinary workspace commands without a prompt. The rule is an allowlist:
 * a command passes only when every part of it is a known build/test/file/git program, every path it
 * names is inside the workspace, and nothing in it is on the "still ask" lists below. Anything this
 * cannot read with confidence (substitutions, variables, inline scripts, unknown programs) asks.
 *
 * It judges the command line, not what the programs do: `npm test` runs whatever the project's test
 * script says. Auto mode is a permission policy, not an operating-system sandbox.
 */
export interface ShellScope {
  /** The run's working directory. */
  cwd: string;
  /** Extra directories that count as the workspace: folders added read & write. */
  roots?: string[];
  /** Folders added read-only. A command may read in them; one that could change them asks. */
  readRoots?: string[];
}

/** Programs that only read what they are pointed at. In a read-only folder, anything else asks first. */
const READ_PROGRAMS = new Set([
  "ls", "dir", "pwd", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "tree",
  "stat", "file", "du", "df", "which", "where", "type", "test", "[", "basename", "dirname", "realpath", "readlink", "jq", "yq", "xxd", "md5sum", "sha1sum",
  "sha256sum", "nl", "less", "more", "cd", "pushd", "echo", "printf",
  "get-childitem", "gci", "get-content", "gc", "test-path", "select-string", "get-item", "get-location", "set-location", "sl", "resolve-path", "join-path",
  "split-path", "get-filehash", "measure-object", "compare-object",
]);
/** Copy commands read every path but the last one, which they write. */
const COPY_PROGRAMS = new Set(["cp", "copy", "copy-item"]);

/** Still asks in Auto, high risk (the owner confirms in the app). Matched against the whole command. */
const AUTO_HIGH: Array<[RegExp, string]> = [
  [/(^|[\s;&|(])(sudo|doas|pkexec|gsudo|runas|su)(\s|$)|-Verb\s+RunAs/i, "runs as another user (sudo)"],
  [/\b(systemctl|service|launchctl|loginctl|crontab|shutdown|reboot|poweroff|halt|netsh|iptables|ufw|mount|umount|chown|schtasks|Restart-Computer|Stop-Computer|Set-ExecutionPolicy)\b|\bsc(\.exe)?\s+(start|stop|config|create|delete)\b|\b(Start|Stop|Restart|Set|New|Remove)-Service\b|\breg(\.exe)?\s+(add|delete|import)\b/i, "system services or system settings"],
  [/\b(apt|apt-get|dnf|yum|pacman|snap|brew|choco|winget|scoop)\s+(install|remove|upgrade|update|uninstall|purge|add)\b/i, "system package manager"],
  [/(^|[\s;&|(])(wrangler|vercel|netlify|flyctl|fly|firebase|heroku|kubectl|helm|terraform|pulumi|ansible|ansible-playbook|serverless|gcloud|aws|az|doctl)(\s|$)|\beas\s+(build|submit|update)\b|\bdocker\s+(push|login)\b/i, "deploy or cloud CLI"],
  [/\bgit\b[^;&|]*\bpush\b/i, "git push"],
  [/\bgit\b[^;&|]*\breset\b[^;&|]*--hard\b/i, "git reset --hard"],
  [/\bgit\b[^;&|]*\bclean\b/i, "git clean"],
  [/\bgit\b[^;&|]*\bcheckout\b[^;&|]*(\s--(\s|$)|\s\.(\s|$))|\bgit\b[^;&|]*\brestore\b/i, "discards local changes"],
  [/\bgit\b[^;&|]*\b(stash\s+(drop|clear)|branch\s+(-D|--delete\s+--force)|rebase|filter-branch|filter-repo|reflog\s+expire|update-ref\s+-d)\b|\bgit\b[^;&|]*\bgc\b[^;&|]*--prune/i, "rewrites or deletes git history"],
  [/\bgit\b[^;&|]*\s(--force|--force-with-lease|-f)(\s|$)/i, "git --force"],
  [/\bgit\b[^;&|]*\bconfig\b[^;&|]*--(global|system)\b|\bgit\b[^;&|]*\bremote\s+(add|set-url|remove|rename)\b/i, "git configuration outside the workspace"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bnuget\s+push\b|\bgh\s+release\b|\bmvn\b[^;&|]*\bdeploy\b|\bgradlew?\b[^;&|]*\bpublish/i, "package publish"],
  [/\b(drop\s+table|drop\s+database|truncate\s+table|delete\s+from)\b/i, "deleting data"],
  [/\bgh\s+auth\b|\bssh-(add|keygen|agent)\b|(^|[\s;&|(])gpg(\s|$)|\bcmdkey\b|\bsecurity\s+find-|\bgit\b[^;&|]*\bcredential/i, "credential access"],
];

/**
 * Words that make a command high risk wherever they appear as an argument (`npm run deploy`,
 * `grep -r password .`). Source files are exempt, so `git add src/token.ts` is still ordinary.
 */
const AUTO_HIGH_WORDS: Array<[RegExp, string]> = [
  [/\bdeploy/i, "deploy"],
  [/\b(secrets?|api[_-]?keys?|tokens?|passwords?|passwd|credentials?)\b/i, "credential access"],
  [/\b(pay|payments?|refunds?|charge|stripe)\b/i, "spending or moving money"],
  [/\b(dns|nameservers?)\b/i, "DNS change"],
];
const SOURCE_FILE = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|cs|rb|php|md|css|scss|html|vue|svelte)$/i;

/** Still asks in Auto, medium risk: network access, and commands that run something this cannot read. */
const AUTO_MEDIUM: Array<[RegExp, string]> = [
  [/(^|[\s;&|(])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp|ping|dig|nslookup|gh)(\s|$)|\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Test-NetConnection)\b|https?:\/\//i, "network access"],
  [/\bgit\b[^;&|]*\b(fetch|pull|clone|ls-remote|submodule)\b/i, "network access (git remote)"],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade|up|remove|uninstall|dlx|create|exec|link)\b|\b(pip|pip3|pipx|uv|poetry)\s+(\w+\s+)?(install|add|sync|update)\b|\bcargo\s+(install|add|update)\b|\bgo\s+(get|install|mod)\b|\bdocker\s+(pull|run|build|compose)\b/i, "package install (network)"],
  [/(^|[\s;&|(])(kill|pkill|killall|taskkill)(\s|$)|\bStop-Process\b/i, "stops processes"],
  [/(^|[\s;&|(])(eval|exec|source|xargs|nohup|env|printenv)(\s|$)|(^|[;&|]\s*)\.\s+\S|\b(bash|sh|zsh|dash|cmd|pwsh|powershell)(\.exe)?\s+(-\w*c\b|\/c\b|-Command\b|-EncodedCommand\b|-File\b)|\b(Invoke-Expression|iex|Start-Process)\b/i, "runs another command indirectly"],
  [/\b(node|deno|bun)\b[^;&|]*\s(-e|-p|--eval|--print)\b|\b(python3?|py|perl|ruby|php)\b[^;&|]*\s-[ceE]\b|\s-exec(dir)?\b|\s-delete\b|\bsystem\s*\(/i, "runs inline code"],
];
/** Expansions the policy cannot follow. Checked with single-quoted (literal) text blanked out. */
const EXPANSION = /\$\(|`|<\(|\$\{?[A-Za-z_]|%[A-Za-z_]+%|\$env:/i;

const FILE_PROGRAMS = [
  "ls", "dir", "pwd", "echo", "printf", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "find", "fd", "sort", "uniq", "cut", "tr",
  "sed", "awk", "diff", "cmp", "comm", "tree", "stat", "file", "du", "df", "which", "where", "type", "command", "test", "[", "true", "false", "date",
  "sleep", "basename", "dirname", "realpath", "readlink", "mkdir", "touch", "cp", "mv", "rm", "rmdir", "ln", "chmod", "tee", "tar", "zip", "unzip",
  "gzip", "gunzip", "jq", "yq", "xxd", "md5sum", "sha1sum", "sha256sum", "nl", "seq", "cd", "pushd", "popd", "export", "set", "unset", "clear", "time",
  "timeout", "less", "more", "copy", "move", "del", "ren", "md", "rd",
];
const BUILD_PROGRAMS = [
  "node", "tsc", "tsx", "ts-node", "vitest", "jest", "mocha", "eslint", "prettier", "biome", "vite", "webpack", "rollup", "esbuild", "turbo", "nx",
  "next", "astro", "make", "cmake", "ninja", "python", "python3", "py", "pytest", "ruff", "black", "mypy", "flake8", "tox", "gradle", "gradlew", "mvn",
];
const POWERSHELL_CMDLETS = [
  "get-childitem", "gci", "get-content", "gc", "set-content", "add-content", "out-file", "new-item", "ni", "remove-item", "ri", "copy-item", "move-item",
  "rename-item", "test-path", "select-string", "write-output", "write-host", "get-location", "set-location", "sl", "measure-object", "select-object",
  "sort-object", "format-table", "format-list", "get-item", "get-date", "join-path", "split-path", "resolve-path", "out-null", "out-string",
  "convertto-json", "convertfrom-json", "get-filehash", "compare-object",
];
const SAFE_PROGRAMS = new Set([...FILE_PROGRAMS, ...BUILD_PROGRAMS, ...POWERSHELL_CMDLETS]);

/** Programs that are fine only with these subcommands. */
const SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "status", "diff", "add", "commit", "log", "show", "branch", "checkout", "switch", "stash", "tag", "init", "rev-parse", "ls-files", "blame", "mv",
    "rm", "merge", "cherry-pick", "describe", "shortlog", "grep", "remote", "config", "reflog", "ls-tree", "cat-file", "diff-tree", "name-rev", "apply", "revert",
  ]),
  npm: new Set(["run", "run-script", "test", "t", "start", "ls", "list", "pkg", "version", "--version", "-v"]),
  pnpm: new Set(["run", "test", "t", "start", "build", "lint", "typecheck", "format", "check", "ls", "list", "--version", "-v"]),
  yarn: new Set(["run", "test", "start", "build", "lint", "typecheck", "format", "check", "list", "--version", "-v"]),
  bun: new Set(["run", "test", "build", "lint", "typecheck", "--version", "-v"]),
  npx: new Set(["tsc", "tsx", "vitest", "jest", "mocha", "eslint", "prettier", "biome", "vite", "webpack", "rollup", "esbuild", "turbo", "nx", "playwright", "ts-node"]),
  cargo: new Set(["build", "test", "check", "fmt", "clippy", "run", "bench", "doc", "clean", "tree", "metadata", "--version"]),
  go: new Set(["build", "test", "vet", "fmt", "run", "list", "version"]),
  dotnet: new Set(["build", "test", "run", "format", "clean", "--version"]),
};
SUBCOMMANDS.pnpx = SUBCOMMANDS.npx;
SUBCOMMANDS.bunx = SUBCOMMANDS.npx;

const RECURSIVE_DELETE = new Set(["rm", "rmdir", "rd", "del", "remove-item", "ri"]);
const HARMLESS_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "nul", "$null"]);

interface Segment {
  words: string[];
  /** The words that are output redirection targets (`> file`, `>> file`): the command writes them. */
  outputs?: string[];
}

/**
 * Splits a command line into simple commands at unquoted `;`, `&&`, `||`, `|`, `&` and newlines.
 * Quotes are removed from words. Redirection targets stay as words, so their paths are checked too.
 */
export function splitCommand(command: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let outputs: string[] = [];
  let writing = false;
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (has) {
      words.push(cur);
      if (writing) outputs.push(cur);
      writing = false;
    }
    cur = "";
    has = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(outputs.length ? { words, outputs } : { words });
    words = [];
    outputs = [];
    writing = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length && /["\\$`]/.test(command[i + 1])) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < command.length && /[\s"'\\;&|<>]/.test(command[i + 1])) {
      if (command[i + 1] === "\n") i++; // line continuation
      else {
        cur += command[++i];
        has = true;
      }
    } else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      endSegment();
    } else if (c === ">" || c === "<") {
      // `2>file`, `>>file`, `<file`: drop the operator (and a leading fd digit), keep the target as its own word.
      if (/^\d$/.test(cur)) {
        cur = "";
        has = false;
      }
      endWord();
      writing = c === ">";
      if (command[i + 1] === ">" ) i++;
      if (command[i + 1] === "&") {
        i++; // `2>&1`: skip the fd it points at
        while (i + 1 < command.length && /\d/.test(command[i + 1])) i++;
        writing = false;
      }
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      cur += c;
      has = true;
    }
  }
  endSegment();
  return segments;
}

const programName = (word: string) => slash(word).split("/").pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();

const worse = (a: Verdict | null, b: Verdict): Verdict => {
  const rank = (v: Verdict) => (v.tier === "deny" ? 4 : v.tier === "ask" ? (v.risk === "high" ? 3 : v.risk === "medium" ? 2 : 1) : 0);
  return !a || rank(b) > rank(a) ? b : a;
};
const ask = (risk: Risk, why: string): Verdict => ({ tier: "ask", risk, reason: `Auto mode still asks: ${why}` });

/** The Auto-mode verdict for one shell command (Bash or PowerShell). */
export function classifyShellAuto(command: string, scope: ShellScope): Verdict {
  const roots = [scope.cwd, ...(scope.roots ?? [])];
  for (const [re, why] of HARD_DENY) if (re.test(command)) return { tier: "deny", reason: `Hard deny: ${why}` };
  if (!command.trim()) return { tier: "ask", risk: "medium", reason: "Empty command" };
  if (command.length > 4000) return ask("medium", "command too long to check");

  // Commit messages are text, not commands. Claude Code writes them as -m "$(cat <<'EOF' … EOF)"; that one
  // substitution, and any quoted -m value without an expansion in it, is replaced before the rules run.
  const text = command
    .replace(/"\$\(cat <<-?\s*'(\w+)'\r?\n[\s\S]*?\r?\n\s*\1\s*\r?\n?\s*\)"/g, '"message"')
    .replace(/(\s(?:-m|--message)[\s=])(?:"(?:[^"\\$`]|\\[^$`])*"|'[^']*')/g, '$1"message"');
  // Single-quoted text is literal, so it cannot hide an expansion.
  const code = text.replace(/'[^']*'/g, "''");

  let out: Verdict | null = null;
  for (const [re, why] of AUTO_HIGH) if (re.test(text)) out = worse(out, ask("high", why));
  for (const [re, why] of AUTO_MEDIUM) if (re.test(text)) out = worse(out, ask("medium", why));
  if (EXPANSION.test(code)) out = worse(out, ask("medium", "uses shell expansion that cannot be checked"));

  let here = resolve(scope.cwd);
  const readRoots = scope.readRoots ?? [];
  /** The most specific folder a path is in decides: a read-only folder inside the workspace stays read-only. */
  const deepest = (abs: string): { root: string; readOnly: boolean } | null => {
    let best: { root: string; readOnly: boolean } | null = null;
    for (const r of roots) if (isInside(abs, r) && (!best || canon(r).length > canon(best.root).length)) best = { root: r, readOnly: false };
    for (const r of readRoots) if (isInside(abs, r) && (!best || canon(r).length >= canon(best.root).length)) best = { root: r, readOnly: true };
    return best;
  };
  const inWorkspace = (abs: string) => !!deepest(abs);
  const toAbs = (w: string) => {
    const p = /^~([\\/]|$)/.test(w) ? homedir() + w.slice(1) : w;
    return isAbsolute(p) ? resolve(p) : resolve(here, p);
  };

  for (const seg of splitCommand(text)) {
    const words = [...seg.words];
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // FOO=bar cmd
    if (!words.length) continue;
    const prog = programName(words[0]);
    const args = words.slice(1);
    const sub = args.find((a) => !a.startsWith("-") || a === "--version" || a === "-v")?.toLowerCase();

    if (SUBCOMMANDS[prog]) {
      if (!sub || !SUBCOMMANDS[prog].has(sub)) out = worse(out, ask("medium", `"${[prog, sub].filter(Boolean).join(" ")}" is not an ordinary workspace command`));
    } else if (!SAFE_PROGRAMS.has(prog)) {
      out = worse(out, ask("medium", `unrecognised command "${prog.slice(0, 40)}"`));
    }

    // Every path a command names must stay inside the workspace, and none may be a secret.
    const targets: string[] = [];
    for (let w of args) {
      if (w.startsWith("-") || (w.startsWith("/") && /^\/[a-z?]$/i.test(w))) {
        const eq = w.indexOf("=");
        if (eq < 0) continue;
        w = w.slice(eq + 1);
      }
      if (!w || w === "message" || HARMLESS_PATHS.has(w.toLowerCase())) continue;
      targets.push(w);
      if (!SOURCE_FILE.test(w)) for (const [re, why] of AUTO_HIGH_WORDS) if (re.test(w)) out = worse(out, ask("high", why));
      const abs = toAbs(w);
      if (isSensitivePath(abs)) return { tier: "deny", reason: "Hard deny: credential or secret file" };
      if (!inWorkspace(abs)) out = worse(out, ask("high", "touches a path outside the workspace"));
    }
    // A folder that was added read-only: plain read commands pass; anything that could write there asks, in the app.
    const inReadOnly = targets.filter((t) => deepest(toAbs(t))?.readOnly);
    if (inReadOnly.length) {
      const written = (seg.outputs ?? []).some((o) => inReadOnly.includes(o));
      const copyOk = COPY_PROGRAMS.has(prog) && !inReadOnly.includes(targets[targets.length - 1]);
      if (written || !(READ_PROGRAMS.has(prog) || copyOk)) out = worse(out, ask("high", "could change a folder that was added read-only"));
    }
    for (const [re, why] of AUTO_HIGH_WORDS) if (re.test(prog)) out = worse(out, ask("high", why));

    if (RECURSIVE_DELETE.has(prog) && args.some((a) => /^-[a-z]*r|^--recursive$|^-recurse$|^\/s$/i.test(a))) {
      const bad = targets.length === 0 || targets.some((t) => {
        if (/[*?]/.test(t) && !/[\\/]/.test(t.replace(/[\\/]+$/, ""))) return true; // `rm -rf *`
        const abs = toAbs(t);
        return !inWorkspace(abs) || roots.some((r) => canon(abs) === canon(r)) || /(^|\/)\.git(\/|$)/.test(slash(abs));
      });
      if (bad) out = worse(out, ask("high", "recursive delete of the workspace itself, its .git, or something outside it"));
    }

    if ((prog === "cd" || prog === "pushd" || prog === "set-location" || prog === "sl") && targets[0]) {
      const next = toAbs(targets[0]);
      if (inWorkspace(next)) here = next;
    }
  }
  return out ?? { tier: "auto", reason: "Workspace command (auto mode)" };
}
