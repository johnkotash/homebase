import { z } from "zod";

/**
 * The browser for agents (docs/BROWSER-AGENT-PLAN.md): what a browser node says about itself, the frames
 * that carry its picture to the app and a person's hands back, and the few rules both ends must agree on.
 *
 * Nothing here is stored by the hub. A browser's state and picture are live facts: the hub keeps the last
 * of each in memory for a device that opens the view, and forgets them when the connector goes.
 */

export const BROWSER_MCP_SERVER = "browser";
/** An agent with this capability has the browser tools; the app then shows the browser in its sessions. */
export const BROWSER_CAPABILITY = "browser";
export const browserToolId = (name: string) => `mcp__${BROWSER_MCP_SERVER}__${name}`;
export const isBrowserTool = (tool: string | null | undefined) => typeof tool === "string" && tool.startsWith(`mcp__${BROWSER_MCP_SERVER}__`);
/** The `tool` on an approval the browser raised itself (an action to allow, or "the browser needs you"). */
export const BROWSER_APPROVAL = { act: "browser_act", needsOwner: "browser_needs_owner" } as const;
export const isBrowserApproval = (tool: string | null | undefined) => tool === BROWSER_APPROVAL.act || tool === BROWSER_APPROVAL.needsOwner;
export const browserTopic = (connectorId: string) => `browser:${connectorId}`;

// ---------------------------------------------------------------- who is driving

/**
 * One party drives at a time.
 *   agent        the agent, inside its rules
 *   owner        the owner, through the live view; the agent's next step waits
 *   signin       the owner, privately: nothing is recorded and the agent waits
 *   needs_owner  nobody until the owner comes (a sign-in wall, a site check); the agent waits
 *   paused       the owner stopped the agent for now
 */
export const BrowserSeat = z.enum(["agent", "owner", "signin", "needs_owner", "paused"]);
export type BrowserSeat = z.infer<typeof BrowserSeat>;
export const SEAT_LABEL: Record<BrowserSeat, string> = {
  agent: "Agent driving", owner: "You are driving", signin: "Private sign-in", needs_owner: "Needs you", paused: "Paused",
};

// ---------------------------------------------------------------- settings

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const BrowserBudget = z.object({
  /** Pages an agent may load on one site in an hour. */
  pagesPerHour: z.number().int().min(1).max(5000),
  /** Seconds between two page loads on one site. The agent's next load waits for it. */
  minGapSec: z.number().min(0).max(600),
  pagesPerDay: z.number().int().min(1).max(50000),
  /** The hours agents may browse, on the node's clock. Null: any time. */
  hours: z.object({ start: HHMM, end: HHMM }).nullable(),
});
export type BrowserBudget = z.infer<typeof BrowserBudget>;
export const DEFAULT_BROWSER_BUDGET: BrowserBudget = { pagesPerHour: 40, minGapSec: 8, pagesPerDay: 200, hours: { start: "07:00", end: "22:00" } };

const Site = z.string().min(1).max(120);
export const BrowserSettings = z.object({
  budget: BrowserBudget,
  /** Sites where an agent in Auto mode may click, type and submit without asking. Everywhere else it asks. */
  actSites: z.array(Site).max(200),
  /** Sites no agent may open. */
  blockedSites: z.array(Site).max(500),
});
export type BrowserSettings = z.infer<typeof BrowserSettings>;
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = { budget: DEFAULT_BROWSER_BUDGET, actSites: [], blockedSites: [] };

// ---------------------------------------------------------------- state

/**
 * The page's field that has the keyboard focus while the owner drives, so the app can bring up the phone's
 * own keyboard of the right kind. Never the field's value: what is in it stays on the page.
 */
export const BrowserFocus = z.object({
  /** Changes whenever the focus moves to another field: the app starts its typing afresh. */
  seq: z.number().int().nonnegative(),
  /** "text", "email", "url", "tel", "number", "search", "password", or "multiline" (a text area or an editable block). */
  inputType: z.string().max(20),
  /** A password, a one-time code or a card number: typed privately, never suggested or learnt by the keyboard. */
  secret: z.boolean(),
  multiline: z.boolean(),
  /**
   * Counts the owner's taps that landed inside this field. A change means "the owner tapped the field": the
   * phone raises its keyboard, also when the field already had the focus. A tap anywhere else does not.
   */
  tapped: z.number().int().nonnegative().optional(),
});
export type BrowserFocus = z.infer<typeof BrowserFocus>;

/** The page size a phone asks for when it takes over: its own screen, in CSS pixels, and how sharp to draw it. */
export const BrowserSize = z.object({
  width: z.number().int().min(240).max(2000),
  height: z.number().int().min(240).max(3000),
  scale: z.number().min(1).max(3),
});
export type BrowserSize = z.infer<typeof BrowserSize>;

export const BrowserState = z.object({
  /** False: no browser process right now (it starts when somebody needs it). */
  running: z.boolean(),
  /** Why this node cannot run a browser at all (no Chrome found). Null when it can. */
  unavailable: z.string().max(400).nullable(),
  seat: BrowserSeat,
  /** With `needs_owner`: what the owner is needed for. */
  needs: z.object({ reason: z.string().max(300), site: z.string().max(120).nullable(), since: z.number().int() }).nullable(),
  url: z.string().max(2000).nullable(),
  title: z.string().max(300).nullable(),
  site: z.string().max(120).nullable(),
  tabs: z.number().int().nonnegative(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  /** How the page is laid out: as on a desktop, or narrow and tall as on a phone (easier to read from one). */
  layout: z.enum(["desktop", "phone"]).default("desktop"),
  /**
   * The layout the page in front was loaded in. Sites send their phone or computer page by it, so a page the
   * agent opened as a desktop stays the computer page in the phone layout until it is loaded again. Absent from older nodes.
   */
  pageLayout: z.enum(["desktop", "phone"]).nullable().optional(),
  /** "Chrome/159.0.0.0" */
  browser: z.string().max(80).nullable(),
  headless: z.boolean(),
  note: z.string().max(400).nullable(),
  /** The agent's allowance on the site in front. */
  budget: z.object({ site: z.string().max(120), usedHour: z.number().int(), usedDay: z.number().int(), nextAt: z.number().int().nullable() }).nullable(),
  settings: BrowserSettings,
  /** Sites the owner has signed in to in this browser, by their own word, and when. Never a cookie. */
  signedIn: z.array(z.object({ site: z.string().max(120), at: z.number().int() })).max(200),
  /** The run whose agent last used the browser, while it is live. */
  runId: z.string().nullable(),
  last: z.object({ at: z.number().int(), by: z.enum(["agent", "owner"]), text: z.string().max(300) }).nullable(),
  viewers: z.number().int().nonnegative(),
  /** While the owner drives: the field on the page that has the focus, if it takes text. Absent from older nodes. */
  focus: BrowserFocus.nullable().optional(),
  updatedAt: z.number().int(),
});
export type BrowserState = z.infer<typeof BrowserState>;

/** The largest picture (base64 characters) a frame may carry: well inside the hub's 1 MiB message limit. */
export const BROWSER_FRAME_MAX_CHARS = 900_000;

/**
 * One picture of the page in front. base64 JPEG; shown and thrown away. `width` and `height` are the page's
 * size in CSS pixels (the JPEG itself may have more pixels: a phone's screen is drawn at its own density).
 */
export const BrowserFrame = z.object({
  seq: z.number().int().nonnegative(), at: z.number().int(), data: z.string().max(BROWSER_FRAME_MAX_CHARS),
  width: z.number().int().positive(), height: z.number().int().positive(),
  /** How long the last pictures took to reach a watching device and be acknowledged, in ms. Absent until one was. */
  rtt: z.number().int().nonnegative().max(600_000).optional(),
  /** The picture level the node chose for the link (0 sharpest .. 3 lightest), see BROWSER_PICTURE_LEVELS. */
  level: z.number().int().min(0).max(9).optional(),
});
export type BrowserFrame = z.infer<typeof BrowserFrame>;

/**
 * How sharp the live picture is drawn, from the best link to the worst: JPEG quality and the share of the
 * page's device pixels kept. The node moves between them by the round trip of its pictures, so a slow link
 * gets lighter pictures instead of a stalled view; taps and keys are never held back for it.
 */
export const BROWSER_PICTURE_LEVELS = [
  { quality: 72, scale: 1 },
  { quality: 60, scale: 1 },
  { quality: 50, scale: 0.75 },
  { quality: 40, scale: 0.5 },
] as const;
/** A round trip slower than this makes the pictures lighter; faster than `fastMs` for a while makes them sharper. */
export const BROWSER_LINK = { slowMs: 650, fastMs: 250 } as const;

// ---------------------------------------------------------------- a person's hands

const unit = z.number().min(0).max(1);
/** Positions are fractions of the picture (0 to 1), so they mean the same at any size the app draws it. */
export const BrowserInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mouse"), type: z.enum(["down", "up", "move", "click"]), x: unit, y: unit, button: z.enum(["left", "right", "middle"]).optional(), clicks: z.number().int().min(1).max(3).optional() }),
  /** A finger's tap: a touch on a page laid out as on a phone, a click otherwise. */
  z.object({ kind: z.literal("tap"), x: unit, y: unit }),
  z.object({ kind: z.literal("wheel"), x: unit, y: unit, dx: z.number().min(-5000).max(5000), dy: z.number().min(-5000).max(5000) }),
  /** `repeat` (press only): the same key that many times, e.g. Backspace for each letter a phone keyboard took back. */
  z.object({ kind: z.literal("key"), type: z.enum(["down", "up", "press"]), key: z.string().min(1).max(32), code: z.string().max(32).optional(), text: z.string().max(8).optional(), modifiers: z.number().int().min(0).max(15).optional(), repeat: z.number().int().min(1).max(500).optional() }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(4000) }),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;

export const BROWSER_CONTROLS = [
  "take", "release", "signin", "done", "pause", "resume", "goto", "back", "forward", "reload", "stop", "settings", "allow_site", "disallow_site", "forget", "layout",
] as const;
export const BrowserControl = z.object({
  action: z.enum(BROWSER_CONTROLS),
  url: z.string().max(2000).optional(),
  site: Site.optional(),
  settings: BrowserSettings.partial().optional(),
  /** With take, signin and layout: how to lay the page out while the owner drives. Handing back restores the agent's layout. */
  layout: z.enum(["desktop", "phone"]).optional(),
  /** With layout "phone": the phone's own screen, so the page fills it one to one. Left out: 412 × 820. */
  size: BrowserSize.optional(),
});
export type BrowserControl = z.infer<typeof BrowserControl>;

// ---------------------------------------------------------------- frames

/** connector -> hub */
export const BrowserStateFrame = z.object({ t: z.literal("browser.state"), state: BrowserState });
export const BrowserPictureFrame = z.object({ t: z.literal("browser.frame"), frame: BrowserFrame });
export const BrowserNoticeFrame = z.object({ t: z.literal("browser.notice"), deviceId: z.string().nullable(), message: z.string().max(400) });
/** device -> hub. Relayed to the connector and never stored: no mutation, no change log, no audit of what was typed. */
export const BrowserInputFrame = z.object({ t: z.literal("browser.input"), connectorId: z.string(), input: BrowserInput });
export const BrowserControlFrame = z.object({ t: z.literal("browser.control"), connectorId: z.string(), control: BrowserControl });
/** device -> hub: "picture `seq` arrived". The node paces its pictures by these, and learns how fast the link is. */
export const BrowserAckFrame = z.object({ t: z.literal("browser.ack"), connectorId: z.string(), seq: z.number().int().nonnegative() });

/** hub -> connector */
export interface BrowserToConnector {
  input: { t: "browser.input"; input: BrowserInput; deviceId: string };
  control: { t: "browser.control"; control: BrowserControl; deviceId: string };
  viewers: { t: "browser.viewers"; count: number };
  ack: { t: "browser.ack"; seq: number; deviceId: string };
}
/** hub -> device */
export type BrowserToDevice =
  | { t: "browser.state"; connectorId: string; state: BrowserState | null }
  | { t: "browser.frame"; connectorId: string; frame: BrowserFrame }
  | { t: "browser.notice"; connectorId: string; message: string };

// ---------------------------------------------------------------- shared words and rules

const TWO_PART_SUFFIX = /\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/;

/** The site an address belongs to: "www.shop.example.co.uk/x" -> "example.co.uk". Hosts without a name keep host and port. */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[") || !host.includes(".")) return u.port ? `${host}:${u.port}` : host;
  const parts = host.split(".");
  const keep = TWO_PART_SUFFIX.test(host) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/** What an owner types as a site, tidied: "https://www.Example.com/shop" -> "example.com". Null when it is not one. */
export function normalizeSite(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  return siteOf(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`);
}

/** "14 of 40 pages this hour" for the site in front, or null when no agent has loaded anything there. */
export function budgetText(state: Pick<BrowserState, "budget" | "settings">): string | null {
  const b = state.budget;
  if (!b) return null;
  return `${b.usedHour} of ${state.settings.budget.pagesPerHour} pages this hour`;
}

/** The line under the live picture: who drives, where, and how much of the allowance is used. */
export function browserStatusLine(state: BrowserState | null | undefined): string {
  if (!state) return "Browser not connected";
  if (state.unavailable) return state.unavailable;
  if (!state.running) return state.seat === "paused" ? "Paused · the browser is closed" : "The browser is closed. It opens when an agent or you need it.";
  const where = state.site ?? (state.url && state.url !== "about:blank" ? state.url.slice(0, 60) : "a blank page");
  const parts = [state.seat === "needs_owner" && state.needs ? `Needs you: ${state.needs.reason}` : SEAT_LABEL[state.seat], where];
  const b = state.seat === "agent" ? budgetText(state) : null;
  if (b) parts.push(b);
  return parts.join(" · ");
}

/** What one step in the browser looked like, on a run's timeline. */
export const BrowserStep = z.object({
  action: z.string().max(40), url: z.string().max(2000).nullable(), title: z.string().max(300).nullable(), site: z.string().max(120).nullable(),
  /** A small picture of the page after the step, in the artifact store. */
  shotId: z.string().max(80).nullable().optional(),
});
export type BrowserStep = z.infer<typeof BrowserStep>;
