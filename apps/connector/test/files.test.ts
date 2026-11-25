import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectIndent, languageFor } from "@homebase/protocol";
import { FileService, filesEnabled, secretReason, type FileError } from "../src/files";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(over: Partial<ConstructorParameters<typeof FileService>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), "hb-files-"));
  dirs.push(home);
  const vault = join(home, "vault");
  mkdirSync(join(vault, "daily"), { recursive: true });
  writeFileSync(join(vault, "daily", "note.md"), "# A note\n");
  mkdirSync(join(home, "proj"));
  writeFileSync(join(home, "proj", "app.py"), "print('hi')\n");
  writeFileSync(join(home, ".hidden"), "x");
  const svc = new FileService({ home, host: "my-server", enabled: true, root: false, protectedRoots: () => [vault], ...over });
  return { home, vault, svc };
}

async function fails(p: Promise<unknown>): Promise<FileError> {
  try {
    await p;
  } catch (e) {
    return e as FileError;
  }
  throw new Error("expected a refusal");
}

describe("the file service: paths", () => {
  it("takes full paths and ~, and refuses relative paths and control characters", async () => {
    const { svc, home } = setup();
    expect(svc.path("~")).toBe(home);
    expect(svc.path("~/proj")).toBe(join(home, "proj"));
    expect(svc.path(join(home, "proj", "..", "proj"))).toBe(join(home, "proj"));
    expect((await fails(svc.handle("list", { path: "proj" }))).code).toBe("invalid");
    expect((await fails(svc.handle("read", { path: `${home}/a\u0000b` }))).code).toBe("invalid");
    expect((await fails(svc.handle("read", { path: 42 }))).code).toBe("invalid");
  });

  it("lists folders first, hides dotfiles unless asked, and gives breadcrumbs from ~ inside home", async () => {
    const { svc, home } = setup();
    const l = (await svc.handle("list", { path: home })) as any;
    expect(l.entries.map((e: any) => e.name)).toEqual(["proj", "vault"]);
    expect(l.crumbs).toEqual([{ label: "~", path: home }]);
    expect(((await svc.handle("list", { path: join(home, "proj") })) as any).crumbs).toEqual([{ label: "~", path: home }, { label: "proj", path: join(home, "proj") }]);
    expect(l.parent).toBeTruthy();
    const all = (await svc.handle("list", { path: home, hidden: true })) as any;
    expect(all.entries.map((e: any) => e.name)).toContain(".hidden");
    expect((await svc.handle("list", { path: join(home, "vault") }) as any).readOnly).toBe(true);
    expect((await fails(svc.handle("list", { path: join(home, "nope") }))).code).toBe("not_found");
  });

  it("offers home, the agents' workspaces and the vault (read-only) as quick jumps", async () => {
    const { home, vault } = setup();
    const svc = new FileService({ home, enabled: true, root: false, protectedRoots: () => [vault], workspaces: () => [{ label: "proj", path: join(home, "proj") }] });
    const r = (await svc.handle("roots", {})) as any;
    expect(r.home).toBe(home);
    expect(r.jumps.slice(0, 3)).toEqual([
      { label: "Home", path: home, kind: "home" }, { label: "proj", path: join(home, "proj"), kind: "workspace" }, { label: "Notes vault (read-only)", path: expect.stringContaining("vault"), kind: "vault" },
    ]);
    expect(r.readOnly).toEqual([expect.stringContaining("vault")]);
    expect(r.files).toBe(true);
  });
});

describe("the file service: reading and saving", () => {
  it("reads text with its hash, line endings and byte-order mark, and marks binary files", async () => {
    const { svc, home } = setup();
    writeFileSync(join(home, "crlf.txt"), "\ufeffa\r\nb\r\n");
    const r = (await svc.handle("read", { path: join(home, "crlf.txt") })) as any;
    expect(r).toMatchObject({ content: "a\r\nb\r\n", eol: "\r\n", bom: true, binary: false, readOnly: false });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(home, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    expect(await svc.handle("read", { path: join(home, "bin.dat") })).toMatchObject({ binary: true, content: null });
    writeFileSync(join(home, "big.log"), "x".repeat(500 * 1024));
    expect(await svc.handle("read", { path: join(home, "big.log") })).toMatchObject({ tooLarge: true, content: null, binary: false });
  });

  it("saves when the file is still the version that was opened", async () => {
    const { svc, home } = setup();
    const p = join(home, "proj", "app.py");
    const r = (await svc.handle("read", { path: p })) as any;
    const w = (await svc.handle("write", { path: p, content: "print('bye')\n", baseHash: r.hash })) as any;
    expect(readFileSync(p, "utf8")).toBe("print('bye')\n");
    expect(w.hash).not.toBe(r.hash);
    expect(w.size).toBe(13);
    // Keeps a byte-order mark the file had.
    await svc.handle("write", { path: p, content: "x", baseHash: w.hash, bom: true });
    expect(readFileSync(p)[0]).toBe(0xef);
  });

  it("refuses to overwrite a file that changed on disk since it was opened, unless told to", async () => {
    const { svc, home } = setup();
    const p = join(home, "proj", "app.py");
    const r = (await svc.handle("read", { path: p })) as any;
    writeFileSync(p, "print('an agent was here')\n");
    const e = await fails(svc.handle("write", { path: p, content: "mine\n", baseHash: r.hash }));
    expect(e.code).toBe("conflict");
    expect(readFileSync(p, "utf8")).toBe("print('an agent was here')\n");
    await svc.handle("write", { path: p, content: "mine\n", baseHash: r.hash, force: true });
    expect(readFileSync(p, "utf8")).toBe("mine\n");
    // A new file (no base) must not exist yet; a deleted one is a conflict too.
    expect((await fails(svc.handle("write", { path: p, content: "new", baseHash: null }))).code).toBe("conflict");
    rmSync(p);
    expect((await fails(svc.handle("write", { path: p, content: "again", baseHash: r.hash }))).code).toBe("conflict");
    await svc.handle("write", { path: p, content: "fresh", baseHash: null });
    expect(readFileSync(p, "utf8")).toBe("fresh");
  });

  it("stat gives the hash the editor compares with", async () => {
    const { svc, home } = setup();
    const p = join(home, "proj", "app.py");
    const r = (await svc.handle("read", { path: p })) as any;
    expect(await svc.handle("stat", { path: p })).toMatchObject({ exists: true, kind: "file", hash: r.hash });
    expect(await svc.handle("stat", { path: join(home, "gone") })).toMatchObject({ exists: false, hash: null });
  });

  it("asks before opening a file that looks like a secret", async () => {
    const { svc, home } = setup();
    writeFileSync(join(home, ".env"), "TOKEN=abc");
    const e = await fails(svc.handle("read", { path: join(home, ".env") }));
    expect(e.code).toBe("secret");
    expect(await svc.handle("read", { path: join(home, ".env"), confirm: true })).toMatchObject({ content: "TOKEN=abc", secret: expect.any(String) });
    expect(secretReason("/home/me/.ssh/config")).toMatch(/\.ssh/);
    expect(secretReason("/home/me/.aws/credentials")).toBeTruthy();
    expect(secretReason("/home/me/keys/server.pem")).toBeTruthy();
    expect(secretReason("/home/me/app/.env.production")).toBeTruthy();
    expect(secretReason("/home/me/app/.env.example")).toBeNull();
    expect(secretReason("/home/me/app/src/index.ts")).toBeNull();
  });
});

describe("the file service: create, rename, delete", () => {
  it("creates files and folders, renames and deletes", async () => {
    const { svc, home } = setup();
    await svc.handle("create", { path: join(home, "proj", "lib"), kind: "dir" });
    await svc.handle("create", { path: join(home, "proj", "lib", "a.ts") });
    expect((await fails(svc.handle("create", { path: join(home, "proj", "lib", "a.ts") }))).code).toBe("exists");
    expect(await svc.handle("rename", { from: join(home, "proj", "lib", "a.ts"), to: join(home, "proj", "lib", "b.ts") })).toMatchObject({ from: expect.any(String), to: join(home, "proj", "lib", "b.ts") });
    expect((await fails(svc.handle("rename", { from: join(home, "proj"), to: join(home, "proj", "lib", "inner") }))).code).toBe("invalid");
    await svc.handle("delete", { path: join(home, "proj", "lib") });
    expect(existsSync(join(home, "proj", "lib"))).toBe(false);
    expect((await fails(svc.handle("delete", { path: join(home, "proj", "lib") }))).code).toBe("not_found");
  });

  it("keeps the notes vault read-only: no write, create, rename, move or delete in it or of a folder holding it", async () => {
    const { svc, home, vault } = setup();
    const note = join(vault, "daily", "note.md");
    const r = (await svc.handle("read", { path: note })) as any;
    expect(r.readOnly).toBe(true);
    expect((await fails(svc.handle("write", { path: note, content: "x", baseHash: r.hash }))).code).toBe("read_only");
    expect((await fails(svc.handle("create", { path: join(vault, "new.md") }))).code).toBe("read_only");
    expect((await fails(svc.handle("rename", { from: note, to: join(home, "stolen.md") }))).code).toBe("read_only");
    expect((await fails(svc.handle("rename", { from: join(home, "proj", "app.py"), to: join(vault, "app.py") }))).code).toBe("read_only");
    expect((await fails(svc.handle("delete", { path: note }))).code).toBe("read_only");
    expect((await fails(svc.handle("delete", { path: home }))).code).toBe("read_only");
    expect(readFileSync(note, "utf8")).toBe("# A note\n");
  });

  it("does not let a link stand in for the vault", async () => {
    const { svc, home, vault } = setup();
    try {
      symlinkSync(vault, join(home, "shortcut"), "junction");
    } catch {
      return; // no permission to make links here
    }
    const e = await fails(svc.handle("write", { path: join(home, "shortcut", "daily", "note.md"), content: "x", force: true }));
    expect(e.code).toBe("read_only");
  });

  it("refuses everything but roots when turned off or running as root", async () => {
    const off = setup({ enabled: false }).svc;
    expect((await fails(off.handle("list", {}))).code).toBe("disabled");
    expect(await off.handle("roots", {})).toMatchObject({ files: false });
    const root = setup({ root: true }).svc;
    expect((await fails(root.handle("read", { path: "~/proj/app.py" }))).message).toMatch(/root/);
  });

  it("HB_FILES is on by default and off with 0/off", () => {
    expect(filesEnabled({})).toBe(true);
    expect(filesEnabled({ HB_FILES: "1" })).toBe(true);
    expect(filesEnabled({ HB_FILES: "0" })).toBe(false);
    expect(filesEnabled({ HB_FILES: "off" })).toBe(false);
  });
});

describe("editor helpers", () => {
  it("picks a language by name, extension or #! line", () => {
    expect(languageFor("package.json")).toBe("json");
    expect(languageFor("/srv/app/main.py")).toBe("python");
    expect(languageFor("deploy.sh")).toBe("shell");
    expect(languageFor(".bashrc")).toBe("shell");
    expect(languageFor(".env.local")).toBe("shell");
    expect(languageFor("App.tsx")).toBe("tsx");
    expect(languageFor("README.md")).toBe("markdown");
    expect(languageFor("ci.yml")).toBe("yaml");
    expect(languageFor("site.css")).toBe("css");
    expect(languageFor("index.html")).toBe("html");
    expect(languageFor("run", "#!/usr/bin/env bash")).toBe("shell");
    expect(languageFor("notes.txt")).toBe("plain");
  });

  it("detects tabs or the indent width", () => {
    expect(detectIndent("a\n\tb\n\t\tc\n")).toEqual({ tabs: true, size: 4 });
    expect(detectIndent("a:\n    b\n        c\n    d\n")).toEqual({ tabs: false, size: 4 });
    expect(detectIndent("{\n  \"a\": {\n    \"b\": 1\n  }\n}\n")).toEqual({ tabs: false, size: 2 });
  });
});
