import type { BusinessCalendar, InboxItem, SlaPolicy } from "@homebase/protocol";

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number; dow: number }

/** Wall-clock fields of a UTC instant in a time zone. */
export function wallTime(utcMs: number, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(utcMs))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const dow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second, dow };
}

/** UTC instant for a wall-clock time in a zone (handles DST by correcting the offset twice). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = guess;
  for (let i = 0; i < 2; i++) {
    const w = wallTime(utc, tz);
    const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    utc = guess - (asUtc - utc);
  }
  return utc;
}

const hm = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const pad = (n: number) => String(n).padStart(2, "0");

function isBusinessDay(cal: BusinessCalendar, w: { y: number; mo: number; d: number; dow: number }) {
  if (!cal.days.includes(w.dow)) return false;
  return !cal.holidays.includes(`${w.y}-${pad(w.mo)}-${pad(w.d)}`);
}

/**
 * Adds business minutes to an instant. Time outside the calendar's working window does not count.
 * A start outside business hours begins counting at the next opening.
 */
export function addBusinessMinutes(startMs: number, minutes: number, cal: BusinessCalendar): number {
  const open = hm(cal.start);
  const close = hm(cal.end);
  if (close <= open || cal.days.length === 0) return startMs + minutes * 60_000;
  let remainingMs = minutes * 60_000;
  let cursor = startMs;
  for (let guard = 0; guard < 4000; guard++) {
    const w = wallTime(cursor, cal.tz);
    const dayStart = zonedToUtc(w.y, w.mo, w.d, Math.floor(open / 60), open % 60, cal.tz);
    const dayEnd = close >= 1440
      ? zonedToUtc(w.y, w.mo, w.d + 1, 0, 0, cal.tz)
      : zonedToUtc(w.y, w.mo, w.d, Math.floor(close / 60), close % 60, cal.tz);
    if (isBusinessDay(cal, w) && cursor < dayEnd) {
      const from = Math.max(cursor, dayStart);
      const available = dayEnd - from;
      if (remainingMs <= available) return from + remainingMs;
      remainingMs -= available;
    }
    // jump to the next calendar day's opening (Date.UTC normalises day overflow)
    cursor = zonedToUtc(w.y, w.mo, w.d + 1, Math.floor(open / 60), open % 60, cal.tz);
  }
  return cursor;
}

/** Business milliseconds between two instants (0 if end <= start). */
export function businessMsBetween(startMs: number, endMs: number, cal: BusinessCalendar): number {
  if (endMs <= startMs) return 0;
  const open = hm(cal.start);
  const close = hm(cal.end);
  if (close <= open || cal.days.length === 0) return endMs - startMs;
  let total = 0;
  let cursor = startMs;
  for (let guard = 0; guard < 4000 && cursor < endMs; guard++) {
    const w = wallTime(cursor, cal.tz);
    const dayStart = zonedToUtc(w.y, w.mo, w.d, Math.floor(open / 60), open % 60, cal.tz);
    const dayEnd = close >= 1440
      ? zonedToUtc(w.y, w.mo, w.d + 1, 0, 0, cal.tz)
      : zonedToUtc(w.y, w.mo, w.d, Math.floor(close / 60), close % 60, cal.tz);
    if (isBusinessDay(cal, w) && cursor < dayEnd) {
      const from = Math.max(cursor, dayStart);
      const to = Math.min(endMs, dayEnd);
      if (to > from) total += to - from;
    }
    cursor = zonedToUtc(w.y, w.mo, w.d + 1, Math.floor(open / 60), open % 60, cal.tz);
  }
  return total;
}

type Matchable = Pick<InboxItem, "source" | "priority" | "clientLabel">;

/** Most specific matching policy wins; otherwise the default. */
export function pickPolicy(policies: SlaPolicy[], item: Matchable): SlaPolicy | undefined {
  let best: SlaPolicy | undefined;
  let bestScore = -1;
  for (const p of policies) {
    const m = p.match ?? {};
    const keys = Object.keys(m).filter((k) => (m as any)[k] != null);
    if (keys.length === 0) continue;
    const ok =
      (m.source == null || m.source === item.source) &&
      (m.priority == null || m.priority === item.priority) &&
      (m.clientLabel == null || m.clientLabel === item.clientLabel);
    if (ok && keys.length > bestScore) {
      best = p;
      bestScore = keys.length;
    }
  }
  return best ?? policies.find((p) => p.isDefault) ?? policies.find((p) => Object.keys(p.match ?? {}).length === 0);
}

export function computeSla(policy: SlaPolicy, receivedAt: number): { slaDueAt: number; slaWarnAt: number } {
  const slaDueAt = addBusinessMinutes(receivedAt, policy.respondWithinMinutes, policy.calendar);
  const slaWarnAt = addBusinessMinutes(receivedAt, (policy.respondWithinMinutes * policy.warnAtPct) / 100, policy.calendar);
  return { slaDueAt, slaWarnAt };
}

export function slaStateAt(now: number, dueAt: number | null, warnAt: number | null): "none" | "running" | "warning" | "breached" {
  if (dueAt == null) return "none";
  if (now >= dueAt) return "breached";
  if (warnAt != null && now >= warnAt) return "warning";
  return "running";
}
