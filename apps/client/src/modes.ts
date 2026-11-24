import type { Agent, AgentAuthProof, PermissionMode, Thread } from "@homebase/protocol";
import type { IconName } from "./components/ui";

/** The three permission modes, in the words the owner sees everywhere. */
export const MODE: Record<PermissionMode, { label: string; icon: IconName; short: string; body: string }> = {
  manual: {
    label: "Manual", icon: "shield",
    short: "Asks before every write, edit and command.",
    body: "The agent can read. Every file write, edit and shell command waits for your tap.",
  },
  auto: {
    label: "Auto", icon: "zap",
    short: "Works end to end without asking. You take on the risk.",
    body: "Edits files, runs any command, fetches and downloads from the web, and clicks and types in its browser without asking. "
      + "Still off limits in every mode: secret and credential files, the notes vault, and a few destructive commands (wiping a home folder, piping a download into a shell). "
      + "Purchases or deletions in the browser, and sending email, still ask.",
  },
  plan: {
    label: "Plan", icon: "map",
    short: "Researches read-only, then proposes a plan.",
    body: "Nothing is changed while it plans. You get the plan as a card and choose: run it in Auto, run it in Manual, or keep planning.",
  },
};

/** The same two modes in a mailbox agent's terms: it has no files to edit and no shell. */
export const MAIL_MODE: Record<"manual" | "auto", { short: string; body: string }> = {
  manual: {
    short: "Reads mail. Asks before saving a draft. Sending always asks.",
    body: "The agent can search and read mail. It asks before saving each draft. Sending always needs your approval.",
  },
  auto: {
    short: "Saves drafts without asking. Sending still always asks.",
    body: "The agent saves and edits drafts in Gmail without asking. Sending still stops for your approval every time, with the full email shown.",
  },
};

/** The same two modes for the Notes agent, which can only read the vault and add to the daily notes. */
export const NOTES_MODE: Record<"manual" | "auto", { short: string; body: string }> = {
  manual: {
    short: "Reads your notes. Asks before adding anything.",
    body: "The agent can read and search the vault. It asks before each addition and shows the lines it would add.",
  },
  auto: {
    short: "Files dictations and answers from your notes without asking. It can only add.",
    body: "The agent adds to the daily notes without asking. Every addition is one commit you can revert, and nothing is ever changed or removed.",
  },
};
export const NOTES_SECRETS_NOTE = "In every mode the agent has no shell and no web, and it cannot delete, rename, move or rewrite a note.";

/** The words for a mode on one agent: mail wording for an agent that works in a mailbox, vault wording for the Notes agent. */
export function modeWords(mode: PermissionMode, agent?: Pick<Agent, "gmail" | "vault"> | null): { short: string; body: string } {
  if (agent?.vault && mode !== "plan") return NOTES_MODE[mode];
  return agent?.gmail && mode !== "plan" ? MAIL_MODE[mode] : MODE[mode];
}

export const MAIL_SECRETS_NOTE = "In every mode the agent has no shell, cannot write files and cannot delete, label or forward mail.";

export const SECRETS_NOTE = "In every mode, secret files (.env, keys, credential stores) are blocked and cannot be approved.";

export const agentModes = (agent: Pick<Agent, "modes"> | undefined | null): PermissionMode[] => agent?.modes ?? [];

/** The mode the next run in a chat starts in: the chat's own choice, else the agent's default. */
export function effectiveMode(agent: Pick<Agent, "modes" | "defaultMode"> | undefined | null, thread?: Pick<Thread, "mode"> | null): PermissionMode | null {
  const offered = agentModes(agent);
  if (!offered.length) return null;
  for (const m of [thread?.mode, agent?.defaultMode, "manual" as const]) if (m && offered.includes(m)) return m;
  return offered[0];
}

/** The auth view, as label/value facts. Nothing here is, or is derived from, a credential. */
export function authFacts(auth: AgentAuthProof, fmtTime: (ts: number) => string): Array<{ label: string; value: string; note?: string; ok?: boolean }> {
  const subscription = auth.authMode === "subscription";
  const src = auth.apiKeySource;
  return [
    { label: "Auth mode", value: subscription ? "Subscription (Claude Code login)" : "API key", ok: true },
    { label: "Signed in", value: auth.loggedIn == null ? "Not checked yet" : auth.loggedIn ? "Yes" : "No", ok: auth.loggedIn ?? undefined },
    { label: "Claude Code CLI", value: auth.cliVersion ?? "Not found" },
    {
      label: "apiKeySource (last run)", value: src ?? "No run yet",
      note: src == null ? "Reported by the CLI when a run starts. Start one to see it."
        : src === "none" ? "The CLI used no API key on the last run."
        : subscription ? "Unexpected for subscription auth. A run that reports this is stopped." : "The CLI used an API key on the last run.",
      ok: src == null ? undefined : subscription ? src === "none" : true,
    },
    { label: "Model", value: auth.model ?? "Unknown" },
    {
      label: "Environment", value: auth.envStripped ? "Auth variables stripped" : "Not stripped",
      note: `${auth.strippedPatterns.join(", ")} ${auth.strippedPatterns.length === 1 ? "is" : "are"} removed from the agent's environment before every run.`
        + ` ${auth.strippedCount} such variable${auth.strippedCount === 1 ? " was" : "s were"} set on the connector at the last check.`,
      ok: auth.envStripped,
    },
    { label: "Last check", value: fmtTime(auth.checkedAt), note: auth.lastRunAt ? `Last run started ${fmtTime(auth.lastRunAt)}.` : undefined },
  ];
}
