import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type Agent, type ApprovedFolder, type FolderListing, type Message, type Project, type Run, type RunEventKind, type Thread } from "@homebase/protocol";
import type { HubApp } from "../../server/src/app";
import { ApprovalServer, decidePermission, type PermissionEnv } from "../src/adapters/claude-approvals";
import { buildArgs, createClaudeCodeAdapter } from "../src/adapters/claude-code";
import type { ApprovalDecision, RunContext } from "../src/adapters/types";
import { loadClaudeConfig } from "../src/config";
import { FolderError, FolderService, FolderStore, addBlock, editDenyRule, enterBlock, folderAdvice, type FolderRules } from "../src/folders";
import { HubLink } from "../src/HubLink";
import { classifyShellAuto, splitCommand } from "../src/policy";
import { askApprovalTool, fakeClaude, fixture, testConfig, turnsOf } from "./claude-fixtures";
import { bootHub, connectDevice, pairToken, waitFor } from "./harness";

const listFiles = turnsOf(fixture("claude-list-files.jsonl"));
const approve: ApprovalDecision = { decision: "approve", message: null, answers: null, remember: false };

const bases: string[] = [];
afterEach(() => {
  for (const d of bases.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A pretend machine in a temporary folder: a home with projects, a Documents folder, credential and
 * application-data folders, HomeBase's own data, a notes vault and a system folder.
 */
function machine(over: { browseRoots?: string[]; projectDirs?: Array<{ label: string; cwd: string }>; addDirs?: string[]; appFolders?: boolean } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-folders-")));
  bases.push(base);
  const home = join(base, "home", "owner");
  const p = (...parts: string[]) => join(home, ...parts);
  for (const d of [
    p("git", "notetaker", ".git"), p("git", "notetaker", "src"), p("git", "site", ".git"), p("git", "notrepo"), p("docs"), p("Documents", "taxes"),
    p(".ssh"), p(".aws"), p(".claude"), p(".config", "gh"), p("AppData", "Roaming"), p("homebase-data", "claude-workspace"), p("homebase-data", "secrets"),
    p("apps", "homebase", "data"), p("apps", "homebase", "src"), p("vaults", "obsidian", "Daily Notes"), p("git", "node_modules"),
    join(base, "system", "config"), join(base, "elsewhere", "repo"),
  ]) mkdirSync(d, { recursive: true });
  writeFileSync(p("git", "notetaker", "README.md"), "# notetaker\n");
  writeFileSync(p("docs", "guide.md"), "guide\n");
  const data = p("homebase-data");
  const sandbox = join(data, "claude-workspace");
  const storePath = join(data, "approved-folders.json");
  const changes: number[] = [];
  const make = () => new FolderService({
    config: { sandboxDir: sandbox, projectDirs: over.projectDirs ?? [], addDirs: over.addDirs ?? [], browseRoots: over.browseRoots, appFolders: over.appFolders },
    storePath, home, host: "testbox", privatePaths: [data, p("apps", "homebase", "data"), join(data, "connector.json")],
    protectedRoots: () => [p("vaults", "obsidian")], systemDirs: [join(base, "system")], now: () => 1_795_000_000_000,
    onChange: () => void changes.push(1),
  });
  const service = make();
  const owner = { deviceId: "dev_owner", canApprove: true };
  return { base, home, p, data, sandbox, storePath, service, make, changes, owner, rules: service.rules };
}

// ---------------------------------------------------------------- dangerous paths

describe("dangerous-path blocking", () => {
  it("refuses the filesystem root, the home folder itself and anything above it", () => {
    const m = machine({ browseRoots: [parse(tmpdir()).root] }); // even when the whole drive may be browsed
    const rules = m.rules;
    expect(addBlock(parse(m.base).root, rules)).toMatch(/whole drive is too much/);
    expect(addBlock(m.home, rules)).toMatch(/whole home folder cannot be added/);
    expect(addBlock(dirname(m.home), rules)).toMatch(/contains your home folder/);
    expect(addBlock(m.base, rules)).toMatch(/contains your home folder/);
    // A project inside the home folder is fine.
    expect(addBlock(m.p("git", "notetaker"), rules)).toBeNull();
  });

  it("refuses credential folders and hidden or application-data folders in the home folder, and everything inside them", () => {
    const m = machine();
    for (const d of [m.p(".ssh"), m.p(".aws"), m.p(".claude"), m.p(".config"), m.p(".config", "gh"), m.p("AppData"), m.p("AppData", "Roaming")]) {
      expect(addBlock(d, m.rules), d).toMatch(/credential or settings folder|hidden or application-data folder/);
      expect(enterBlock(d, m.rules), d).not.toBeNull(); // the browser does not even go in
    }
    // A repository's own .git is not a folder to hand over either.
    expect(addBlock(m.p("git", "notetaker", ".git"), m.rules)).toMatch(/credential or settings folder/);
    // A credential folder is refused wherever it is, not only in the home folder.
    const deep = m.p("git", "site", ".aws");
    mkdirSync(deep);
    expect(addBlock(deep, m.rules)).toMatch(/credential or settings folder/);
    // So is a folder plainly named for what it holds, and anything inside it.
    for (const name of ["keystores", "Secrets", "credentials", "private-keys", "ssh_keys"]) {
      mkdirSync(m.p(name, "inner"), { recursive: true });
      expect(addBlock(m.p(name), m.rules), name).toMatch(/credential or settings folder/);
      expect(enterBlock(m.p(name, "inner"), m.rules), name).toMatch(/credential or settings folder/);
    }
    expect(m.service.list(undefined).entries.map((e) => e.name)).not.toContain("keystores");
  });

  it("refuses HomeBase's own data, anything inside it, and any folder that contains it", () => {
    const m = machine();
    expect(addBlock(m.data, m.rules)).toMatch(/HomeBase's own data/);
    expect(addBlock(join(m.data, "claude-workspace"), m.rules)).toMatch(/HomeBase's own data/);
    expect(enterBlock(join(m.data, "claude-workspace"), m.rules)).toMatch(/HomeBase's own data/);
    expect(enterBlock(join(m.data, "secrets"), m.rules)).not.toBeNull();
    // The HomeBase checkout holds a data folder: the checkout cannot be added, a folder next to its data can.
    expect(addBlock(m.p("apps", "homebase"), m.rules)).toMatch(/contains HomeBase's own data/);
    expect(addBlock(m.p("apps"), m.rules)).toMatch(/contains HomeBase's own data/);
    expect(addBlock(m.p("apps", "homebase", "src"), m.rules)).toBeNull();
    // ...but it can still be opened, to pick something inside.
    expect(enterBlock(m.p("apps", "homebase"), m.rules)).toBeNull();
  });

  it("refuses the notes vault and a folder that contains it, and system folders", () => {
    const m = machine({ browseRoots: [join(tmpdir()), parse(tmpdir()).root] });
    expect(addBlock(m.p("vaults", "obsidian"), m.rules)).toMatch(/notes vault/);
    expect(addBlock(m.p("vaults", "obsidian", "Daily Notes"), m.rules)).toMatch(/notes vault/);
    expect(addBlock(m.p("vaults"), m.rules)).toMatch(/contains the notes vault/);
    expect(addBlock(join(m.base, "system"), m.rules)).toBe("A system folder.");
    expect(addBlock(join(m.base, "system", "config"), m.rules)).toBe("A system folder.");
  });

  it("refuses everything outside the folders the connector lets the app browse", () => {
    const m = machine(); // browse roots: the home folder
    expect(addBlock(join(m.base, "elsewhere", "repo"), m.rules)).toMatch(/Outside the folders this connector lets the app browse/);
    // No roots given: the home folder is the one root.
    const none = machine({ browseRoots: [] });
    expect(none.rules.roots).toEqual([none.home]);
    // A connector whose config narrows browsing to ~/git: the docs folder next to it can no longer be added.
    const git = machine();
    const scoped = new FolderService({ config: { sandboxDir: git.sandbox, projectDirs: [], addDirs: [], browseRoots: [git.p("git")] }, storePath: git.storePath, home: git.home, privatePaths: [git.data] });
    expect(addBlock(git.p("git", "notetaker"), scoped.rules)).toBeNull();
    expect(addBlock(git.p("docs"), scoped.rules)).toMatch(/Outside the folders/);
  });

  it("lets a catch-all folder like Documents be added read-only at most, and warns about broad folders", () => {
    const m = machine();
    expect(addBlock(m.p("Documents"), m.rules)).toBeNull();
    expect(folderAdvice(m.p("Documents"), m.rules)).toMatchObject({ maxAccess: "read", warnings: [expect.stringContaining("read-only at most")] });
    expect(folderAdvice(m.p("Documents", "taxes"), m.rules)).toEqual({ maxAccess: "write", warnings: [] });
    const git = folderAdvice(m.p("git"), m.rules);
    expect(git.maxAccess).toBe("write");
    expect(git.warnings.join(" ")).toMatch(/directly in your home folder/);
    expect(git.warnings.join(" ")).toMatch(/holds 2 repositories/);
    expect(() => m.service.approve({ path: m.p("Documents"), access: "write" }, "dev_owner")).toThrow(/read-only at most/);
    expect(m.service.approve({ path: m.p("Documents"), access: "read" }, "dev_owner")).toMatchObject({ access: "read", source: "app" });
  });

  it("approve refuses every blocked folder, so none of them can reach the allowlist", () => {
    const m = machine();
    for (const d of [m.home, m.p(".ssh"), m.data, m.p("apps", "homebase"), m.p("vaults", "obsidian"), join(m.base, "elsewhere", "repo"), m.p("git", "notetaker", ".git"), m.p("no-such-folder"), m.p("git", "notetaker", "README.md")]) {
      expect(() => m.service.approve({ path: d, access: "read" }, "dev_owner"), d).toThrow(FolderError);
    }
    expect(existsSync(m.storePath)).toBe(false);
    expect(m.service.approved().map((f) => f.source)).toEqual(["sandbox"]);
    expect(m.changes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- the allowlist

describe("the approved-folders store", () => {
  it("approving writes the folder to its own file, atomically, and a restarted connector still has it", () => {
    const m = machine();
    const out = m.service.approve({ path: m.p("git", "notetaker"), access: "write" }, "dev_owner");
    expect(out).toEqual({ path: m.p("git", "notetaker"), label: "notetaker", access: "write", source: "app", addedAt: 1_795_000_000_000 });
    expect(m.changes).toHaveLength(1);
    const file = JSON.parse(readFileSync(m.storePath, "utf8"));
    expect(file).toMatchObject({ version: 1, folders: [{ path: m.p("git", "notetaker"), label: "notetaker", access: "write", addedBy: "dev_owner" }] });
    expect(readdirSync(m.data).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const again = m.make();
    expect(again.approved().map((f) => [f.label, f.access, f.source])).toEqual([["sandbox", "write", "sandbox"], ["notetaker", "write", "app"]]);
    expect(again.workspaces()).toEqual([{ label: "sandbox", cwd: m.sandbox }, { label: "notetaker", cwd: m.p("git", "notetaker") }]);
    expect(again.facts()).toMatchObject({ browse: true, host: "testbox", roots: [{ label: "Home", path: m.home }] });
  });

  it("an approval can be widened or narrowed, and forgotten; the config file's own folders cannot be forgotten from the app", () => {
    const cfg = machine();
    const svc = new FolderService({
      config: { sandboxDir: cfg.sandbox, projectDirs: [{ label: "site", cwd: cfg.p("git", "site") }], addDirs: [cfg.p("docs")] }, storePath: cfg.storePath, home: cfg.home, privatePaths: [cfg.data],
    });
    expect(svc.approved().map((f) => [f.label, f.access, f.source])).toEqual([["sandbox", "write", "sandbox"], ["site", "write", "config"], ["docs", "read", "config"]]);
    svc.approve({ path: cfg.p("git", "notetaker"), access: "read" }, null);
    expect(svc.approved().at(-1)).toMatchObject({ label: "notetaker", access: "read" });
    svc.approve({ path: cfg.p("git", "notetaker"), access: "write", label: "Notetaker app" }, null);
    expect(svc.approved().filter((f) => f.source === "app")).toEqual([expect.objectContaining({ label: "Notetaker app", access: "write" })]);
    // The config file is the owner's own, hand-edited word: the app neither widens nor removes what is in it.
    expect(() => svc.approve({ path: cfg.p("docs"), access: "write" }, null)).toThrow(/read-only in the connector's config file/);
    expect(() => svc.forget({ path: cfg.p("git", "site") })).toThrow(/config file/);
    expect(svc.forget({ path: cfg.p("git", "notetaker") })).toMatchObject({ label: "Notetaker app" });
    expect(svc.approved().some((f) => f.source === "app")).toBe(false);
    expect(() => svc.forget({ path: cfg.p("git", "notetaker") })).toThrow(/not on the approved list/);
  });

  it("only a device that may approve changes the list; any paired device may look", async () => {
    const m = machine();
    const guest = { deviceId: "dev_guest", canApprove: false };
    await expect(m.service.handle("approve", { path: m.p("git", "notetaker"), access: "write" }, guest)).rejects.toMatchObject({ code: "forbidden" });
    await expect(m.service.handle("forget", { path: m.p("git", "notetaker") }, guest)).rejects.toMatchObject({ code: "forbidden" });
    expect(existsSync(m.storePath)).toBe(false);
    expect(await m.service.handle("check", { path: m.p("git", "notetaker") }, guest)).toMatchObject({ ok: true, approved: null });
    await expect(m.service.handle("approve", { path: m.p("git", "notetaker"), access: "write" }, m.owner)).resolves.toMatchObject({ access: "write" });
    // With appFolders off in the config file, nothing can be browsed or approved from the app at all.
    const off = machine({ appFolders: false });
    await expect(off.service.handle("roots", {}, off.owner)).rejects.toMatchObject({ code: "disabled" });
    await expect(off.service.handle("approve", { path: off.p("git", "notetaker"), access: "write" }, off.owner)).rejects.toMatchObject({ code: "disabled" });
    expect(off.service.facts()).toMatchObject({ browse: false, roots: [] });
  });

  it("a damaged store file is treated as empty and kept aside, never trusted", () => {
    const m = machine();
    writeFileSync(m.storePath, "{ this is not json");
    expect(m.service.approved().map((f) => f.source)).toEqual(["sandbox"]);
    m.service.approve({ path: m.p("git", "site"), access: "write" }, null);
    expect(JSON.parse(readFileSync(m.storePath, "utf8")).folders).toHaveLength(1);
    expect(readdirSync(m.data).some((f) => f.startsWith("approved-folders.json.bad-"))).toBe(true);
    // Entries that are not full paths or have an unknown access are dropped on load.
    writeFileSync(m.storePath, JSON.stringify({ folders: [{ path: "relative/dir", access: "write" }, { path: m.p("docs"), access: "admin" }, { path: m.p("docs"), access: "read", label: "docs" }] }));
    expect(new FolderStore(m.storePath).load()).toEqual([{ path: m.p("docs"), label: "docs", access: "read", addedAt: 0, addedBy: null }]);
  });

  it("an approved folder that is later swapped for a link, or made unacceptable by hand, no longer counts", () => {
    const m = machine();
    m.service.approve({ path: m.p("git", "notrepo"), access: "write" }, null);
    expect(m.service.resolveCwd(m.p("git", "notrepo"))).toBe(m.p("git", "notrepo"));
    // The folder is replaced by a link to the credentials folder.
    rmSync(m.p("git", "notrepo"), { recursive: true });
    symlinkSync(m.p(".ssh"), m.p("git", "notrepo"), process.platform === "win32" ? "junction" : "dir");
    expect(m.service.resolveCwd(m.p("git", "notrepo"))).toBeNull();
    expect(m.service.approved().some((f) => f.source === "app")).toBe(false);
    // Someone writes a dangerous folder straight into the store file: it is still refused when the list is read.
    writeFileSync(m.storePath, JSON.stringify({ folders: [{ path: m.home, access: "write", label: "home" }, { path: m.p(".aws"), access: "read", label: "aws" }, { path: m.data, access: "write", label: "data" }] }));
    expect(m.service.approved().map((f) => f.source)).toEqual(["sandbox"]);
    expect(m.service.resolveCwd(m.home)).toBeNull();
    // A folder that is approved but not on disk right now is listed as missing and cannot be used.
    writeFileSync(m.storePath, JSON.stringify({ folders: [{ path: m.p("git", "gone"), access: "write", label: "gone" }] }));
    expect(m.service.approved().at(-1)).toMatchObject({ label: "gone", missing: true });
    expect(m.service.resolveCwd(m.p("git", "gone"))).toBeNull();
    expect(m.service.workspaces()).toHaveLength(1);
  });
});

describe("allowlist enforcement for a run", () => {
  it("a working directory must be an approved read & write folder: nothing else, no subfolder, no read-only folder", () => {
    const m = machine();
    m.service.approve({ path: m.p("git", "notetaker"), access: "write" }, null);
    m.service.approve({ path: m.p("docs"), access: "read" }, null);
    expect(m.service.resolveCwd(null)).toBe(m.sandbox);
    expect(m.service.resolveCwd(m.p("git", "notetaker"))).toBe(m.p("git", "notetaker"));
    expect(m.service.resolveCwd(m.p("git", "notetaker") + "/")).toBe(m.p("git", "notetaker"));
    for (const d of [m.p("git", "site"), m.p("git", "notetaker", "src"), m.p("git"), m.home, m.p("docs"), m.p(".ssh"), m.data, join(m.p("git", "notetaker"), "..", "site"), "relative/path", parse(m.base).root]) {
      expect(m.service.resolveCwd(d), d).toBeNull();
    }
  });

  it("extra folders are added only as far as they are approved here, whatever the hub asked for", () => {
    const m = machine({ addDirs: [] });
    m.service.approve({ path: m.p("git", "notetaker"), access: "write" }, null);
    m.service.approve({ path: m.p("git", "site"), access: "write" }, null);
    m.service.approve({ path: m.p("docs"), access: "read" }, null);
    const r = m.service.resolveExtras([
      { path: m.p("git", "site"), access: "write" }, { path: m.p("docs"), access: "write" }, { path: m.p(".ssh"), access: "read" },
      { path: m.home, access: "write" }, { path: m.p("git", "notetaker"), access: "read" }, { path: "not/absolute", access: "read" },
    ], m.p("git", "notetaker"));
    expect(r.write).toEqual([m.p("git", "site")]);
    expect(r.read).toEqual([m.p("docs")]); // asked for read & write, approved read-only: read-only it is
    expect(r.notes).toEqual([
      "docs is approved read-only on this connector, so it was added read-only.",
      `Not added: ${m.p(".ssh")} is not approved on this connector (testbox).`,
      `Not added: ${m.home} is not approved on this connector (testbox).`,
      "Not added: not/absolute is not a full path.",
    ]);
    expect(m.service.resolveExtras(undefined, m.sandbox)).toEqual({ read: [], write: [], notes: [] });
    expect(m.service.resolveExtras("garbage", m.sandbox).notes).toHaveLength(1);
  });

  it("the config file's addDirs are still added to every run, read-only", () => {
    const base = machine();
    const svc = new FolderService({ config: { sandboxDir: base.sandbox, projectDirs: [], addDirs: [base.p("docs")] }, storePath: base.storePath, home: base.home, privatePaths: [base.data] });
    expect(svc.resolveExtras(undefined, base.sandbox)).toEqual({ read: [base.p("docs")], write: [], notes: [] });
  });

  it("the adapter never starts a process in a folder this connector has not approved", async () => {
    const m = machine();
    const fake = fakeClaude(() => listFiles[0]);
    const approvals = new ApprovalServer();
    try {
      const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: m.sandbox }), approvals, spawnFn: fake.spawn, env: {}, folders: m.service });
      for (const cwd of [m.p("git", "notetaker"), m.home, m.p(".ssh"), m.data]) {
        const h = harness({ cwd });
        await adapter.start(h.ctx).done;
        expect(h.statuses.at(-1)).toMatchObject({ status: "failed" });
        expect(h.statuses.at(-1)!.extra.error).toMatch(/not one of this connector's allowed working directories\. Approve the folder/);
      }
      expect(fake.calls).toHaveLength(0);

      // Once the owner has approved it, the run starts there, with the extra folders that are approved and no others.
      m.service.approve({ path: m.p("git", "notetaker"), access: "write" }, null);
      m.service.approve({ path: m.p("docs"), access: "read" }, null);
      m.service.approve({ path: m.p("git", "site"), access: "write" }, null);
      const h = harness({ cwd: m.p("git", "notetaker"), options: { folders: [{ path: m.p("docs"), access: "read" }, { path: m.p("git", "site"), access: "write" }, { path: m.p(".aws"), access: "read" }] } });
      await adapter.start(h.ctx).done;
      expect(h.statuses.at(-1)).toMatchObject({ status: "succeeded" });
      const call = fake.calls[0];
      expect(call.options.cwd).toBe(m.p("git", "notetaker"));
      const at = call.args.indexOf("--add-dir");
      expect(call.args.slice(at + 1, at + 3)).toEqual([m.p("docs"), m.p("git", "site")]);
      expect(call.args).not.toContain(m.p(".aws"));
      // The read-only folder also gets a deny rule for edits inside the CLI; the read & write one does not.
      const deny = call.args.slice(call.args.indexOf("--disallowedTools") + 1, call.args.indexOf("--append-system-prompt"));
      expect(deny).toContain(editDenyRule(m.p("docs")));
      expect(deny).not.toContain(editDenyRule(m.p("git", "site")));
      const notes = h.events.filter((e) => e.kind === "system").map((e) => e.data.message as string);
      expect(notes).toContain(`Not added: ${m.p(".aws")} is not approved on this connector (testbox).`);
      expect(notes).toContain("Extra folders: site (read & write), docs (read-only)");
      expect(h.events.find((e) => e.kind === "system" && e.data.sessionId)!.data.folders).toEqual([{ path: m.p("docs"), access: "read" }, { path: m.p("git", "site"), access: "write" }]);
    } finally {
      await approvals.stop();
    }
  });

  it("without a folder service an agent runs exactly as before: the config's own directories and nothing from the hub", () => {
    const cfg = testConfig({ addDirs: ["/srv/docs"] });
    const args = buildArgs(cfg, { resume: null, mcpConfig: "{}" });
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/srv/docs");
    expect(args.some((a) => a.startsWith("Edit("))).toBe(false);
    expect(buildArgs(testConfig(), { resume: null, mcpConfig: "{}" })).not.toContain("--add-dir");
    const withRun = buildArgs(cfg, { resume: null, mcpConfig: "{}", addDirs: ["/a", "/b"], readOnlyDirs: ["/a"] });
    expect(withRun.slice(withRun.indexOf("--add-dir") + 1, withRun.indexOf("--add-dir") + 3)).toEqual(["/a", "/b"]);
  });

  it("writes Claude Code deny patterns for Windows and POSIX folders", () => {
    if (process.platform === "win32") expect(editDenyRule("C:\\Users\\Me\\git\\docs")).toBe("Edit(//c/Users/Me/git/docs/**)");
    else expect(editDenyRule("/home/o/docs/")).toBe("Edit(//home/o/docs/**)");
  });

  it("reads the browse roots from the config file and the environment", () => {
    const m = machine();
    const file = join(m.base, "claude-agent.json");
    writeFileSync(file, JSON.stringify({ sandboxDir: m.sandbox, browseRoots: [m.p("git"), m.p("no-such")], appFolders: false }));
    expect(loadClaudeConfig(file, {})).toMatchObject({ browseRoots: [m.p("git")], appFolders: false });
    expect(loadClaudeConfig(file, { HB_BROWSE_ROOTS: m.p("docs"), HB_APP_FOLDERS: "0" })).toMatchObject({ browseRoots: [m.p("docs")], appFolders: false });
    writeFileSync(file, JSON.stringify({ sandboxDir: m.sandbox }));
    const def = loadClaudeConfig(file, {});
    expect(def.appFolders).toBe(true);
    expect(def.browseRoots).toHaveLength(1); // the account's home folder
  });
});

// ---------------------------------------------------------------- read-only, as it is really enforced

describe("read-only and read & write folders at the permission prompt", () => {
  const cwd = join(tmpdir(), "hb-ws");
  const ro = join(tmpdir(), "hb-ro");
  const rw = join(tmpdir(), "hb-rw");
  const env = (mode: PermissionEnv["mode"], profile: PermissionEnv["profile"] = "strict"): PermissionEnv => ({ cwd, profile, mode, readRoots: [ro], writeRoots: [rw] });
  const shell = (command: string) => classifyShellAuto(command, { cwd, roots: [rw], readRoots: [ro] });

  it("file tools read in every folder that was added", () => {
    for (const mode of ["manual", "auto", "plan"] as const) {
      expect(decidePermission("Read", { file_path: join(ro, "a.md") }, env(mode)).tier).toBe("auto");
      expect(decidePermission("Read", { file_path: join(rw, "a.md") }, env(mode)).tier).toBe("auto");
      expect(decidePermission("Read", { file_path: join(tmpdir(), "hb-other", "a.md") }, env(mode))).toMatchObject({ tier: "ask", risk: "medium" });
    }
  });

  it("file tools never edit in a read-only folder: denied in every mode and profile, not asked", () => {
    for (const mode of ["manual", "auto", "plan"] as const) {
      for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
        for (const profile of ["strict", "standard"] as const) {
          expect(decidePermission(tool, { file_path: join(ro, "sub", "a.md") }, env(mode, profile)), `${mode} ${tool} ${profile}`).toEqual({ tier: "deny", reason: "Hard deny: this folder was added read-only" });
        }
      }
    }
  });

  it("a read & write folder is part of the workspace: Manual asks, Auto edits, Plan stays read-only", () => {
    expect(decidePermission("Write", { file_path: join(rw, "a.md") }, env("manual"))).toMatchObject({ tier: "ask", risk: "low" });
    expect(decidePermission("Write", { file_path: join(rw, "a.md") }, env("manual", "standard")).tier).toBe("auto");
    expect(decidePermission("Edit", { file_path: join(rw, "a.md") }, env("auto"))).toEqual({ tier: "auto", reason: "File edit inside the workspace (auto mode)" });
    expect(decidePermission("Write", { file_path: join(rw, "a.md") }, env("plan")).tier).toBe("deny");
    // Agent and repository configuration asks at high risk there too, and secrets stay off limits.
    expect(decidePermission("Write", { file_path: join(rw, ".claude", "settings.json") }, env("auto"))).toMatchObject({ tier: "ask", risk: "high" });
    expect(decidePermission("Write", { file_path: join(rw, ".env") }, env("auto")).tier).toBe("deny");
    expect(decidePermission("Read", { file_path: join(ro, ".env") }, env("auto")).tier).toBe("deny");
  });

  it("a read-only folder inside the working directory stays read-only", () => {
    const nested: PermissionEnv = { cwd, profile: "strict", mode: "auto", readRoots: [join(cwd, "vendor")] };
    expect(decidePermission("Write", { file_path: join(cwd, "vendor", "x.js") }, nested).tier).toBe("deny");
    expect(decidePermission("Write", { file_path: join(cwd, "src", "x.js") }, nested).tier).toBe("auto");
    expect(classifyShellAuto(`rm ${join(cwd, "vendor", "x.js").replace(/\\/g, "/")}`, { cwd, readRoots: [join(cwd, "vendor")] })).toMatchObject({ tier: "ask", risk: "high" });
  });

  it("in Auto, plain read commands pass in a read-only folder and anything that could change it asks, in the app", () => {
    const r = ro.replace(/\\/g, "/");
    const w = rw.replace(/\\/g, "/");
    for (const c of [`ls ${r}`, `cat ${r}/a.md`, `grep -rn TODO ${r}`, `find ${r} -name "*.md"`, `git status && wc -l ${r}/a.md`, `cp ${r}/template.md notes.md`, `diff ${r}/a.md a.md`]) {
      expect(shell(c), c).toEqual({ tier: "auto", reason: "Workspace command (auto mode)" });
    }
    for (const c of [`rm ${r}/a.md`, `touch ${r}/new.md`, `mv ${r}/a.md ${r}/b.md`, `sed -i s/a/b/ ${r}/a.md`, `cp notes.md ${r}/notes.md`, `echo hi > ${r}/a.md`, `cat a.md >> ${r}/log.txt`, `mkdir ${r}/new`, `node build.js ${r}`]) {
      expect(shell(c), c).toMatchObject({ tier: "ask", risk: "high", reason: "Auto mode still asks: could change a folder that was added read-only" });
    }
    // The read & write folder behaves like the working directory.
    for (const c of [`touch ${w}/new.md`, `rm ${w}/a.md`, `echo hi > ${w}/a.md`, `cp ${r}/a.md ${w}/a.md`]) expect(shell(c), c).toMatchObject({ tier: "auto" });
    // In Manual every command asks anyway, whatever it touches.
    expect(decidePermission("Bash", { command: `ls ${r}` }, env("manual"))).toMatchObject({ tier: "ask", risk: "medium" });
    expect(decidePermission("Bash", { command: `rm ${r}/a.md` }, env("auto"))).toMatchObject({ tier: "ask", risk: "high" });
  });

  it("knows which words of a command are written by a redirection", () => {
    expect(splitCommand("cat a > out.txt 2>&1 | tee -a log.txt; sort < in.txt >> sorted.txt").map((s) => s.outputs ?? [])).toEqual([["out.txt"], [], ["sorted.txt"]]);
    expect(splitCommand("echo hi 2> err.log").at(0)!.outputs).toEqual(["err.log"]);
    expect(splitCommand("ls -la").at(0)!.outputs).toBeUndefined();
  });

  it("the approval tool turns a read-only edit away without asking the owner", async () => {
    const m = machine();
    m.service.approve({ path: m.p("docs"), access: "read" }, null);
    let asked = 0;
    const fake = fakeClaude(async (call) => {
      const res = await askApprovalTool(call.arg("--mcp-config")!, { tool_name: "Write", input: { file_path: join(m.p("docs"), "new.md"), content: "x" } });
      if (res.behavior !== "deny" || !/added read-only/.test(res.message)) throw new Error(`expected a read-only denial, got ${JSON.stringify(res)}`);
      return listFiles[0];
    });
    const approvals = new ApprovalServer();
    try {
      const adapter = createClaudeCodeAdapter({ config: testConfig({ sandboxDir: m.sandbox, modes: ["manual", "auto"] }), approvals, spawnFn: fake.spawn, env: {}, folders: m.service });
      const h = harness({ options: { mode: "auto", folders: [{ path: m.p("docs"), access: "read" }] }, onAsk: () => void asked++ });
      await adapter.start(h.ctx).done;
      expect(h.statuses.at(-1)).toMatchObject({ status: "succeeded" });
      expect(asked).toBe(0);
      expect(h.events.find((e) => e.data.decision === "blocked")!.data).toMatchObject({ tool: "Write", reason: "Hard deny: this folder was added read-only" });
      expect(existsSync(join(m.p("docs"), "new.md"))).toBe(false);
    } finally {
      await approvals.stop();
    }
  });
});

// ---------------------------------------------------------------- the browser

describe("the folder browser", () => {
  it("lists folder names under a browse root, marks repositories and approved folders, and hides what is off limits", () => {
    const m = machine();
    m.service.approve({ path: m.p("git", "notetaker"), access: "write" }, null);
    const top = m.service.list(undefined);
    expect(top.self).toMatchObject({ path: m.home, ok: false, reason: expect.stringContaining("whole home folder") });
    expect(top.parent).toBeNull();
    expect(top.crumbs).toEqual([{ label: "Home", path: m.home }]);
    // .ssh, .aws, .claude, .config, AppData, the data folder and the vault are not listed at all.
    expect(top.entries.map((e) => e.name)).toEqual(["apps", "docs", "Documents", "git", "vaults"]);
    expect(top.hidden).toBe(6);
    expect(top.entries.find((e) => e.name === "apps")).toMatchObject({ blocked: expect.stringContaining("contains HomeBase's own data"), canOpen: true });
    expect(top.entries.find((e) => e.name === "vaults")).toMatchObject({ blocked: expect.stringContaining("contains the notes vault") });
    expect(top.entries.find((e) => e.name === "docs")).toMatchObject({ blocked: null, approved: null, git: false });

    const git = m.service.list(m.p("git"));
    expect(git.parent).toBe(m.home);
    expect(git.crumbs.map((c) => c.label)).toEqual(["Home", "git"]);
    expect(git.entries.map((e) => [e.name, e.git, e.approved])).toEqual([["notetaker", true, "write"], ["notrepo", false, null], ["site", true, null]]);
    expect(git.hidden).toBe(1); // node_modules
    // Files are never listed: only folders.
    expect(m.service.list(m.p("git", "notetaker")).entries.map((e) => e.name)).toEqual(["src"]);
  });

  it("does not go into credential folders, HomeBase's data, the vault, or anywhere outside its roots", () => {
    const m = machine();
    for (const d of [m.p(".ssh"), m.p("AppData"), m.data, m.p("vaults", "obsidian"), join(m.base, "elsewhere"), dirname(m.home), parse(m.base).root]) {
      expect(() => m.service.list(d), d).toThrow(FolderError);
    }
    expect(() => m.service.list(m.p("nope"))).toThrow(/no such folder/);
    expect(() => m.service.list("relative")).toThrow(/full path/);
  });

  it("checks a typed path: what it resolves to, whether it can be added, and for what", () => {
    const m = machine();
    expect(m.service.check(m.p("git", "notetaker"))).toEqual({
      path: m.p("git", "notetaker"), label: "notetaker", ok: true, reason: null, approved: null, source: null, maxAccess: "write", warnings: [], git: true,
    });
    expect(m.service.check(m.p("git", "notetaker", "..", "site"))).toMatchObject({ path: m.p("git", "site"), ok: true });
    expect(m.service.check(m.p("git", "notetaker", "README.md"))).toMatchObject({ ok: false, reason: "That is a file, not a folder." });
    expect(m.service.check(m.p("ghost"))).toMatchObject({ ok: false, reason: "There is no such folder on testbox." });
    expect(m.service.check(m.p(".ssh"))).toMatchObject({ ok: false });
    expect(m.service.check(m.sandbox)).toMatchObject({ ok: true, approved: "write", source: "sandbox" });
    expect(() => m.service.check("")).toThrow(/full path/);
    expect(() => m.service.check("git/notetaker")).toThrow(/full path/);
    // A link is judged by where it leads.
    symlinkSync(m.p(".aws"), m.p("git", "innocent"), process.platform === "win32" ? "junction" : "dir");
    expect(m.service.check(m.p("git", "innocent"))).toMatchObject({ ok: false, reason: expect.stringContaining("credential") });
    expect(m.service.list(m.p("git")).entries.map((e) => e.name)).not.toContain("innocent");
    renameSync(m.p("git", "innocent"), m.p("git", "innocent2"));
  });
});

// ---------------------------------------------------------------- through the hub

function harness(over: { cwd?: string | null; options?: Record<string, unknown>; onAsk?: () => void } = {}) {
  const events: Array<{ kind: RunEventKind; data: any }> = [];
  const statuses: Array<{ status: string; extra: any }> = [];
  const ctx: RunContext = {
    run: { id: "run_test", agentKey: "claude", threadId: null, prompt: "List the files", cwd: over.cwd ?? null, resumeSessionRef: null, options: over.options },
    signal: new AbortController().signal,
    emit: (kind, data) => void events.push({ kind, data }),
    status: (status, extra) => void statuses.push({ status, extra: extra ?? {} }),
    requestApproval: async () => {
      over.onAsk?.();
      return approve;
    },
  };
  return { ctx, events, statuses };
}

describe("folders through the hub: browse, approve, give a project a folder, run", () => {
  let app: HubApp | null = null;
  let link: HubLink | null = null;
  const clients: Array<{ client: { stop(): void } }> = [];
  const servers: ApprovalServer[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.client.stop();
    link?.stop();
    link = null;
    for (const s of servers.splice(0)) await s.stop();
    await app?.close();
    app = null;
  });

  it("the owner picks a folder on the connector's machine from the app, and every new session in the project gets it", async () => {
    const m = machine();
    const cfg = testConfig({ sandboxDir: m.sandbox });
    const fake = fakeClaude(() => listFiles[0]);
    const approvals = new ApprovalServer();
    servers.push(approvals);
    app = await bootHub();
    const { token } = pairToken(app, "connector", "claude-connector");
    const service = new FolderService({
      config: { sandboxDir: m.sandbox, projectDirs: [], addDirs: [] }, storePath: m.storePath, home: m.home, host: "testbox", privatePaths: [m.data],
      onChange: () => link!.updateAgent(cfg.key, { workspaces: service.workspaces(), folders: service.facts() }),
    });
    link = new HubLink({
      hubUrl: app.url, token, name: "claude-connector", log: () => {},
      agents: [{
        key: cfg.key, name: cfg.name, kind: "claude", description: "", capabilities: [], workspaces: service.workspaces(), folders: service.facts(),
        permissionProfile: cfg.permissionProfile, modes: cfg.modes, models: ["claude-sonnet-5-5"], model: "claude-sonnet-5-5",
        adapter: createClaudeCodeAdapter({ config: cfg, approvals, spawnFn: fake.spawn, env: {}, folders: service }),
      }],
      onFoldersRequest: (key, op, args, meta) => (key === cfg.key ? service.handle(op, args, meta) : Promise.reject(new Error("no"))),
    });
    link.start();
    await link.whenReady();
    const phone = await connectDevice(app, "Phone");
    const desktop = await connectDevice(app, "Desktop");
    clients.push(phone, desktop);
    const agentOn = (who: typeof phone) => (who.list("agents") as Agent[]).find((a) => a.key === "claude" && a.status === "online");
    const agent = (await waitFor(() => agentOn(phone), "claude agent online")) as Agent;
    expect(agent.folders).toMatchObject({ browse: true, host: "testbox", approved: [{ label: "sandbox", source: "sandbox" }] });

    // Browse from the phone: the home folder, then git.
    const top = await phone.client.folders<FolderListing>(agent.id, "list", {});
    expect(top.entries.map((e) => e.name)).toContain("git");
    const git = await phone.client.folders<FolderListing>(agent.id, "list", { path: top.entries.find((e) => e.name === "git")!.path });
    const pick = git.entries.find((e) => e.name === "notetaker")!;
    expect(pick).toMatchObject({ git: true, approved: null, blocked: null });
    // A dangerous folder is refused by the connector, with its reason, and nothing changes.
    await expect(phone.client.folders(agent.id, "approve", { path: m.home, access: "write" })).rejects.toMatchObject({ code: "blocked", message: expect.stringContaining("whole home folder") });
    await expect(phone.client.folders(agent.id, "list", { path: m.p(".ssh") })).rejects.toMatchObject({ code: "blocked" });
    // Not approved yet: the hub will not take it for a project, and the connector would not run in it.
    const projectId = newId("prj");
    await phone.client.mutate("project.create", { projectId, name: "Notetaker", defaultAgentId: agent.id });
    expect((await phone.client.mutate("folders.set", { scope: "project", id: projectId, cwd: pick.path })).ok).toBe(false);

    // The owner approves it (read & write) and a docs folder (read-only): both devices see them at once.
    const approved = await phone.client.folders<ApprovedFolder>(agent.id, "approve", { path: pick.path, access: "write" });
    expect(approved).toMatchObject({ path: m.p("git", "notetaker"), label: "notetaker", access: "write", source: "app" });
    await phone.client.folders(agent.id, "approve", { path: m.p("docs"), access: "read" });
    await waitFor(() => agentOn(desktop)?.folders?.approved.length === 3, "the approved folders on the desktop");
    expect(agentOn(desktop)!.workspaces.map((w) => w.label)).toEqual(["sandbox", "notetaker"]);
    expect(JSON.parse(readFileSync(m.storePath, "utf8")).folders.map((f: any) => [f.label, f.access])).toEqual([["notetaker", "write"], ["docs", "read"]]);
    const audit = app.store.all<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'folder.approve' ORDER BY at, id").map((a) => JSON.parse(a.detail));
    expect(audit.map((a) => [a.path, a.access])).toEqual([[m.p("git", "notetaker"), "write"], [m.p("docs"), "read"]]);

    // The project gets them: a primary folder and an extra read-only one.
    expect((await desktop.client.mutate("folders.set", { scope: "project", id: projectId, cwd: pick.path, folders: [{ path: m.p("docs"), access: "read" }] })).ok).toBe(true);
    await waitFor(() => (phone.list("projects") as Project[]).find((p) => p.id === projectId)?.folders?.length === 1, "the project's folders on the phone");

    // A new session in the project: its agent starts in the project's folder with the docs next to it.
    const threadId = newId("thr");
    await phone.client.mutate("thread.create", { threadId, title: "New session with Claude agent", agentId: agent.id, projectId });
    await phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text: "List the files", source: "text" });
    const run = (await waitFor(() => (phone.list("runs") as Run[]).find((r) => r.threadId === threadId && r.status === "succeeded"), "run done")) as Run;
    expect(run).toMatchObject({ cwd: m.p("git", "notetaker"), folders: [{ path: m.p("docs"), access: "read" }] });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].options.cwd).toBe(m.p("git", "notetaker"));
    expect(fake.calls[0].arg("--add-dir")).toBe(m.p("docs"));
    expect((phone.list("threads") as Thread[]).find((t) => t.id === threadId)!.cwd).toBe(m.p("git", "notetaker"));

    // The owner forgets the project folder on the connector. The session's next message is refused there, in words,
    // and no process is started anywhere else.
    await phone.client.folders(agent.id, "forget", { path: m.p("git", "notetaker") });
    await waitFor(() => agentOn(phone)?.folders?.approved.length === 2, "the folder gone from the list");
    await phone.client.mutate("message.send", { threadId, messageId: newId("msg"), text: "again", source: "text" });
    const failed = (await waitFor(() => (phone.list("runs") as Run[]).find((r) => r.threadId === threadId && r.status === "failed"), "the refused run")) as Run;
    expect(failed.error).toMatch(/not one of this connector's allowed working directories/);
    expect(fake.calls).toHaveLength(1);
    const said = (phone.list("messages") as Message[]).filter((x) => x.threadId === threadId && x.role === "system").map((x) => x.text);
    expect(said.at(-1)).toMatch(/Run failed: .*not one of this connector's allowed working directories/);
  });
});
