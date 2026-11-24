import { describe, expect, it } from "vitest";
import { deliver, inView, isAppLink, routesShowing, sessionInView, type Presence, type SubjectLookup } from "../src/notifications/rules";

const look: SubjectLookup = {
  runs: { run_1: { threadId: "thr_1" }, run_2: { threadId: "thr_2" }, run_bare: { threadId: null } },
  approvals: { apr_1: { runId: "run_1" }, apr_bare: { runId: "run_bare" } },
};
const at = (path: string, focused = true): Presence => ({ path, focused });

/** The notifications the hub really sends (apps/server/src/hub/runs.ts, approvals.ts, WorkspaceHub.ts). */
const finished = { link: "/chats/thr_1", collapseKey: "run_1" };
const failed = { link: "/runs/run_1", collapseKey: "run_1" };
const approval = { link: "/approvals/apr_1", collapseKey: "apr_1" };
const inbox = { link: "/inbox/inb_1", collapseKey: "inb_1" };

describe("which session is in view", () => {
  it("is the open session while the app is in front", () => {
    expect(sessionInView(at("/chats/thr_1"))).toBe("thr_1");
    expect(sessionInView(at("/chats/thr_1/"))).toBe("thr_1");
    expect(sessionInView(at("/chats/thr_1?x=1"))).toBe("thr_1");
  });
  it("is none on any other screen, or when the window is unfocused, minimized or the phone app is in the background", () => {
    expect(sessionInView(at("/chats"))).toBeNull();
    expect(sessionInView(at("/"))).toBeNull();
    expect(sessionInView(at("/runs/run_1"))).toBeNull();
    expect(sessionInView(at("/chats/thr_1", false))).toBeNull();
  });
});

describe("no notification for what the owner is already looking at", () => {
  it("the reported case: the agent finishes in the session that is open and in front", () => {
    expect(deliver(finished, at("/chats/thr_1"), look, true)).toBe("none");
    expect(deliver(finished, at("/chats/thr_1"), look, false)).toBe("none");
  });
  it("a failed run or an approval shows inline in its session, so that session counts as viewing it", () => {
    expect(deliver(failed, at("/chats/thr_1"), look, true)).toBe("none");
    expect(deliver(failed, at("/runs/run_1"), look, true)).toBe("none");
    expect(deliver(approval, at("/chats/thr_1"), look, true)).toBe("none");
    expect(deliver(approval, at("/approvals/apr_1"), look, true)).toBe("none");
    expect(deliver(approval, at("/approvals"), look, true)).toBe("none");
    expect(deliver(finished, at("/runs/run_1"), look, true)).toBe("none");
    expect(deliver(inbox, at("/inbox/inb_1"), look, true)).toBe("none");
  });
  it("routesShowing lists every such route", () => {
    expect(routesShowing(finished, look).sort()).toEqual(["/chats/thr_1", "/runs/run_1"]);
    expect(routesShowing(failed, look).sort()).toEqual(["/chats/thr_1", "/runs/run_1"]);
    expect(routesShowing(approval, look).sort()).toEqual(["/approvals", "/approvals/apr_1", "/chats/thr_1"]);
    expect(routesShowing({ link: "/approvals/apr_bare" }, look).sort()).toEqual(["/approvals", "/approvals/apr_bare"]);
    expect(routesShowing({ link: "/approvals/apr_unknown" }, look).sort()).toEqual(["/approvals", "/approvals/apr_unknown"]);
    expect(routesShowing(inbox, look)).toEqual(["/inbox/inb_1"]);
    expect(routesShowing({ link: null }, look)).toEqual([]);
    expect(routesShowing({}, look)).toEqual([]);
  });
});

describe("an in-app toast when the app is in front on another screen", () => {
  it("another session, another tab, the session list", () => {
    for (const path of ["/chats/thr_2", "/chats", "/", "/inbox", "/projects", "/notes", "/settings", "/runs/run_2"]) {
      expect(deliver(finished, at(path), look, true)).toBe("toast");
    }
    expect(deliver(approval, at("/chats/thr_2"), look, true)).toBe("toast");
    expect(deliver(inbox, at("/inbox"), look, true)).toBe("toast");
    expect(deliver(inbox, at("/inbox/inb_2"), look, true)).toBe("toast");
  });
  it("never a system notification while in front: the toast is enough", () => {
    expect(deliver(finished, at("/inbox"), look, true)).not.toBe("os");
    expect(deliver(approval, at("/"), look, true)).not.toBe("os");
  });
  it("a notification with no link can never be in view", () => {
    expect(deliver({ link: null }, at("/"), look, true)).toBe("toast");
    expect(inView({}, at("/"), look)).toBe(false);
  });
  it("only a particular session, run, approval or inbox item can be in view: the Settings test notification always shows", () => {
    const test = { link: "/settings", collapseKey: "test" };
    expect(routesShowing(test, look)).toEqual([]);
    expect(deliver(test, at("/settings"), look, true)).toBe("toast");
    expect(deliver(test, at("/settings", false), look, true)).toBe("os");
    expect(deliver({ link: "/inbox" }, at("/inbox"), look, true)).toBe("toast");
    expect(deliver({ link: "/" }, at("/"), look, true)).toBe("toast");
  });
});

describe("a system notification when the app is not in front", () => {
  it("even for the session that is open: unfocused, minimized or hidden means it was not seen", () => {
    expect(deliver(finished, at("/chats/thr_1", false), look, true)).toBe("os");
    expect(deliver(approval, at("/chats/thr_1", false), look, true)).toBe("os");
    expect(deliver(finished, at("/inbox", false), look, true)).toBe("os");
    expect(inView(finished, at("/chats/thr_1", false), look)).toBe(false);
  });
  it("falls back to the toast where no system notification can be shown (a browser tab without the permission)", () => {
    expect(deliver(finished, at("/chats/thr_1", false), look, false)).toBe("toast");
  });
});

describe("links opened from a notification", () => {
  it("are routes inside the app only", () => {
    expect(isAppLink("/chats/thr_1")).toBe(true);
    expect(isAppLink("/")).toBe(true);
    for (const bad of ["https://evil.example", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "chats/thr_1", "", null, undefined, 5, "/" + "x".repeat(600)]) {
      expect(isAppLink(bad)).toBe(false);
    }
  });
});
