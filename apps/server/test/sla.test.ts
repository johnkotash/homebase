import { describe, expect, it } from "vitest";
import type { BusinessCalendar, SlaPolicy } from "@homebase/protocol";
import { addBusinessMinutes, businessMsBetween, computeSla, pickPolicy, slaStateAt, wallTime, zonedToUtc } from "../src/hub/sla";
import { triage } from "../src/ingest/triage";

const NY: BusinessCalendar = { tz: "America/New_York", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", holidays: [] };
/** A wall-clock time in New York as a UTC instant. */
const ny = (y: number, mo: number, d: number, h: number, mi = 0) => zonedToUtc(y, mo, d, h, mi, "America/New_York");
const at = (ms: number) => {
  const w = wallTime(ms, "America/New_York");
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")} ${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`;
};

describe("business-hours math", () => {
  it("converts wall time in a zone to UTC across DST", () => {
    expect(new Date(ny(2026, 11, 18, 10)).toISOString()).toBe("2026-11-18T15:00:00.000Z"); // EST, UTC-5
    expect(new Date(ny(2026, 7, 1, 10)).toISOString()).toBe("2026-07-01T14:00:00.000Z"); // EDT, UTC-4
    expect(wallTime(Date.UTC(2026, 10, 18, 15, 0), "America/New_York")).toMatchObject({ h: 10, mi: 0, dow: 3 });
  });

  it("stays inside the same day when there is room", () => {
    expect(at(addBusinessMinutes(ny(2026, 11, 18, 10), 120, NY))).toBe("2026-11-18 12:00");
    expect(at(addBusinessMinutes(ny(2026, 11, 18, 9), 480, NY))).toBe("2026-11-18 17:00");
  });

  it("one business day from mid-morning lands at the same time the next business day", () => {
    expect(at(addBusinessMinutes(ny(2026, 11, 18, 10, 30), 480, NY))).toBe("2026-11-19 10:30");
  });

  it("rolls over the evening, and over the weekend", () => {
    expect(at(addBusinessMinutes(ny(2026, 11, 18, 16), 120, NY))).toBe("2026-11-19 10:00"); // Wed 4 PM + 2 h
    expect(at(addBusinessMinutes(ny(2026, 11, 20, 16), 120, NY))).toBe("2026-11-23 10:00"); // Fri 4 PM + 2 h → Mon
    expect(at(addBusinessMinutes(ny(2026, 11, 20, 10), 480 * 3, NY))).toBe("2026-11-25 10:00"); // 3 business days over a weekend
  });

  it("starts counting at the next opening when the start is outside business hours", () => {
    expect(at(addBusinessMinutes(ny(2026, 11, 18, 22), 60, NY))).toBe("2026-11-19 10:00"); // Wed 10 PM
    expect(at(addBusinessMinutes(ny(2026, 11, 18, 6), 60, NY))).toBe("2026-11-18 10:00"); // before opening
    expect(at(addBusinessMinutes(ny(2026, 11, 21, 12), 30, NY))).toBe("2026-11-23 09:30"); // Saturday
    expect(at(addBusinessMinutes(ny(2026, 11, 18, 17), 1, NY))).toBe("2026-11-19 09:01"); // exactly at closing
  });

  it("skips holidays", () => {
    const cal = { ...NY, holidays: ["2026-11-26"] }; // Thanksgiving
    expect(at(addBusinessMinutes(ny(2026, 11, 25, 16), 120, cal))).toBe("2026-11-27 10:00");
  });

  it("keeps wall-clock hours across a DST change", () => {
    // Clocks fall back on Sun 2026-11-01. Fri 4 PM + 2 business hours is still Mon 10 AM local.
    expect(at(addBusinessMinutes(ny(2026, 10, 30, 16), 120, NY))).toBe("2026-11-02 10:00");
    // Clocks spring forward on Sun 2026-03-08.
    expect(at(addBusinessMinutes(ny(2026, 3, 6, 16), 120, NY))).toBe("2026-03-09 10:00");
  });

  it("supports an around-the-clock calendar", () => {
    const always: BusinessCalendar = { tz: "America/New_York", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00", holidays: [] };
    const start = ny(2026, 11, 21, 23, 30); // Saturday night
    expect(addBusinessMinutes(start, 60, always) - start).toBe(60 * 60_000);
    expect(addBusinessMinutes(start, 3 * 24 * 60, always) - start).toBe(3 * 24 * 60 * 60_000);
  });

  it("measures business time between two instants (inverse of adding)", () => {
    const start = ny(2026, 11, 20, 15, 15);
    for (const mins of [1, 45, 105, 480, 1234]) {
      const end = addBusinessMinutes(start, mins, NY);
      expect(businessMsBetween(start, end, NY)).toBe(mins * 60_000);
    }
    expect(businessMsBetween(ny(2026, 11, 21, 9), ny(2026, 11, 22, 17), NY)).toBe(0); // whole weekend
  });
});

describe("policies", () => {
  const policy = (id: string, match: SlaPolicy["match"], isDefault = false): SlaPolicy => ({
    id, name: id, match, respondWithinMinutes: 480, warnAtPct: 75, calendar: NY, isDefault, updatedAt: 0,
  });
  const policies = [policy("default", {}, true), policy("p0", { priority: "P0" }), policy("gmail-p1", { source: "gmail", priority: "P1" }), policy("client", { clientLabel: "Northwind" })];

  it("picks the most specific match, else the default", () => {
    expect(pickPolicy(policies, { source: "gmail", priority: "P1", clientLabel: null })?.id).toBe("gmail-p1");
    expect(pickPolicy(policies, { source: "monitor", priority: "P0", clientLabel: null })?.id).toBe("p0");
    expect(pickPolicy(policies, { source: "clickup", priority: "P2", clientLabel: "Northwind" })?.id).toBe("client");
    expect(pickPolicy(policies, { source: "clickup", priority: "P2", clientLabel: null })?.id).toBe("default");
  });

  it("sets the deadline and the warning point from the seed policy (480 min, warn at 75%)", () => {
    const received = ny(2026, 11, 18, 10);
    const { slaDueAt, slaWarnAt } = computeSla(policies[0], received);
    expect(at(slaDueAt)).toBe("2026-11-19 10:00");
    expect(at(slaWarnAt)).toBe("2026-11-18 16:00"); // 6 business hours in
    expect(slaStateAt(received, slaDueAt, slaWarnAt)).toBe("running");
    expect(slaStateAt(slaWarnAt, slaDueAt, slaWarnAt)).toBe("warning");
    expect(slaStateAt(slaDueAt, slaDueAt, slaWarnAt)).toBe("breached");
    expect(slaStateAt(received, null, null)).toBe("none");
  });
});

describe("triage rules", () => {
  it("applies source defaults and keywords", () => {
    expect(triage({ source: "monitor", title: "Form check FAILED: x", meta: { state: "failed" } }).priority).toBe("P0");
    expect(triage({ source: "monitor", title: "Recovered: x is back up", meta: { state: "recovered" } }).priority).toBe("P3");
    expect(triage({ source: "gmail", title: "URGENT: checkout is charging tax twice" }).priority).toBe("P0");
    expect(triage({ source: "gmail", title: "Quote request: redesign" }).priority).toBe("P1");
    expect(triage({ source: "gmail", title: "Photos from the weekend" }).priority).toBe("P2");
    expect(triage({ source: "resend", title: "Bounce: lead notification" }).priority).toBe("P2");
    expect(triage({ source: "calendar", title: "Daily agenda" }).priority).toBe("P3");
    expect(triage({ source: "gmail", title: "Weekly tips", sender: "newsletter@vendor.example" }).priority).toBe("P3");
  });

  it("raises priority-list senders to P1 but never above a P0 keyword", () => {
    const cfg = { vipSenders: ["bigclient.example"], mutedSenders: [] };
    expect(triage({ source: "gmail", title: "Photos", sender: "amy@bigclient.example" }, cfg).priority).toBe("P1");
    expect(triage({ source: "gmail", title: "Site is down", sender: "amy@bigclient.example" }, cfg).priority).toBe("P0");
  });
});
