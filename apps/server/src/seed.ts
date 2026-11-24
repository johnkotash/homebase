import { newId, type Agent, type BusinessCalendar } from "@homebase/protocol";
import type { WorkspaceHub } from "./hub/WorkspaceHub";
import type { InboxItemDraft } from "./ingest/triage";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Senders whose mail is never urgent, whoever they are. */
const DEFAULT_MUTED = ["noreply@", "no-reply@", "newsletter@", "digest@"];
/** The invented clients the demo treats as priority senders. `npm run remove-demo` drops every `.example` entry. */
export const DEMO_VIP_SENDERS = ["harborpinerealty.example", "northwindsupply.example"];

export interface SeedOptions {
  /**
   * true also fills the new workspace with invented demo content (simulated integrations, mock agents, sessions,
   * runs, approvals, inbox items, notes) for screenshots and trying the app. Default false: an empty workspace.
   * HOMEBASE_DEMO=1 turns it on for the hub. `npm run remove-demo` takes it out of an existing database again.
   */
  demo?: boolean;
  timezone?: string;
  /** The workspace's name on first start (HOMEBASE_WORKSPACE_NAME). Default "HomeBase". */
  workspaceName?: string;
}

/**
 * Creates the workspace on first start: the owner, the SLA policies and neutral settings, and nothing else unless
 * `demo` is set. Idempotent: does nothing when a workspace already exists.
 */
export function seed(hub: WorkspaceHub, opts: SeedOptions = {}): boolean {
  if (hub.store.get("SELECT id FROM workspaces LIMIT 1")) return false;
  const tz = opts.timezone ?? "America/New_York";
  const now = hub.now();
  const prev = hub.suppressNotifications;
  hub.suppressNotifications = true;
  try {
    hub.commit(null, null, (tx) => {
      const userId = newId("usr");
      const wsId = newId("ws");
      hub.store.run("INSERT INTO users (id, email, display_name, created_at) VALUES (?, NULL, 'Owner', ?)", userId, now);
      tx.upsert("workspace", { id: wsId, name: opts.workspaceName?.trim() || "HomeBase", timezone: tz, plan: "prototype", createdAt: now });
      hub.store.run("UPDATE workspaces SET owner_user_id = ? WHERE id = ?", userId, wsId);
      hub.store.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", wsId, userId, now);

      const business: BusinessCalendar = { tz, days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", holidays: [] };
      tx.upsert("sla_policies", {
        id: newId("sla"), name: "Standard — 1 business day", match: {}, respondWithinMinutes: 480, warnAtPct: 75,
        calendar: business, isDefault: true, updatedAt: now,
      });
      // Faster targets for urgent items: generic, so they are part of every new workspace.
      tx.upsert("sla_policies", {
        id: newId("sla"), name: "P0 — 1 hour, around the clock", match: { priority: "P0" }, respondWithinMinutes: 60, warnAtPct: 50,
        calendar: { tz, days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "24:00", holidays: [] }, isDefault: false, updatedAt: now,
      });
      tx.upsert("sla_policies", {
        id: newId("sla"), name: "P1 — 4 business hours", match: { priority: "P1" }, respondWithinMinutes: 240, warnAtPct: 75,
        calendar: business, isDefault: false, updatedAt: now,
      });

      const settings: Record<string, unknown> = {
        "voice.sendOnRelease": false,
        "voice.readBack": false,
        "notifications.focusWindow": { enabled: false, days: [1, 2, 3, 4, 5], start: "08:00", end: "16:30" },
        "notifications.digestTimes": ["07:30", "12:15", "17:30"],
        "triage.rules": { vipSenders: [], mutedSenders: DEFAULT_MUTED },
      };
      for (const [id, value] of Object.entries(settings)) tx.upsert("settings", { id, value, updatedAt: now });
    });
    if (opts.demo === true) seedDemo(hub);
  } finally {
    hub.suppressNotifications = prev;
  }
  return true;
}

/** Invented content for screenshots and trying the app. Every business, person and address in it is made up. */
function seedDemo(hub: WorkspaceHub) {
  const now = hub.now();
  hub.commit(null, null, (tx) => {
    tx.upsert("settings", { id: "triage.rules", value: { vipSenders: DEMO_VIP_SENDERS, mutedSenders: DEFAULT_MUTED }, updatedAt: now });

    // ----- integrations (all simulated in the prototype) -----
    const integrations: Array<[string, string, Record<string, unknown>]> = [
      ["gmail", "Gmail — hello@ridgelineweb.example", { label: "INBOX", mode: "fixtures" }],
      ["clickup", "ClickUp — Client work", { space: "Client work", mode: "fixtures" }],
      ["monitor", "Form & uptime monitors", { checks: 14, schedule: "weekly + on deploy", mode: "fixtures" }],
      ["resend", "Resend — transactional email", { domains: 5, mode: "fixtures" }],
      ["calendar", "Google Calendar", { calendar: "primary", mode: "fixtures" }],
    ];
    for (const [kind, name, config] of integrations) {
      tx.upsert("integrations", { id: newId("int"), kind, name, status: "simulated", config, lastSyncAt: now - 7 * MIN, error: null });
    }

    // ----- agents (offline until the connector registers them by key) -----
    const mk = (key: string, name: string, description: string, capabilities: string[], workspaces: Agent["workspaces"]): Agent =>
      tx.upsert("agents", {
        id: newId("agt"), connectorId: null, key, name, kind: "mock", description, capabilities, workspaces,
        permissionProfile: "standard", status: "offline", updatedAt: now,
      });
    const dev = mk("dev", "Dev agent", "Works in client repos: fixes, small features, deploys behind approval.",
      ["code", "shell", "git", "mcp:clickup"], [
        { label: "harbor-pine-site", cwd: "/srv/repos/harbor-pine-site" },
        { label: "northwind-storefront", cwd: "/srv/repos/northwind-storefront" },
        { label: "hilltop-inspections", cwd: "/srv/repos/hilltop-inspections" },
      ]);
    const ops = mk("ops", "Site ops agent", "Runs form tests and uptime checks, reads logs, files what it finds.",
      ["monitoring", "http", "logs", "mcp:resend"], [{ label: "monitors", cwd: "/srv/ops/monitors" }]);
    const comms = mk("comms", "Comms agent", "Drafts client replies and ClickUp updates. Never sends without approval.",
      ["email-drafts", "mcp:gmail", "mcp:clickup"], []);

    // ----- threads, messages, runs -----
    const thread = (title: string, agentId: string | null, createdAgo: number, pinned = false) =>
      tx.upsert("threads", {
        id: newId("thr"), title, agentId, lastMessageAt: null, pinned, archived: false, createdBy: null,
        createdAt: now - createdAgo, updatedAt: now - createdAgo,
      });
    const say = (th: { id: string }, role: "user" | "assistant" | "system", text: string, ago: number, runId: string | null = null) => {
      tx.upsert("messages", {
        id: newId("msg"), threadId: th.id, role, text, source: role === "user" ? "text" : "agent", runId, authorDeviceId: null, createdAt: now - ago,
      });
      const cur = tx.get("threads", th.id)!;
      if ((cur.lastMessageAt ?? 0) < now - ago) tx.upsert("threads", { ...cur, lastMessageAt: now - ago, updatedAt: now - ago });
    };
    const run = (
      agent: Agent, th: { id: string } | null, prompt: string, ago: number, durationMs: number, status: "succeeded" | "failed" | "cancelled",
      summary: string | null, error: string | null, events: Array<[string, Record<string, unknown>]>,
    ) => {
      const id = newId("run");
      const startedAt = now - ago;
      tx.upsert("runs", {
        id, agentId: agent.id, threadId: th?.id ?? null, prompt, status, sessionRef: `mock-${id.slice(-8)}`, summary, error, costUsd: 0,
        numTurns: Math.max(1, Math.ceil(events.length / 2)), durationMs, lastEventIdx: events.length - 1, startedBy: null,
        cwd: agent.workspaces[0]?.cwd ?? null, createdAt: startedAt, startedAt, endedAt: startedAt + durationMs, updatedAt: startedAt + durationMs,
      });
      events.forEach(([kind, data], idx) => {
        const at = startedAt + Math.round((durationMs * (idx + 1)) / (events.length + 1));
        hub.store.run("INSERT INTO run_events (run_id, idx, at, kind, data) VALUES (?, ?, ?, ?, ?)", id, idx, at, kind, JSON.stringify(data));
      });
      return id;
    };

    const t1 = thread("Harbor & Pine — contact form 500", dev.id, 26 * HOUR, true);
    const r1 = run(dev, t1, "The contact form on harborpinerealty.example is returning 500. Find the cause and fix it on staging.", 26 * HOUR, 184_000, "succeeded",
      "Fixed the form handler on staging: the mail provider env var was renamed. Added a regression test. PR #42 is open.", null, [
        ["text", { text: "Working on: the contact form 500 on harborpinerealty.example" }],
        ["tool_call", { toolUseId: "toolu_seed01", tool: "Read", title: "Read api/contact.ts", input: { file_path: "api/contact.ts" } }],
        ["tool_result", { toolUseId: "toolu_seed01", output: "export async function POST(req) {\n  const key = process.env.MAIL_API_KEY; // undefined in staging\n  ...", isError: false }],
        ["tool_call", { toolUseId: "toolu_seed02", tool: "Bash", title: "Run tests", input: { command: "npm test -- contact" } }],
        ["tool_result", { toolUseId: "toolu_seed02", output: "PASS api/contact.test.ts (4 tests)\nTests: 4 passed", isError: false }],
        ["text", { text: "Fixed on staging. The mail provider env var was renamed from MAIL_API_KEY to RESEND_API_KEY in last week's deploy and the handler still read the old name. I added a regression test and opened PR #42. Production still needs a deploy." }],
        ["result", { summary: "Fixed the form handler on staging and opened PR #42" }],
      ]);
    say(t1, "user", "The contact form on harborpinerealty.example is returning 500. Find the cause and fix it on staging.", 26 * HOUR, r1);
    say(t1, "assistant", "Working on: the contact form 500 on harborpinerealty.example", 26 * HOUR - 20_000, r1);
    say(t1, "assistant", "Fixed on staging. The mail provider env var was renamed from MAIL_API_KEY to RESEND_API_KEY in last week's deploy and the handler still read the old name. I added a regression test and opened PR #42. Production still needs a deploy.", 26 * HOUR - 184_000, r1);

    const t2 = thread("Weekly form-test sweep", ops.id, 3 * DAY);
    const r2 = run(ops, t2, "Run the weekly synthetic form tests across all client sites and summarise failures.", 5 * HOUR, 96_000, "succeeded",
      "13 of 14 forms passed. Hilltop /book failed: reCAPTCHA token rejected.", null, [
        ["text", { text: "Working on: the weekly synthetic form tests" }],
        ["tool_call", { toolUseId: "toolu_seed03", tool: "Bash", title: "Run form tests", input: { command: "node run-form-tests.mjs --all" } }],
        ["tool_result", { toolUseId: "toolu_seed03", output: "harbor-pine /contact ........ PASS\nnorthwind /wholesale ........ PASS\nhilltop /book .............. FAIL (recaptcha: invalid-input-secret)\n... 11 more PASS", isError: false }],
        ["text", { text: "13 of 14 forms passed. Hilltop Inspections /book failed: the reCAPTCHA secret no longer matches the site key. I filed it in the inbox as P0." }],
        ["result", { summary: "13 of 14 forms passed" }],
      ]);
    say(t2, "user", "Run the weekly synthetic form tests across all client sites and summarise failures.", 5 * HOUR, r2);
    say(t2, "assistant", "13 of 14 forms passed. Hilltop Inspections /book failed: the reCAPTCHA secret no longer matches the site key. I filed it in the inbox as P0.", 5 * HOUR - 96_000, r2);

    const t3 = thread("Lead replies — drafts", comms.id, 2 * DAY);
    const r3 = run(comms, t3, "Draft a reply to the Northside Dental quote request. Friendly, two short paragraphs, propose a call Thursday.", 3 * HOUR, 41_000, "succeeded",
      "Drafted a reply to Dr. Raman proposing a Thursday call.", null, [
        ["text", { text: "Working on: a reply to the Northside Dental quote request" }],
        ["tool_call", { toolUseId: "toolu_seed04", tool: "Read", title: "Read the email thread", input: { thread: "quote-northside" } }],
        ["tool_result", { toolUseId: "toolu_seed04", output: "From: Priya Raman\nSubject: Quote request: redesign for a 3-location dental practice", isError: false }],
        ["text", { text: "Draft:\n\nHi Dr. Raman,\n\nThanks for reaching out, and thank Dana for the introduction. A redesign with online booking across three locations is squarely what we do.\n\nCould we talk for 20 minutes on Thursday? I can send a proposal the day after. Any time between 12:00 and 1:00 or after 5:30 works.\n\nI have not sent this. Say \"send it\" and I will ask for approval." }],
        ["result", { summary: "Drafted a reply" }],
      ]);
    say(t3, "user", "Draft a reply to the Northside Dental quote request. Friendly, two short paragraphs, propose a call Thursday.", 3 * HOUR, r3);
    say(t3, "assistant", "Draft:\n\nHi Dr. Raman,\n\nThanks for reaching out, and thank Dana for the introduction. A redesign with online booking across three locations is squarely what we do.\n\nCould we talk for 20 minutes on Thursday? I can send a proposal the day after. Any time between 12:00 and 1:00 or after 5:30 works.\n\nI have not sent this. Say \"send it\" and I will ask for approval.", 3 * HOUR - 41_000, r3);

    const t4 = thread("Northwind — double tax at checkout", dev.id, 9 * HOUR);
    const r4 = run(dev, t4, "Investigate why checkout applies sales tax twice on northwindsupply.example. Do not change anything yet.", 8 * HOUR, 132_000, "failed",
      null, "Could not reach the staging database: connection refused (tunnel down).", [
        ["text", { text: "Working on: the double sales tax at checkout" }],
        ["tool_call", { toolUseId: "toolu_seed05", tool: "Bash", title: "Query staging orders", input: { command: "psql $STAGING_DB -c 'select id, tax_total from orders order by id desc limit 5'" } }],
        ["tool_result", { toolUseId: "toolu_seed05", output: "psql: error: connection to server failed: Connection refused", isError: true }],
        ["error", { message: "Could not reach the staging database: connection refused (tunnel down)." }],
      ]);
    say(t4, "user", "Investigate why checkout applies sales tax twice on northwindsupply.example. Do not change anything yet.", 8 * HOUR, r4);
    say(t4, "system", "Run failed: Could not reach the staging database: connection refused (tunnel down).", 8 * HOUR - 132_000, r4);

    const t5 = thread("Scratchpad", null, 6 * DAY);
    say(t5, "user", "Reminder to self: ask Marcus for the new product feed API key.", 2 * DAY);
    say(t5, "user", "Idea: client-facing status page that shows form-test history.", 30 * HOUR);

    // ----- projects: folders for sessions. Anything not filed stays in Unsorted -----
    const project = (name: string, description: string, agent: Agent, cwd: string, pinned: boolean, ago: number, sessions: Array<{ id: string }>) => {
      const p = tx.upsert("projects", {
        id: newId("prj"), name, description, defaultAgentId: agent.id, defaultCwd: cwd, pinned, archived: false, createdAt: now - ago, updatedAt: now - ago,
      });
      for (const s of sessions) tx.patch("threads", s.id, { projectId: p.id });
      return p;
    };
    project("Harbor & Pine Realty", "Client site: listings, the contact form and the homepage hero.", dev, "/srv/repos/harbor-pine-site", true, 20 * DAY, [t1]);
    project("Northwind Supply", "Storefront and checkout for northwindsupply.example.", dev, "/srv/repos/northwind-storefront", false, 12 * DAY, [t4]);
    tx.patch("threads", t4.id, { note: "Blocked on the staging tunnel. Reopen it, then ask for the tax query again before touching checkout." });

    // ----- approval history -----
    const apr = (runId: string, agent: Agent, title: string, tool: string, input: unknown, risk: "low" | "medium" | "high", status: "approved" | "denied", ago: number, message: string | null, reason: string) => {
      const id = newId("apr");
      tx.upsert("approvals", {
        id, runId, agentId: agent.id, kind: "tool", tool, title, summary: typeof (input as any)?.command === "string" ? (input as any).command : title,
        input, questions: null, risk, reason, status, decisionMessage: message, answers: null, decidedBy: null,
        requestedAt: now - ago, decidedAt: now - ago + 4 * MIN,
      });
      hub.store.run(
        "INSERT INTO audit_log (id, at, actor_id, action, subject_type, subject_id, detail) VALUES (?, ?, NULL, 'approval.decide', 'approval', ?, ?)",
        newId("aud"), now - ago + 4 * MIN, id, JSON.stringify({ decision: status === "approved" ? "approve" : "deny", risk, runId, title, seeded: true }),
      );
    };
    apr(r1, dev, "Push branch fix/contact-env to origin", "Bash", { command: "git push origin fix/contact-env" }, "medium", "approved", 26 * HOUR - 150_000, null, "Matches rule: git push");
    apr(r3, comms, "Send email to priya@northsidedental.example", "send_email", { to: "priya@northsidedental.example", subject: "Re: Quote request" }, "medium", "denied", 3 * HOUR - 30_000, "Not yet. I want to reread it tonight.", "Matches rule: outbound email to a client");

    // ----- notes -----
    const note = (title: string, body: string, tags: string[], ago: number, source: "text" | "voice" = "text") =>
      tx.upsert("notes", { id: newId("note"), title, body, tags, rev: 1, source, vaultPath: null, createdAt: now - ago, updatedAt: now - ago });
    note("Northside Dental — discovery call prep",
      "## Goals\n- Three locations, one booking flow\n- Replace the 2018 WordPress theme\n\n## Questions\n- Who owns the booking system contract?\n- Do they need per-location hours and providers?\n- Budget range and decision date (end of month?)\n\n## Pricing sketch\n- Design + build: fixed\n- Care plan: monthly, includes form monitoring",
      ["sales", "northside"], 4 * HOUR);
    note("Client SLA promises",
      "Standard: respond within **1 business day**.\n\nProduction down or a broken lead form: acknowledge within **1 hour**, any day.\n\nInvoices and scope questions: same day when they arrive before 3 PM.",
      ["ops"], 5 * DAY);
    note("Voice memo: retainer idea", "Offer a quarterly \"site health\" report to every care-plan client. Pull uptime, form-test history and Core Web Vitals. Agents can draft it; I approve and send.",
      ["ideas"], 28 * HOUR, "voice");
    note("Deploy checklist (client sites)",
      "1. Tests green on staging\n2. Form test passes on staging\n3. Tag the release\n4. Deploy production (needs approval)\n5. Form test on production\n6. Note the deploy in ClickUp",
      ["ops", "checklist"], 9 * DAY);
  });

  // ----- inbox: run fixtures through the real triage + SLA pipeline at varied ages -----
  const items: Array<[InboxItemDraft, number, ("triaged" | "responded" | "done" | "in_progress")?]> = [
    [{ source: "monitor", externalId: "seed-mon-1", title: "Form check FAILED: hilltopinspections.example /book", snippet: "reCAPTCHA token rejected; booking request never reached the inbox.", body: "Synthetic booking request did not arrive in the monitoring inbox within 5 minutes.\n\nSite: hilltopinspections.example\nForm: /book\nLikely cause: reCAPTCHA secret mismatch after key rotation.\n\nFiled by the Site ops agent during the weekly sweep.", sender: "Form monitor", clientLabel: "Hilltop Inspections", meta: { state: "failed" }, externalUrl: "https://monitor.example/checks/hilltop-book" }, 38 * MIN],
    [{ source: "gmail", externalId: "seed-gm-1", title: "URGENT: checkout is charging tax twice", snippet: "Two customers emailed screenshots this morning. Please look ASAP.", body: "Two customers emailed screenshots this morning showing sales tax applied twice at checkout. We've paused the promo email. Please look ASAP.\n\nRenee\nNorthwind Supply Co", sender: "Renee Okafor <renee@northwindsupply.example>", clientLabel: "Northwind Supply Co", externalUrl: "https://mail.example/thread/double-tax" }, 9 * HOUR, "in_progress"],
    [{ source: "gmail", externalId: "seed-gm-2", title: "Quote request: redesign for a 3-location dental practice", snippet: "We found you through Harbor & Pine. Could you send a proposal this week?", body: "Hi,\n\nWe run Northside Dental (three offices) and our site is about eight years old. Harbor & Pine recommended you.\n\nCould you send a proposal for a redesign with online booking? We'd like to decide by the end of the month.\n\nThanks,\nDr. Priya Raman", sender: "Priya Raman <priya@northsidedental.example>", clientLabel: "Northside Dental (lead)", externalUrl: "https://mail.example/thread/quote-northside" }, 3 * HOUR + 20 * MIN],
    [{ source: "gmail", externalId: "seed-gm-3", title: "Re: October invoice — can we split it?", snippet: "Cash is tight until the 15th. Could we pay half now and half mid-month?", body: "Hey,\n\nGot the October invoice (#1047, $2,400). Cash is tight until the 15th. Could we pay half now and the other half mid-month?\n\nMarcus\nLakeside Outfitters", sender: "Marcus Bell <marcus@lakesideoutfitters.example>", clientLabel: "Lakeside Outfitters", externalUrl: "https://mail.example/thread/invoice-1047" }, 70 * MIN],
    [{ source: "clickup", externalId: "seed-cu-1", title: "Task moved to Review: Hilltop — booking form v2", snippet: "Contractor marked the task ready for review. 3 checklist items open.", body: "List: Client work / Hilltop Inspections\nTask: Booking form v2\nStatus: In progress → Review\nAssignee: contractor (Jo)\nChecklist: 5 of 8 done\n\nComment: \"Ready for a look. Validation on the date picker still needs your call.\"", sender: "ClickUp", clientLabel: "Hilltop Inspections", externalUrl: "https://tasks.example/t/86c2x1" }, 2 * HOUR],
    [{ source: "clickup", externalId: "seed-cu-2", title: "Comment on: Lakeside — product feed sync", snippet: "\"Feed is blocked until we get the new API key from the client.\"", body: "List: Client work / Lakeside Outfitters\nTask: Product feed sync\nNew comment from Jo: \"Feed is blocked until we get the new API key from the client. Can you ask Marcus?\"", sender: "ClickUp", clientLabel: "Lakeside Outfitters", externalUrl: "https://tasks.example/t/86c2x7" }, 22 * HOUR, "triaged"],
    [{ source: "gmail", externalId: "seed-gm-4", title: "Can you swap the hero photo before the open house?", snippet: "New drone shots attached. No rush, sometime this week is fine.", body: "Hi! New drone shots are in the shared folder. Could you swap the homepage hero for shot 4? No rush, sometime this week is fine.\n\nDana\nHarbor & Pine Realty", sender: "Dana Whitfield <dana@harborpinerealty.example>", clientLabel: "Harbor & Pine Realty", externalUrl: "https://mail.example/thread/hero-swap" }, 5 * HOUR],
    [{ source: "resend", externalId: "seed-rs-1", title: "Bounce: lead notification to dana@harborpinerealty.example", snippet: "Hard bounce (mailbox full). 1 contact-form notification was not delivered.", body: "Event: email.bounced\nType: hard bounce — mailbox full\nFrom: forms@harborpinerealty.example\nTo: dana@harborpinerealty.example\nSubject: New contact form submission\n\nThe lead was stored but the client was not notified.", sender: "Resend", clientLabel: "Harbor & Pine Realty", externalUrl: "https://email.example/emails/re_8f1c" }, 6 * HOUR],
    [{ source: "calendar", externalId: "seed-cal-1", title: "Tomorrow 12:15 — Hilltop Inspections check-in (30 min)", snippet: "Overlaps your lunch block. Agenda: booking form v2 sign-off.", body: "Event: Hilltop Inspections check-in\nWhen: tomorrow 12:15–12:45\nWhere: video call\nAgenda: booking form v2 sign-off, December retainer.", sender: "Google Calendar", clientLabel: "Hilltop Inspections", externalUrl: "https://calendar.example/event/lv-checkin" }, 4 * HOUR],
    [{ source: "monitor", externalId: "seed-mon-2", title: "Form check FAILED: harborpinerealty.example /contact", snippet: "Synthetic submission returned HTTP 500 after 2 retries.", body: "Site: harborpinerealty.example\nForm: /contact\nResult: HTTP 500 from /api/contact after 2 retries.\n\nResolved on staging by the Dev agent (PR #42).", sender: "Form monitor", clientLabel: "Harbor & Pine Realty", meta: { state: "failed" }, externalUrl: "https://monitor.example/checks/harbor-pine-contact" }, 27 * HOUR, "responded"],
    [{ source: "gmail", externalId: "seed-gm-5", title: "Thanks for the quick turnaround on the listings page", snippet: "Looks great. Sending two referrals your way.", body: "Looks great, thank you. Sending two referrals your way.\n\nDana", sender: "Dana Whitfield <dana@harborpinerealty.example>", clientLabel: "Harbor & Pine Realty", externalUrl: "https://mail.example/thread/thanks" }, 2 * DAY, "done"],
  ];
  for (const [draft, ago, status] of items) {
    const item = hub.ingest({ ...draft, receivedAt: now - ago });
    if (status) {
      hub.commit(null, null, (tx) => {
        const cur = tx.get("inbox_items", item.id)!;
        const closed = status === "responded" || status === "done";
        tx.upsert("inbox_items", {
          ...cur, status, respondedAt: closed ? now - ago + 50 * MIN : null,
          slaState: closed ? "met" : cur.slaState, updatedAt: now - ago + 50 * MIN,
        });
      });
    }
  }
  hub.tick();
}
