import type { RunEventKind } from "@homebase/protocol";

/**
 * Pure mapping from the Claude Code CLI's `--output-format stream-json` lines to HomeBase run
 * events (ARCHITECTURE.md 6.4). No I/O here, so it is tested against recorded fixture lines.
 */
export type MappedAction =
  | { type: "event"; kind: RunEventKind; data: Record<string, unknown>; persist?: boolean }
  /** `system`/`init`: the CLI session is up. Emitted once per process, and again on every later turn. */
  | { type: "init"; sessionId: string; model: string | null; apiKeySource: string | null; cwd: string | null; tools: string[]; mcpServers: Array<{ name: string; status: string }> }
  /** One user turn finished. `ok: false` carries a readable error. */
  | { type: "result"; ok: boolean; summary: string; error: string | null; sessionId: string | null; costUsd: number | null; numTurns: number | null; durationMs: number | null };

export const MAX_TOOL_OUTPUT = 4096;
const MAX_SUMMARY = 600;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters stay on the connector host)`;
}

/** A short human title for a tool call, shown on the timeline and on approval cards. */
export function toolTitle(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const base = (p: unknown) => (typeof p === "string" ? p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p : "");
  const clip = (s: unknown, n = 60) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : "");
  switch (tool) {
    case "Read": return `Read ${base(o.file_path)}`.trim();
    case "Write": return `Write ${base(o.file_path)}`.trim();
    case "Edit": case "MultiEdit": return `Edit ${base(o.file_path)}`.trim();
    case "NotebookEdit": return `Edit notebook ${base(o.notebook_path)}`.trim();
    case "Glob": return `Find files ${clip(o.pattern, 40)}`.trim();
    case "Grep": return `Search for ${clip(o.pattern, 40)}`.trim();
    case "LS": return `List ${base(o.path) || "directory"}`;
    case "Bash": case "PowerShell": return typeof o.description === "string" && o.description ? clip(o.description) : `Run: ${clip(o.command)}`;
    case "WebFetch": return `Fetch ${clip(o.url)}`;
    case "WebSearch": return `Web search: ${clip(o.query)}`;
    case "TodoWrite": return "Update task list";
    case "ExitPlanMode": return "Propose a plan";
    case "mcp__gmail__gmail_search": return `Search Gmail: ${clip(o.query, 50)}`.trim();
    case "mcp__gmail__gmail_read_thread": return "Read a Gmail thread";
    case "mcp__gmail__gmail_list_drafts": return "List Gmail drafts";
    case "mcp__gmail__gmail_create_draft": return `Save Gmail draft${typeof o.subject === "string" && o.subject ? `: ${clip(o.subject, 50)}` : o.thread_id ? " (reply)" : ""}`;
    case "mcp__gmail__gmail_update_draft": return "Update a Gmail draft";
    case "mcp__gmail__gmail_send_draft": return "Ask to send a Gmail draft";
    default: return tool;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string" ? (b as any).text : b && typeof b === "object" ? `[${(b as any).type ?? "content"}]` : ""))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function resultError(r: any): string {
  const text = typeof r.result === "string" && r.result.trim() ? r.result.trim() : Array.isArray(r.errors) && r.errors.length ? r.errors.map(String).join("; ") : "";
  switch (r.subtype) {
    case "error_max_turns": return `Stopped at the max-turns limit (${r.num_turns ?? "?"} turns). Send a follow-up to continue.`;
    case "error_max_budget_usd": return "Stopped at the budget limit.";
    case "success": return text || "Claude reported an error.";
    default: return text || `Claude stopped: ${String(r.subtype ?? "unknown error").replace(/_/g, " ")}`;
  }
}

export class ClaudeStreamMapper {
  private seenToolUse = new Set<string>();
  private toolNames = new Map<string, string>();
  private warnedLimit = false;

  /** Parses one stdout line. Blank lines and non-JSON noise map to nothing. */
  line(raw: string): MappedAction[] {
    const s = raw.trim();
    if (!s || s[0] !== "{") return [];
    let msg: unknown;
    try {
      msg = JSON.parse(s);
    } catch {
      return [];
    }
    return this.message(msg);
  }

  message(m: any): MappedAction[] {
    if (!m || typeof m !== "object") return [];
    switch (m.type) {
      case "system":
        if (m.subtype !== "init" || typeof m.session_id !== "string") return [];
        return [{
          type: "init", sessionId: m.session_id, model: typeof m.model === "string" ? m.model : null,
          apiKeySource: typeof m.apiKeySource === "string" ? m.apiKeySource : null, cwd: typeof m.cwd === "string" ? m.cwd : null,
          tools: Array.isArray(m.tools) ? m.tools.filter((t: unknown) => typeof t === "string") : [],
          mcpServers: Array.isArray(m.mcp_servers) ? m.mcp_servers.map((x: any) => ({ name: String(x?.name), status: String(x?.status) })) : [],
        }];

      case "stream_event": {
        // Partial output. Only the top-level assistant's text is streamed into the thread.
        if (m.parent_tool_use_id) return [];
        const ev = m.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string" && ev.delta.text) {
          return [{ type: "event", kind: "text_delta", data: { text: ev.delta.text }, persist: false }];
        }
        return [];
      }

      case "assistant": {
        const out: MappedAction[] = [];
        const sub = !!m.parent_tool_use_id;
        for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
            // Subagent chatter stays out of the chat thread; its tool calls still show on the timeline.
            if (!sub) out.push({ type: "event", kind: "text", data: { text: b.text } });
          } else if (b?.type === "tool_use" && typeof b.id === "string") {
            if (this.seenToolUse.has(b.id)) continue;
            this.seenToolUse.add(b.id);
            this.toolNames.set(b.id, String(b.name));
            out.push({ type: "event", kind: "tool_call", data: { toolUseId: b.id, tool: String(b.name), title: toolTitle(String(b.name), b.input), input: b.input ?? {} } });
          }
        }
        return out;
      }

      case "user": {
        const out: MappedAction[] = [];
        const content = m.message?.content;
        for (const b of Array.isArray(content) ? content : []) {
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          out.push({
            type: "event", kind: "tool_result",
            data: { toolUseId: b.tool_use_id, tool: this.toolNames.get(b.tool_use_id) ?? null, output: truncate(toolResultText(b.content), MAX_TOOL_OUTPUT), isError: b.is_error === true },
          });
        }
        return out;
      }

      case "rate_limit_event": {
        const info = m.rate_limit_info;
        if (!info || info.status === "allowed" || this.warnedLimit) return [];
        this.warnedLimit = true;
        const when = typeof info.resetsAt === "number" ? ` It resets at ${new Date(info.resetsAt * 1000).toISOString()}.` : "";
        return [{ type: "event", kind: "system", data: { message: `Usage limit ${info.status === "rejected" ? "reached" : "warning"} (${String(info.rateLimitType ?? "plan").replace(/_/g, " ")}).${when}`, rateLimit: info.status } }];
      }

      case "result": {
        const ok = m.subtype === "success" && m.is_error !== true;
        const text = typeof m.result === "string" ? m.result : "";
        return [{
          type: "result", ok, summary: ok ? truncate(text, MAX_SUMMARY) : "", error: ok ? null : resultError(m),
          sessionId: typeof m.session_id === "string" ? m.session_id : null,
          costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
          numTurns: typeof m.num_turns === "number" ? m.num_turns : null,
          durationMs: typeof m.duration_ms === "number" ? m.duration_ms : null,
        }];
      }
    }
    return [];
  }
}

/** Splits a byte stream into lines, holding back the last partial one. */
export class LineBuffer {
  private rest = "";
  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split(/\r?\n/);
    this.rest = parts.pop() ?? "";
    return parts;
  }
  flush(): string[] {
    const r = this.rest;
    this.rest = "";
    return r ? [r] : [];
  }
}
