import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ES module without types
import { entropy, forbiddenPath, parseDenylist, parsePatch, scanBuffer, scanMessage, scanPath, scanText } from "../scan-secrets.mjs";

// Fake credentials are assembled at run time so that this file itself never contains one.
const j = (...p: string[]) => p.join("");
const FAKE = {
  github: j("gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
  githubPat: j("github", "_pat_", "11ABCDEFG0123456789abcdefghijklmnop"),
  anthropic: j("sk-", "ant-", "api03-", "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg"),
  openai: j("sk-", "proj-", "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8"),
  aws: j("AK", "IA", "Q2W3E4R5T6Y7U8I9"),
  google: j("GOC", "SPX-", "a1B2c3D4e5F6g7H8i9J0k1L2m3"),
  googleKey: j("AI", "za", "Sy0123456789abcdefghijklmnopqrstuvw"),
  pem: j("-----BEGIN ", "OPENSSH ", "PRIVATE KEY-----"),
  jwt: j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
};
const rules = (file: string, text: string, deny: RegExp[] = []) => scanText(file, text, deny).map((f: { rule: string }) => f.rule);

describe("secret formats", () => {
  it("finds each common token format and never prints the whole value", () => {
    const cases: Array<[string, string]> = [
      [`const t = "${FAKE.github}";`, "github-token"],
      [`token: ${FAKE.githubPat}`, "github-pat"],
      [`ANTHROPIC_API_KEY=${FAKE.anthropic}`, "anthropic-key"],
      [`OPENAI_API_KEY=${FAKE.openai}`, "openai-key"],
      [`aws_access_key_id = ${FAKE.aws}`, "aws-access-key"],
      [`"client_secret": "${FAKE.google}"`, "google-oauth-client-secret"],
      [`key=${FAKE.googleKey}`, "google-api-key"],
      [FAKE.pem, "private-key"],
      [`Authorization: Bearer ${FAKE.jwt}`, "jwt"],
    ];
    for (const [line, rule] of cases) {
      const found = scanText("x.ts", line);
      expect(found.map((f: { rule: string }) => f.rule), line).toContain(rule);
      for (const f of found) expect(f.hint).not.toContain(line.slice(-12));
    }
    expect(rules("x.ts", `ANTHROPIC_API_KEY=${FAKE.anthropic}`)).not.toContain("openai-key");
  });

  it("flags random-looking values assigned to secret-ish names, not placeholders or ordinary words", () => {
    expect(rules("a.ts", `const apiKey = "Zq81Lm2Xv93Np4Rt5Ws6";`)).toContain("high-entropy-secret"); // scan-allow: the scanner's own fake
    expect(rules("a.json", `"refresh_token": "1x2Yz3aB4cD5eF6gH7iJ8kL9"`)).toContain("high-entropy-secret"); // scan-allow: the scanner's own fake
    for (const ok of [
      `const token = "fake-refresh-token-value";`,
      `password: "<your-password-here>"`,
      `apiKey = "\${process.env.KEY_FROM_ENV}"`,
      `const tokenKey = "hb.session.token.v1";`,
      `secret: "aaaaaaaaaaaaaaaaaaaa"`,
    ]) expect(rules("a.ts", ok), ok).toEqual([]);
    expect(entropy("aaaa")).toBe(0);
  });

  it("skips a line marked scan-allow", () => {
    expect(rules("x.ts", `const t = "${FAKE.github}"; // scan-allow: documented fake`)).toEqual([]);
  });
});

describe("forbidden files", () => {
  it("blocks env files, databases, keys, identities, builds and models by name", () => {
    for (const p of [".env", "apps/x/.env.local", "data/homebase.db", "x.db-wal", "a.sqlite", "certs/server.pem", "debug.keystore", "key.p12",
      "apps/connector/.connector.json", "client_secret_123.json", "secrets/gmail-token.json", "dist-apk/HomeBase.apk", "Setup.exe",
      "models/whisper.onnx", "CLAUDE.local.md", "id_ed25519", "node_modules/x/index.js", "dist-desktop/a.txt"]) {
      expect(forbiddenPath(p), p).not.toBeNull();
    }
    for (const p of [".env.example", "scripts/server/homebase.env.example", "README.md", "apps/desktop/build/icon.ico", "apps/server/src/schema.sql", "packages/protocol/src/data.ts"]) {
      expect(forbiddenPath(p), p).toBeNull();
    }
  });

  it("blocks files over the size limit", () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0x61);
    expect(scanBuffer("big.txt", big).map((f: { rule: string }) => f.rule)).toContain("large-file");
  });
});

describe("personal denylist", () => {
  const deny = parseDenylist(["# private names", "Acme Private Client", "owner@example.org", "/10\\.9\\.8\\.\\d+/", "", "box1"].join("\n"));

  it("matches plain entries case-insensitively as whole words, and regex entries", () => {
    expect(deny).toHaveLength(4);
    expect(rules("n.md", "Meeting with ACME private client today", deny)).toEqual(["personal-denylist"]);
    expect(rules("n.md", "mail OWNER@example.org", deny)).toEqual(["personal-denylist"]);
    expect(rules("n.md", "hub at http://10.9.8.7:8787", deny)).toEqual(["personal-denylist"]);
    expect(rules("n.md", "ssh box1 ls", deny)).toEqual(["personal-denylist"]);
    expect(rules("n.md", "a sandbox12 folder", deny)).toEqual([]);
  });

  it("names the entry by number only, so a CI log never shows the private value", () => {
    const [f] = scanText("n.md", "owner@example.org", deny);
    expect(f.hint).toBe("entry #2");
    expect(JSON.stringify(f)).not.toContain("example.org");
  });

  it("checks paths too, and ignores a broken regex instead of blocking everything", () => {
    expect(scanPath("docs/clients/box1-notes.md", deny).map((f: { rule: string }) => f.rule)).toEqual(["personal-denylist"]);
    expect(parseDenylist("/([/\nok")).toHaveLength(1);
  });
});

describe("pre-push patches", () => {
  it("reads added lines with their line numbers and the commit messages", () => {
    const patch = [
      "commit:abc123", "Add config", "", "Co-Authored-By: Someone <someone@example.org>", "",
      "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1,0 +5,2 @@", "+first", `+key ${FAKE.github}`,
      "diff --git a/gone.txt b/gone.txt", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-old",
    ].join("\n");
    const { files, messages } = parsePatch(patch);
    expect(files).toEqual([{ file: "a.txt", commit: "abc123", lines: [{ n: 5, text: "first" }, { n: 6, text: `key ${FAKE.github}` }] }]);
    expect(messages.get("abc123")).toContain("Add config");
    const deny = parseDenylist("someone@example.org");
    expect(scanMessage("abc123", messages.get("abc123"), deny)).toEqual([]); // attribution trailers are allowed
    expect(scanMessage("abc123", ["mail someone@example.org"], deny)).toHaveLength(1);
  });
});

describe("the CLI and the git hooks", () => {
  const root = resolve(__dirname, "..", "..");
  const scanner = join(root, "scripts", "scan-secrets.mjs");
  let repo = "";
  let denyFile = "";
  const env = () => ({ ...process.env, HOMEBASE_DENYLIST_FILE: denyFile, HOMEBASE_DENYLIST: "", PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1" });
  const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", env: env() });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "hb-scan-"));
    denyFile = join(repo, "..", `${repo.split(/[\\/]/).pop()}-deny.txt`);
    writeFileSync(denyFile, "my-private-host\n");
    // The hooks run `node scripts/scan-secrets.mjs` from the top of the checkout, as they do in this repo.
    mkdirSync(join(repo, "scripts"));
    copyFileSync(scanner, join(repo, "scripts", "scan-secrets.mjs"));
    g("init", "-q", "-b", "main");
    g("config", "user.name", "Test");
    g("config", "user.email", "test@example.org");
    g("config", "commit.gpgsign", "false");
    g("config", "core.hooksPath", join(root, ".githooks").replace(/\\/g, "/"));
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(denyFile, { force: true });
  });

  const commit = (file: string, text: string) => {
    writeFileSync(join(repo, file), text);
    g("add", "-f", file); // -f: a global gitignore may hide .env, and the hook must catch it anyway
    const r = spawnSync("git", ["commit", "-q", "-m", `add ${file}`], { cwd: repo, encoding: "utf8", env: env() });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("lets a clean commit through and blocks a token, a denylisted name and a forbidden file", () => {
    expect(commit("ok.txt", "hello\n").code).toBe(0);
    const tok = commit("tok.txt", `t=${FAKE.github}\n`);
    expect(tok.code).not.toBe(0);
    expect(tok.out).toContain("github-token");
    expect(tok.out).not.toContain(FAKE.github);
    g("reset", "-q");
    const name = commit("n.txt", "ssh my-private-host\n");
    expect(name.code).not.toBe(0);
    expect(name.out).toContain("personal-denylist");
    g("reset", "-q");
    expect(commit(".env", "A=1\n").code).not.toBe(0);
    g("reset", "-q");
  }, 60_000);

  it("scans given files and exits 1 on a finding, 0 when clean", () => {
    writeFileSync(join(repo, "clean.txt"), "nothing here\n");
    writeFileSync(join(repo, "dirty.txt"), `key ${FAKE.anthropic}\n`);
    const run = (f: string) => spawnSync(process.execPath, [scanner, f], { cwd: repo, encoding: "utf8", env: env() }).status;
    expect(run("clean.txt")).toBe(0);
    expect(run("dirty.txt")).toBe(1);
  }, 30_000);

  it("pre-push lets an example env file through and still blocks a real one", () => {
    expect(commit(".env.example", "HOMEBASE_APP_ID=com.kotashbuilds.homebase\n").code).toBe(0);
    const head = g("rev-parse", "HEAD").trim();
    const push = () =>
      spawnSync(process.execPath, [scanner, "--push", "origin", "https://example.org/x.git"], {
        cwd: repo, encoding: "utf8", env: env(), input: `refs/heads/main ${g("rev-parse", "HEAD").trim()} refs/heads/main ${"0".repeat(40)}\n`,
      });
    expect(push().status).toBe(0);
    // A real .env committed past the hook must still stop the push.
    writeFileSync(join(repo, ".env"), "A=1\n");
    g("add", "-f", ".env");
    g("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "env");
    const blocked = push();
    expect(blocked.status).toBe(1);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain("forbidden-file");
    g("reset", "-q", "--hard", head);
  }, 60_000);
});
