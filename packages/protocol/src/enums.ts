import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;

export const Priority = z.enum(["P0", "P1", "P2", "P3"]);
export type Priority = z.infer<typeof Priority>;

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

export const RunStatus = z.enum([
  "queued", "starting", "running", "waiting_approval", "succeeded", "failed", "cancelled", "offline",
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const LIVE_RUN_STATUSES: RunStatus[] = ["queued", "starting", "running", "waiting_approval"];
export const isLiveRun = (s: RunStatus) => LIVE_RUN_STATUSES.includes(s);

export const RunEventKind = z.enum(["text", "text_delta", "thinking", "tool_call", "tool_result", "system", "error", "result"]);
export type RunEventKind = z.infer<typeof RunEventKind>;

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;
export const ApprovalKind = z.enum(["tool", "question", "plan"]);

/**
 * How much an agent may do without asking (ARCHITECTURE.md 9.4).
 * manual: ask for every write, edit and command. auto: work alone inside the workspace, ask for anything risky.
 * plan: research read-only, then propose a plan for the owner to approve.
 */
export const PermissionMode = z.enum(["manual", "auto", "plan"]);
export type PermissionMode = z.infer<typeof PermissionMode>;
export const PERMISSION_MODES: PermissionMode[] = ["manual", "auto", "plan"];
/** The modes a plan can be approved into. */
export const RunMode = z.enum(["manual", "auto"]);
export type RunMode = z.infer<typeof RunMode>;

export const InboxSource = z.enum(["gmail", "clickup", "monitor", "resend", "calendar", "crm", "social", "agent", "manual"]);
export type InboxSource = z.infer<typeof InboxSource>;
export const InboxStatus = z.enum(["new", "triaged", "in_progress", "responded", "done", "snoozed"]);
export type InboxStatus = z.infer<typeof InboxStatus>;
export const SlaState = z.enum(["none", "running", "warning", "breached", "met"]);
export type SlaState = z.infer<typeof SlaState>;

export const AgentKind = z.enum(["claude", "mock", "process", "managed", "webhook"]);
export const OnlineStatus = z.enum(["online", "offline"]);
export const MessageRole = z.enum(["user", "assistant", "system"]);
export const MessageSource = z.enum(["text", "voice", "agent"]);
export const IntegrationStatus = z.enum(["connected", "error", "disabled", "simulated"]);
export const NotifyChannel = z.enum(["approvals", "p0_urgent", "p1_today", "agent_updates", "digest"]);
export type NotifyChannel = z.infer<typeof NotifyChannel>;
export const SimKind = z.enum(["gmail", "clickup", "monitor", "resend", "calendar"]);
export type SimKind = z.infer<typeof SimKind>;

export const ENTITY_NAMES = [
  "workspace", "devices", "connectors", "agents", "threads", "messages", "runs", "approvals",
  "inbox_items", "notes", "integrations", "sla_policies", "settings", "vault_files", "projects",
] as const;
export type EntityName = (typeof ENTITY_NAMES)[number];
export const EntityNameSchema = z.enum(ENTITY_NAMES);
