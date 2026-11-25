import { describe, expect, it } from "vitest";
import { InboundFrame, USAGE_SETTING, usageFromRateLimit, type UsageSnapshot } from "@homebase/protocol";
import { usageLevel } from "../src/hub/usage";
import { connectConnector, makeHub } from "./helpers";

const H = 3_600_000;

function setup() {
  const ctx = makeHub();
  const con = connectConnector(ctx.hub, ctx.directory);
  const t0 = ctx.hub.now();
  const report = (five: number, week: number, over: { fiveReset?: number; status?: string; at?: number } = {}) => {
    const usage: UsageSnapshot = {
      at: over.at ?? ctx.hub.now(), agentKey: "dev", model: "m",
      windows: {
        five_hour: { pct: five, resetsAt: over.fiveReset ?? t0 + 3 * H, status: over.status ?? "allowed" },
        seven_day: { pct: week, resetsAt: t0 + 72 * H, status: "allowed" },
      },
    };
    ctx.hub.onFrame(con, { t: "usage.report", usage });
  };
  const open = () => ctx.store.all<{ external_id: string; priority: string; title: string }>(
    "SELECT external_id, priority, title FROM inbox_items WHERE source = 'monitor' AND status NOT IN ('responded','done') ORDER BY external_id");
  const meter = () => ctx.store.get<{ value: string }>("SELECT value FROM settings WHERE id = ?", USAGE_SETTING);
  return { ...ctx, con, report, open, meter, t0 };
}

describe("Claude usage meter (issue #4)", () => {
  it("reads the CLI's rate_limit_info windows", () => {
    const u = usageFromRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.427, resetsAt: 1795091400, status: "allowed" }, seven_day: { utilization: 0.95, resetsAt: 1795590000, status: "allowed_warning" } } }, 5);
    expect(u).toEqual({ at: 5, windows: { five_hour: { pct: 42.7, resetsAt: 1795091400000, status: "allowed" }, seven_day: { pct: 95, resetsAt: 1795590000000, status: "allowed_warning" } } });
    expect(usageFromRateLimit({ status: "allowed" }, 5)).toBeNull();
    expect(usageFromRateLimit(null, 5)).toBeNull();
  });

  it("levels: thresholds, and rejected is the limit", () => {
    expect(usageLevel(42, "allowed", [80, 95])).toBeNull();
    expect(usageLevel(81, "allowed", [80, 95])).toBe(80);
    expect(usageLevel(96, "allowed", [80, 95])).toBe(95);
    expect(usageLevel(10, "rejected", [80, 95])).toBe("limit");
  });

  it("keeps the latest reading in the synced setting; an older report never replaces it", () => {
    const s = setup();
    expect(InboundFrame.safeParse({ t: "usage.report", usage: { at: 1, windows: {} } }).success).toBe(true);
    s.report(10, 20);
    expect(JSON.parse(s.meter()!.value).windows.five_hour.pct).toBe(10);
    s.report(50, 20, { at: s.t0 - 1000 });
    expect(JSON.parse(s.meter()!.value).windows.five_hour.pct).toBe(10);
  });

  it("raises one alert per level and window, escalates, and clears after the reset", () => {
    const s = setup();
    s.report(40, 85);
    expect(s.open().map((i) => [i.external_id.split(":").slice(0, 3).join(":"), i.priority])).toEqual([["usage:seven_day:80", "P2"]]);
    s.report(45, 86); // same level: no duplicate
    expect(s.open()).toHaveLength(1);
    s.report(100, 96, { status: "rejected" });
    expect(s.open().map((i) => i.external_id.split(":").slice(0, 3).join(":")).sort()).toEqual(["usage:five_hour:limit", "usage:seven_day:95"]);
    expect(s.open().every((i) => i.priority === "P1")).toBe(true);
    expect(s.open().find((i) => i.external_id.startsWith("usage:five_hour"))!.title).toMatch(/limit reached: resets/);
    // The 5-hour window reset: a new episode closes the old limit alert.
    s.clock.now += 4 * H;
    s.report(3, 96, { fiveReset: s.t0 + 8 * H });
    expect(s.open().map((i) => i.external_id.split(":").slice(0, 3).join(":"))).toEqual(["usage:seven_day:95"]);
  });
});
