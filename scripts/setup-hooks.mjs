#!/usr/bin/env node
// `npm install` runs this (the "prepare" script): inside this repo's git checkout it points git at the tracked
// hooks in .githooks (secret scan before every commit and push). Anywhere else it does nothing, and it never fails.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (existsSync(join(root, ".githooks")) && realpathSync(top) === realpathSync(root)) {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
    console.log("[hooks] git hooks: .githooks (secret scan on commit and push)");
  }
} catch {
  // Not a git checkout (a tarball, a deploy copy) or git is missing: nothing to set up.
}
