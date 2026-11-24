#!/usr/bin/env node
// Secret and personal-data scanner. No dependencies; runs from the git hooks in .githooks and in CI.
//
//   node scripts/scan-secrets.mjs --staged          what `git commit` is about to record (pre-commit hook)
//   node scripts/scan-secrets.mjs --push            the commits `git push` is about to send (pre-push hook; reads stdin)
//   node scripts/scan-secrets.mjs --tracked         every tracked file (CI, or a one-off check)
//   node scripts/scan-secrets.mjs <file>...         the given files on disk
//   add --no-gitleaks to skip gitleaks even when it is installed
//
// It blocks:
//   - common secret formats (cloud keys, GitHub/Anthropic/OpenAI/Google/Slack/Stripe tokens, private keys, JWTs, and
//     long random-looking values assigned to key/secret/token/password names);
//   - files that must never be committed (.env, databases, keys and keystores, connector identities, APKs, installers);
//   - anything on a personal denylist that lives OUTSIDE the repo, so private names are never written into it:
//       $HOMEBASE_DENYLIST_FILE, <git dir>/hooks-denylist, ~/.config/homebase/denylist.txt, and $HOMEBASE_DENYLIST.
//     One entry per line (or comma-separated in the variable): a plain string (case-insensitive, whole word) or
//     /regex/flags. Lines starting with # are comments.
// A line containing `scan-allow` is skipped (for a false positive; say why next to it). When gitleaks is on PATH it
// runs too, as a second opinion. Exit code 1 when anything is found; findings never print a full secret.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOW_MARKER = "scan-allow";
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Secret formats. Each finding names the rule, never the full value. */
export const SECRET_RULES = [
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "aws-secret-key", re: /aws.{0,20}secret.{0,20}[=:]\s*["']?[A-Za-z0-9/+]{40}\b/i },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { id: "openai-key", re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { id: "google-oauth-client-secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { id: "google-oauth-client-secret", re: /["']?client_secret["']?\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "google-refresh-token", re: /\b1\/\/0[A-Za-z0-9_-]{30,}/ },
  { id: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: "stripe-live-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { id: "private-key", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

/** `name = "value"` where the name says secret and the value looks random. */
const ASSIGNMENT = /([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|client[_-]?secret|access[_-]?key|private[_-]?key|auth[_-]?key)[A-Za-z0-9_.-]*)["']?\s*(?::|=|:=|=>)\s*["'`]([^"'`\s]{16,})["'`]/gi;
const PLACEHOLDER = /example|sample|dummy|fake|test|placeholder|changeme|change-me|your[_-]|xxx|\*\*\*|<|>|\$\{|\{\{|redacted|not-a-real|lorem/i;

export function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
}

const looksRandom = (v) =>
  v.length >= 16 && entropy(v) >= 3.5 && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && !PLACEHOLDER.test(v) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v); // not a URL

/** Paths that must never be committed, whatever they contain. */
export function forbiddenPath(path) {
  const p = path.replace(/\\/g, "/");
  const name = basename(p).toLowerCase();
  if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name)) return "env file";
  if (/\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3|sqlite-wal|sqlite-shm)$/.test(name)) return "database file";
  if (/\.(pem|key|p12|pfx|jks|keystore|mobileprovision|ppk)$/.test(name)) return "key or keystore";
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) return "ssh key";
  if (name === ".connector.json" || name === "dev-pairing.json" || name === "approved-folders.json") return "connector identity or pairing file";
  if (/^client_secret.*\.json$/.test(name) || name === "google-oauth-client.json" || /token\.json$/.test(name)) return "OAuth client or token file";
  if (/\.(apk|aab|ipa|exe|msi|dmg|blockmap)$/.test(name)) return "app build or installer";
  if (/\.(onnx|gguf|safetensors|tflite)$/.test(name)) return "model file";
  if (name === "claude.local.md") return "local-only Claude notes";
  if (/^(data|dist-apk|dist-desktop)\//.test(p) || /(^|\/)node_modules\//.test(p)) return "build output or runtime data folder";
  return null;
}

/** Entries from text: one per line; `#` comments; `/re/flags` or a plain string (case-insensitive, whole word). */
export function parseDenylist(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    if (m) {
      try {
        out.push(new RegExp(m[1], m[2].includes("i") ? m[2] : m[2] + "i"));
      } catch {
        /* a broken entry is ignored rather than blocking every commit */
      }
      continue;
    }
    const esc = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out.push(new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "i"));
  }
  return out;
}

export function denylistSources(env = process.env, gitDir = null) {
  const files = [env.HOMEBASE_DENYLIST_FILE, gitDir && join(gitDir, "hooks-denylist"), join(homedir(), ".config", "homebase", "denylist.txt")].filter(Boolean);
  return files;
}

export function loadDenylist(env = process.env, gitDir = null) {
  const entries = [];
  const used = [];
  for (const f of denylistSources(env, gitDir)) {
    if (existsSync(f)) {
      entries.push(...parseDenylist(readFileSync(f, "utf8")));
      used.push(f);
    }
  }
  if (env.HOMEBASE_DENYLIST) {
    entries.push(...parseDenylist(env.HOMEBASE_DENYLIST.replace(/,/g, "\n")));
    used.push("$HOMEBASE_DENYLIST");
  }
  return { entries, used };
}

const redact = (s) => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…(${s.length} chars)`);

/**
 * Findings in one text. `lines` may be given instead of `text` with their real line numbers ({ n, text }).
 * @returns {Array<{ file: string, line: number, rule: string, hint: string }>}
 */
export function scanText(file, text, denylist = [], lines = null) {
  const out = [];
  const list = lines ?? String(text).split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t }));
  for (const { n, text: line } of list) {
    if (line.includes(ALLOW_MARKER) || line.length > 20000) continue;
    for (const r of SECRET_RULES) {
      const m = r.re.exec(line);
      if (m) out.push({ file, line: n, rule: r.id, hint: redact(m[0]) });
    }
    for (const m of line.matchAll(ASSIGNMENT)) {
      if (looksRandom(m[2])) out.push({ file, line: n, rule: "high-entropy-secret", hint: `${m[1]} = ${redact(m[2])}` });
    }
    denylist.forEach((re, i) => {
      if (re.test(line)) out.push({ file, line: n, rule: "personal-denylist", hint: `entry #${i + 1}` });
    });
  }
  return out;
}

/** The file name itself can be personal too (a client's name in a path). */
export function scanPath(file, denylist = []) {
  const out = [];
  const why = forbiddenPath(file);
  if (why) out.push({ file, line: 0, rule: "forbidden-file", hint: why });
  denylist.forEach((re, i) => {
    if (re.test(file)) out.push({ file, line: 0, rule: "personal-denylist", hint: `entry #${i + 1} (in the path)` });
  });
  return out;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

export function scanBuffer(file, buf, denylist = []) {
  const out = scanPath(file, denylist);
  if (buf.length > MAX_FILE_BYTES) out.push({ file, line: 0, rule: "large-file", hint: `${(buf.length / 1048576).toFixed(1)} MB (limit ${MAX_FILE_BYTES / 1048576} MB)` });
  if (!isBinary(buf)) out.push(...scanText(file, buf.toString("utf8"), denylist));
  return out;
}

/**
 * Added lines per file from `git log -p` / `git diff` output, with their line numbers in the new file.
 * @returns {Array<{ file: string, lines: Array<{ n: number, text: string }>, commit: string | null, message: string[] }>}
 */
export function parsePatch(patch) {
  const files = [];
  const messages = new Map();
  let commit = null;
  let cur = null;
  let n = 0;
  let inHeader = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("commit:")) {
      commit = line.slice(7).trim();
      messages.set(commit, []);
      inHeader = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHeader = false;
      cur = null;
      continue;
    }
    if (inHeader && commit) {
      messages.get(commit).push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      cur = path === "/dev/null" ? null : { file: path, lines: [], commit };
      if (cur) files.push(cur);
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.lines.push({ n: n++, text: line.slice(1) });
    else if (!line.startsWith("-") && !line.startsWith("\\")) n++;
  }
  return { files, messages };
}

/** Commit messages: secrets and denylist, except attribution trailers (Co-Authored-By, Signed-off-by). */
export function scanMessage(commit, lines, denylist) {
  const kept = lines.map((text, i) => ({ n: i + 1, text })).filter((l) => !/^\s*(co-authored-by|signed-off-by):/i.test(l.text));
  return scanText(`commit ${commit.slice(0, 10)} (message)`, "", denylist, kept);
}

// ------------------------------------------------------------------------------------------------ git plumbing

const git = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30, ...opts });
const gitBuf = (args) => execFileSync("git", args, { maxBuffer: 1 << 30 });
const ZERO = /^0+$/;

function stagedFindings(denylist) {
  const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
  const out = [];
  for (const f of names) out.push(...scanBuffer(f, gitBuf(["show", `:${f}`]), denylist));
  return { out, count: names.length };
}

function trackedFindings(denylist) {
  const names = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  const out = [];
  for (const f of names) {
    if (!existsSync(f) || !statSync(f).isFile()) continue;
    out.push(...scanBuffer(f, readFileSync(f), denylist));
  }
  return { out, count: names.length };
}

function pushFindings(stdin, denylist) {
  const out = [];
  let count = 0;
  for (const line of stdin.split(/\r?\n/).filter(Boolean)) {
    const [, localSha, , remoteSha] = line.split(" ");
    if (!localSha || ZERO.test(localSha)) continue; // a delete
    const range = remoteSha && !ZERO.test(remoteSha) ? [`${remoteSha}..${localSha}`] : [localSha, "--not", "--remotes"];
    const patch = git(["log", "-p", "-U0", "--no-color", "--no-ext-diff", "--format=commit:%H%n%B", "--diff-filter=ACMR", ...range]);
    const { files, messages } = parsePatch(patch);
    for (const [c, msg] of messages) {
      count++;
      out.push(...scanMessage(c, msg, denylist));
    }
    for (const f of files) {
      const where = f.commit ? `${f.file} @${f.commit.slice(0, 10)}` : f.file;
      // Judge the real path; the commit suffix is only for the report (".env.example @abc" must still count as an example).
      out.push(...scanPath(f.file, denylist).map((x) => ({ ...x, file: where })));
      out.push(...scanText(where, "", denylist, f.lines));
    }
  }
  return { out, count };
}

/** gitleaks as a second opinion when it is installed: null when it is not, else whether it found nothing. */
function runGitleaks(mode) {
  const v = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  if (v.error || v.status !== 0) return null;
  const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(v.stdout) ?? []).slice(1).map(Number);
  const modern = major > 8 || (major === 8 && minor >= 19); // 8.19 replaced `protect`/`detect` with `git`
  const logOpts = mode === "push" ? ["--log-opts=--not --remotes"] : [];
  const args = modern
    ? mode === "staged" ? ["git", "--pre-commit", "--staged", "--redact", "--no-banner", "."] : ["git", "--redact", "--no-banner", ...logOpts, "."]
    : mode === "staged" ? ["protect", "--staged", "--redact", "--no-banner"] : ["detect", "--redact", "--no-banner", ...logOpts];
  return spawnSync("gitleaks", args, { stdio: "inherit" }).status === 0;
}

function report(findings, what) {
  if (!findings.length) return;
  console.error(`\nscan-secrets: ${findings.length} problem(s) in ${what}:`);
  for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ""}  [${f.rule}]  ${f.hint}`);
  console.error(
    "\nRemove the value (or unstage the file). Secrets and personal data belong in untracked config such as" +
      "\n~/.config/homebase/homebase.env or .env.local. A real false positive: add a `scan-allow` comment on that line.\n",
  );
}

function main(argv) {
  const args = new Set(argv);
  const files = argv.filter((a) => !a.startsWith("--"));
  let gitDir = null;
  try {
    gitDir = git(["rev-parse", "--absolute-git-dir"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {}
  const { entries: denylist, used } = loadDenylist(process.env, gitDir);
  let mode = "files";
  let result;
  if (args.has("--staged")) (mode = "staged"), (result = stagedFindings(denylist));
  else if (args.has("--push")) {
    mode = "push";
    let stdin = "";
    try {
      stdin = readFileSync(0, "utf8");
    } catch {}
    result = pushFindings(stdin, denylist);
  } else if (args.has("--tracked") || !files.length) (mode = "tracked"), (result = trackedFindings(denylist));
  else {
    const out = [];
    for (const f of files) out.push(...scanBuffer(f, readFileSync(f), denylist));
    result = { out, count: files.length };
  }
  const what = { staged: "staged files", push: "commits to push", tracked: "tracked files", files: "files" }[mode];
  report(result.out, what);
  const leaks = args.has("--no-gitleaks") || mode === "files" ? null : runGitleaks(mode);
  const ok = !result.out.length && leaks !== false;
  console.error(
    `scan-secrets: ${ok ? "clean" : "BLOCKED"} (${result.count} ${mode === "push" ? "commit(s)" : "file(s)"}; ` +
      `${denylist.length} personal denylist entr${denylist.length === 1 ? "y" : "ies"}${used.length ? "" : " (none configured)"}; ` +
      `gitleaks ${leaks === null ? "not run" : leaks ? "clean" : "found leaks"})`,
  );
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
