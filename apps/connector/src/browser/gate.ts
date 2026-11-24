import { siteOf, type BrowserBudget, type BrowserSettings, type PermissionMode, type Risk } from "@homebase/protocol";
import type { ElementInfo, PageFacts } from "./driver";

/**
 * The rules of the browser, as pure functions (docs/BROWSER-AGENT-PLAN.md 4.4). They live in the browser's
 * own service, not in an agent's permission prompt, so Claude and Codex get the same answers.
 *
 *   Look      open a page, read it, scroll, go back            allowed
 *   Navigate  follow a link, open a "see more"                 allowed
 *   Act       any other click, typing, keys, choosing, submit  Manual: asks every time
 *                                                              Auto: allowed on sites the owner listed, asks elsewhere
 *   never     a password, a one-time code, a card number       refused, in every mode
 *
 * Every judgement is made on what the element really is (ElementInfo, read from the page), never on what
 * the model says it is clicking.
 */

// ---------------------------------------------------------------- addresses

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // the tailnet's range
  /^192\.0\.0\./, /^198\.1[89]\./, /^2(2[4-9]|[3-5]\d)\./,
];

/** True for this machine, the home network, the tailnet and other names that never belong on the public web. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa") || host.endsWith(".ts.net")) return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true; // a bare number is an address in disguise
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return PRIVATE_V4.some((re) => re.test(host));
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
    // An IPv4 address dressed as IPv6 has no business in a web address; it is how a private one slips past a check like this.
    return host.startsWith("::ffff:");
  }
  // A name with no dot is a machine on the local network.
  return !host.includes(".");
}

export interface AddressRules {
  blockedSites: string[];
  /** "127.0.0.1:4173" style exceptions, for development against a local page. Set on the node, never from the app. */
  allowPrivate: string[];
}

const privateAllowed = (u: URL, allow: string[]) => allow.includes(u.host.toLowerCase()) || allow.includes(u.hostname.toLowerCase());

export type UrlVerdict = { ok: true; url: string; site: string } | { ok: false; reason: string };

/** May this address be opened at all? Web addresses only; nothing on this machine, the home network or the tailnet. */
export function checkUrl(raw: string, rules: AddressRules, who: "agent" | "owner" = "agent"): UrlVerdict {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "No address was given." };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: `"${text.slice(0, 120)}" is not a web address.` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: `Only http and https addresses can be opened, not ${u.protocol}//.` };
  if (u.username || u.password) return { ok: false, reason: "Addresses with a user name or password in them are not opened." };
  if (isPrivateHost(u.hostname) && !privateAllowed(u, rules.allowPrivate)) {
    return { ok: false, reason: `${u.hostname} is on this machine or a private network. The browser only opens the public web.` };
  }
  const site = siteOf(u.href) ?? u.host;
  if (who === "agent" && rules.blockedSites.includes(site)) return { ok: false, reason: `${site} is on the owner's list of sites agents may not open.` };
  return { ok: true, url: u.href, site };
}

/** For every request a page makes on its own (redirects, frames, images): the private-address rule, and nothing else. */
export function allowRequest(url: string, rules: Pick<AddressRules, "allowPrivate">): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ws:" && u.protocol !== "wss:") return u.protocol !== "file:";
  return !isPrivateHost(u.hostname) || privateAllowed(u, rules.allowPrivate);
}

// ---------------------------------------------------------------- credentials

const SECRET_AUTOCOMPLETE = /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year|cc-name)(\s|$)/;
const SECRET_WORDS = /pass(word|code|phrase)?\b|passwd|\bpwd\b|\botp\b|one[\s_-]?time|verification[\s_-]?code|security[\s_-]?code|auth(entication)?[\s_-]?code|2fa|two[\s_-]?factor|\bmfa\b|\bpin\b|\bcvv\b|\bcvc\b|card[\s_-]?number|\bssn\b|social[\s_-]?security|routing[\s_-]?number|account[\s_-]?number|secret|api[\s_-]?key|\btoken\b|recovery[\s_-]?(code|key)/i;

/**
 * Why an agent may never type here, or null. A password box, a one-time code, a payment card, or a field
 * whose own labels say it holds a secret. The owner types these, in the live view.
 */
export function credentialField(el: Pick<ElementInfo, "tag" | "type" | "autocomplete" | "inputName" | "id" | "placeholder" | "ariaLabel" | "label" | "name">): string | null {
  if (el.type === "password") return "a password field";
  if (SECRET_AUTOCOMPLETE.test(el.autocomplete)) return /cc-/.test(el.autocomplete) ? "a payment card field" : /one-time/.test(el.autocomplete) ? "a one-time code field" : "a password field";
  if (el.tag !== "input" && el.tag !== "textarea") return null;
  const words = [el.inputName, el.id, el.placeholder, el.ariaLabel, el.label, el.name].join(" ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return SECRET_WORDS.test(words) ? "a field for a password, a code or another secret" : null;
}

// ---------------------------------------------------------------- what a step is

export type Tier = "look" | "navigate" | "act";

export interface StepClass {
  tier: Tier;
  /** A few words for the card: "follow link", "press button". */
  verb: string;
  /** Acting only: how much is at stake. High is confirmed in the app, in every mode. */
  risk: Risk;
}

const EXPAND_WORDS = /^(see|show|view|read|load|display)\s+(more|all|less|fewer|\d+)|^(more|expand|collapse|show|hide|details|next|previous|prev|older|newer|continue reading)\b|\bmore (comments|replies|results|posts)\b|^\d+\s+(more\s+)?(comments?|replies|reply)\b/i;
/** Words on a control that spend money, or destroy or hand over something. */
const HIGH_STAKES = /\b(buy|purchase|pay|checkout|check out|place (your |my |the )?order|order now|complete (order|purchase)|donate|subscribe|upgrade|delete|erase|remove (account|my)|close (my )?account|deactivate|cancel (subscription|membership|plan)|transfer|send money|wire|withdraw|confirm (payment|purchase|order|transfer)|authorize|authorise)\b/i;

/** A click, judged on the element itself. */
export function classifyClick(el: ElementInfo): StepClass {
  const name = el.name.trim();
  if (el.tag === "a" && /^https?:/i.test(el.href) && !el.download) return { tier: "navigate", verb: "follow link", risk: "low" };
  // Opening and closing what is already on the page: a "see more", a disclosure, a tab.
  if (!el.submit && !el.editable && (el.tag === "summary" || el.role === "tab" || (el.expander && !el.inForm) || (!el.inForm && (el.role === "button" || el.role === "link") && EXPAND_WORDS.test(name)))) {
    return { tier: "navigate", verb: "open", risk: "low" };
  }
  const high = HIGH_STAKES.test(name) || /checkout|payment|purchase|\/pay\b/i.test(el.formAction);
  const verb = el.editable ? "click into field" : el.role === "checkbox" || el.role === "radio" || el.role === "switch" ? "tick" : el.submit ? "submit form" : el.download ? "download" : "press";
  return { tier: "act", verb, risk: high ? "high" : "medium" };
}

/** Keys that only move the view. Anything else is acting. */
const VIEW_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", "Escape"]);
export function classifyKey(key: string, focused: Pick<ElementInfo, "editable" | "role"> | null): StepClass {
  if (VIEW_KEYS.has(key) && !(focused?.editable || focused?.role === "combobox")) return { tier: "look", verb: "scroll", risk: "low" };
  return { tier: "act", verb: `press ${key}`, risk: "medium" };
}

export type GateVerdict =
  | { do: "allow"; reason: string }
  | { do: "ask"; risk: Risk; reason: string }
  | { do: "refuse"; reason: string };

/** May this step go ahead now, must the owner be asked, or is it refused? */
export function decideStep(a: { step: StepClass; mode: PermissionMode; site: string | null; settings: Pick<BrowserSettings, "actSites"> }): GateVerdict {
  if (a.step.tier !== "act") return { do: "allow", reason: a.step.tier === "look" ? "Reading" : "Following a link" };
  if (a.mode === "plan") return { do: "refuse", reason: "The agent is still planning, so it may read pages and nothing else. Approve its plan first." };
  if (a.step.risk === "high") return { do: "ask", risk: "high", reason: "This looks like it spends money, or deletes or hands over something. It is confirmed in the app, in every mode." };
  if (a.mode === "auto") {
    return { do: "allow", reason: `Auto mode: the agent acts on ${a.site ?? "this site"} without asking` };
  }
  return { do: "ask", risk: "medium", reason: "Manual mode: every click, keystroke and form in the browser waits for you" };
}

/** Two readings of one reference agree on what it is. Checked again after the owner approved, before acting. */
export function sameElement(a: ElementInfo, b: ElementInfo | null): boolean {
  return !!b && a.tag === b.tag && a.type === b.type && a.name === b.name && a.href === b.href && a.formAction === b.formAction && a.inputName === b.inputName;
}

// ---------------------------------------------------------------- when the owner is needed

const SIGNIN_URL = /\/(log-?in|sign-?in|signin|sign_in|logon|auth|authenticate|sso|oauth2?|checkpoint|challenge|authwall|session\/new|two-?factor|2fa|mfa|verify)(\b|\/|$)|[?&](login|signin)=/i;
const SIGNIN_HOST = /^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|login\.yahoo\.com|auth\.[a-z0-9-]+\.[a-z.]+|login\.[a-z0-9-]+\.[a-z.]+|signin\.[a-z0-9-]+\.[a-z.]+|id\.[a-z0-9-]+\.[a-z.]+)$/i;
const CHALLENGE_TITLE = /^(just a moment|attention required|are you (a )?(human|robot)|verify(ing)? (you are|you're) human|security check|access denied|pardon our interruption|one more step)/i;

/**
 * Does this page want a person? A sign-in wall, a request for a code, or a "prove you are human" check.
 * The agent stops there and the owner is called. A page that merely offers a sign-in box beside its
 * content is not a wall.
 */
export function needsOwnerFor(page: { url: string; title: string }, facts: PageFacts): string | null {
  const site = siteOf(page.url) ?? "this site";
  let u: URL | null = null;
  try {
    u = new URL(page.url);
  } catch {
    // not an address we can read
  }
  const sparse = facts.controls <= 25 && facts.textChars < 2500;
  if (CHALLENGE_TITLE.test(page.title.trim()) || (facts.captcha && facts.controls <= 12 && facts.textChars < 1500)) {
    return `${site} is checking that a person is there`;
  }
  if (facts.otpFields > 0 && sparse) return `${site} is asking for a verification code`;
  if (facts.passwordFields > 0 && ((u && (SIGNIN_URL.test(u.pathname + u.search) || SIGNIN_HOST.test(u.hostname))) || sparse)) return `${site} is asking you to sign in`;
  return null;
}

// ---------------------------------------------------------------- pace

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Is `at` inside the hours agents may browse? A window that crosses midnight ("22:00" to "06:00") is understood. */
export function withinHours(hours: BrowserBudget["hours"], at: Date): boolean {
  if (!hours) return true;
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = at.getHours() * 60 + at.getMinutes();
  const a = mins(hours.start);
  const b = mins(hours.end);
  if (a === b) return true;
  return a < b ? now >= a && now < b : now >= a || now < b;
}

export type PaceVerdict =
  | { ok: true; waitMs: number }
  | { ok: false; reason: string; resetAt: number | null };

/**
 * How many pages agents have loaded on each site, and whether one more is within the owner's allowance.
 * Only page loads an agent caused are counted; what the owner does by hand is not.
 */
export class BudgetLedger {
  private loads = new Map<string, number[]>();

  constructor(initial?: Record<string, number[]>) {
    for (const [site, times] of Object.entries(initial ?? {})) if (Array.isArray(times)) this.loads.set(site, times.filter((t) => Number.isFinite(t)));
  }

  private recent(site: string, now: number): number[] {
    const list = (this.loads.get(site) ?? []).filter((t) => t > now - DAY);
    if (list.length) this.loads.set(site, list);
    else this.loads.delete(site);
    return list;
  }

  record(site: string, at: number) {
    this.loads.set(site, [...this.recent(site, at), at]);
  }

  usage(site: string, now: number, budget: BrowserBudget): { usedHour: number; usedDay: number; nextAt: number | null } {
    const list = this.recent(site, now);
    const last = list.at(-1);
    const nextAt = last != null && last + budget.minGapSec * 1000 > now ? last + budget.minGapSec * 1000 : null;
    return { usedHour: list.filter((t) => t > now - HOUR).length, usedDay: list.length, nextAt };
  }

  /** May an agent load one more page on this site now? `waitMs` is the pause before it, so loads are never closer than the gap. */
  check(site: string, now: number, budget: BrowserBudget): PaceVerdict {
    if (!withinHours(budget.hours, new Date(now))) {
      return { ok: false, resetAt: null, reason: `Agents may browse between ${budget.hours!.start} and ${budget.hours!.end}. It is outside those hours now.` };
    }
    const list = this.recent(site, now);
    if (list.length >= budget.pagesPerDay) {
      return { ok: false, resetAt: list[list.length - budget.pagesPerDay] + DAY, reason: `The day's allowance for ${site} is used (${budget.pagesPerDay} pages).` };
    }
    const hour = list.filter((t) => t > now - HOUR);
    if (hour.length >= budget.pagesPerHour) {
      return { ok: false, resetAt: hour[hour.length - budget.pagesPerHour] + HOUR, reason: `The hour's allowance for ${site} is used (${budget.pagesPerHour} pages).` };
    }
    const last = list.at(-1);
    return { ok: true, waitMs: last == null ? 0 : Math.max(0, last + budget.minGapSec * 1000 - now) };
  }

  toJSON(now: number): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const site of [...this.loads.keys()]) {
      const list = this.recent(site, now);
      if (list.length) out[site] = list;
    }
    return out;
  }
}
