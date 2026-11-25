import { describe, expect, it } from "vitest";
import { badName, baseName, joinPath, parentOf, startFolder, withCtrl, withEol } from "../src/workspace/model";

describe("workspace paths", () => {
  it("joins, splits and climbs Unix and Windows paths", () => {
    expect(joinPath("/home/me", "a.txt")).toBe("/home/me/a.txt");
    expect(joinPath("/", "etc")).toBe("/etc");
    expect(joinPath("C:\\Users\\me", "a.txt")).toBe("C:\\Users\\me\\a.txt");
    expect(joinPath("C:\\", "x")).toBe("C:\\x");
    expect(baseName("/home/me/proj/")).toBe("proj");
    expect(baseName("C:\\Users\\me\\a.py")).toBe("a.py");
    expect(parentOf("/home/me/a.txt")).toBe("/home/me");
    expect(parentOf("/home")).toBe("/");
    expect(parentOf("/")).toBeNull();
    expect(parentOf("C:\\Users\\me")).toBe("C:\\Users");
    expect(parentOf("C:\\Users")).toBe("C:\\");
  });

  it("checks new names", () => {
    expect(badName("notes.md")).toBeNull();
    expect(badName("  ")).toMatch(/name/);
    expect(badName("a/b")).toMatch(/\//);
    expect(badName("..")).toMatch(/reserved/);
  });

  it("starts in the session's folder, then its last run's, the project's, the agent's", () => {
    expect(startFolder({ threadCwd: "/s", lastRunCwd: "/r", projectCwd: "/p" })).toBe("/s");
    expect(startFolder({ lastRunCwd: "/r", projectCwd: "/p" })).toBe("/r");
    expect(startFolder({ projectCwd: "/p", agentDefault: "/a" })).toBe("/p");
    expect(startFolder({ workspaces: [{ cwd: "/w" }] })).toBe("/w");
    expect(startFolder({})).toBeNull();
  });

  it("turns a key into its control code for the phone's Ctrl key, and saves in the file's own line endings", () => {
    expect(withCtrl("c")).toBe("\x03");
    expect(withCtrl("D")).toBe("\x04");
    expect(withCtrl("[")).toBe("\x1b");
    expect(withCtrl("ab")).toBe("ab");
    expect(withEol(["a", "b", ""], "\r\n")).toBe("a\r\nb\r\n");
  });
});
