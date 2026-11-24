/** Fixed driving-mode grammar (ARCHITECTURE.md 10.2). An LLM intent router replaces this at MVP. */
export type VoiceCommand =
  | { cmd: "next" } | { cmd: "repeat" } | { cmd: "approve" } | { cmd: "deny" } | { cmd: "snooze" } | { cmd: "stop" }
  | { cmd: "reply"; text: string } | { cmd: "note"; text: string };

const SIMPLE: Array<[RegExp, VoiceCommand["cmd"]]> = [
  [/^(next|skip|next one|go on|continue)$/, "next"],
  [/^(repeat|again|say (that|it) again|read (that|it) again)$/, "repeat"],
  [/^(approve|approved|yes approve|approve it|go ahead)$/, "approve"],
  [/^(deny|denied|reject|deny it|do not approve|don't approve)$/, "deny"],
  [/^(snooze|snooze it|later|remind me later)$/, "snooze"],
  [/^(stop|exit|quit|done|stop driving mode)$/, "stop"],
];

export function parseCommand(transcript: string): VoiceCommand | null {
  const raw = transcript.trim();
  const t = raw.toLowerCase().replace(/[.,!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  for (const [re, cmd] of SIMPLE) if (re.test(t)) return { cmd } as VoiceCommand;
  const m = raw.match(/^\s*(reply|note)[\s,:]+(.+)$/i);
  if (m) {
    const text = m[2].trim();
    if (text) return { cmd: m[1].toLowerCase() as "reply" | "note", text };
  }
  return null;
}
