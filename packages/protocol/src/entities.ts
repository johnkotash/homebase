import { z } from "zod";
import {
  AgentKind, ApprovalKind, ApprovalStatus, InboxSource, InboxStatus, IntegrationStatus, MessageRole,
  MessageSource, OnlineStatus, PermissionMode, Priority, Risk, RunStatus, SlaState, type EntityName,
} from "./enums";
import { Effort, ModelName } from "./models";
import { AgentImagesStatus, GeneratedImageCard, ImageIssueCard, ImageRoute } from "./images";
import { AgentFolderFacts, FolderList, FolderPath } from "./folders";
import { MAX_ATTACHMENTS, MessageAttachment } from "./attachments";

const ts = z.number().int();
const nts = ts.nullable();
const ns = z.string().nullable();

export const Workspace = z.object({
  id: z.string(), name: z.string(), timezone: z.string(), plan: z.string(), createdAt: ts,
});
export type Workspace = z.infer<typeof Workspace>;

export const Device = z.object({
  id: z.string(), kind: z.enum(["device", "connector"]), name: z.string(), platform: z.string(),
  canApprove: z.boolean(), lastSeenAt: nts, revokedAt: nts, createdAt: ts, online: z.boolean().optional(),
});
export type Device = z.infer<typeof Device>;

export const Connector = z.object({
  id: z.string(), name: z.string(), host: z.object({ name: z.string(), os: z.string() }).nullable(),
  status: OnlineStatus, lastSeenAt: nts,
});
export type Connector = z.infer<typeof Connector>;

export const AgentWorkspace = z.object({ label: z.string(), cwd: z.string() });

/**
 * What a connector knows about how its agent authenticates. Facts only: never a token, an email
 * address or anything read from a credential file.
 */
export const AgentAuthProof = z.object({
  authMode: z.enum(["subscription", "api_key"]),
  cliVersion: z.string().nullable(),
  /** `apiKeySource` from the CLI's own init message on the last run. "none" means no API key was in use. */
  apiKeySource: z.string().nullable(),
  model: z.string().nullable(),
  /** True when the connector removes API-key and endpoint variables from the agent's environment. */
  envStripped: z.boolean(),
  /** Which variable patterns are removed. Names only. */
  strippedPatterns: z.array(z.string()),
  /** How many such variables were actually present in the connector's environment at the last check. */
  strippedCount: z.number().int().nonnegative(),
  loggedIn: z.boolean().nullable(),
  checkedAt: z.number().int(),
  lastRunAt: z.number().int().nullable(),
});
export type AgentAuthProof = z.infer<typeof AgentAuthProof>;

/**
 * What a connector reports about an agent's Gmail connection. Facts only: the account address and
 * the granted scope names. Never a token, a client secret or mail content.
 */
export const AgentGmailStatus = z.object({
  connected: z.boolean(),
  account: z.string().max(320).nullable(),
  /** Granted OAuth scopes, short names ("gmail.readonly", "gmail.compose"). */
  scopes: z.array(z.string().max(100)).max(10),
  lastPollAt: z.number().int().nullable(),
  lastPollError: z.string().max(300).nullable(),
  sendCapPerHour: z.number().int().nonnegative(),
  sendsLastHour: z.number().int().nonnegative(),
  checkedAt: z.number().int(),
});
export type AgentGmailStatus = z.infer<typeof AgentGmailStatus>;

/**
 * What a connector reports about the Obsidian vault its Notes agent keeps (NOTES-PLAN.md 7.2).
 * Facts only: counts, times and flags. Never note text.
 */
export const AgentVaultStatus = z.object({
  /** The vault root on the connector machine. */
  path: z.string().max(500),
  /** Indexed notes. */
  files: z.number().int().nonnegative(),
  branch: z.string().max(200).nullable().optional(),
  head: z.string().max(64).nullable().optional(),
  lastCommitAt: z.number().int().nullable(),
  lastPushAt: z.number().int().nullable(),
  pushError: z.string().max(300).nullable(),
  /** Commits not on the remote yet. */
  unpushed: z.number().int().nonnegative().optional(),
  externalChanges: z.object({ lastSweepAt: z.number().int().nullable(), files: z.number().int().nonnegative() }),
  /** True after an agent commit removed lines; agent writes stay off until the owner looks. */
  writesSuspended: z.boolean(),
  /** True when the remote has commits this machine does not. Pushing is stopped; nothing is merged. */
  diverged: z.boolean(),
  /** Client names and aliases from Clients.md, as hints for the phone's speech recognizer. */
  hints: z.array(z.string().max(80)).max(300).optional(),
  /** The owner's time zone, used for "today". */
  tz: z.string().max(60).optional(),
  checkedAt: z.number().int(),
});
export type AgentVaultStatus = z.infer<typeof AgentVaultStatus>;
export const Agent = z.object({
  id: z.string(), connectorId: ns, key: z.string(), name: z.string(), kind: AgentKind,
  description: z.string(), capabilities: z.array(z.string()), workspaces: z.array(AgentWorkspace),
  permissionProfile: z.string(), status: OnlineStatus, updatedAt: ts,
  /** Why the agent cannot run right now (for example its CLI is logged out). Null when it is ready. */
  statusNote: ns.optional(),
  /** Permission modes this agent supports. Empty or missing: the agent has no modes. */
  modes: z.array(PermissionMode).nullable().optional(),
  /** The mode a new chat with this agent starts in. Set by the owner, kept by the hub. */
  defaultMode: PermissionMode.nullable().optional(),
  auth: AgentAuthProof.nullable().optional(),
  /** Gmail connection facts for an agent that works in a mailbox. Null or missing: no Gmail. */
  gmail: AgentGmailStatus.nullable().optional(),
  /** Vault facts for the Notes agent. Null or missing: no vault. */
  vault: AgentVaultStatus.nullable().optional(),
  /** Models and efforts the connector lets this agent run. Empty or missing: they do not apply (a scripted agent). */
  models: z.array(ModelName).max(40).nullable().optional(),
  efforts: z.array(Effort).nullable().optional(),
  /** What the connector itself is configured with: used when nothing below is set, as before model choice existed. */
  configModel: ModelName.nullable().optional(),
  configEffort: Effort.nullable().optional(),
  /** The owner's default for this agent. Kept by the hub. Null: the connector's own setting. */
  defaultModel: ModelName.nullable().optional(),
  defaultEffort: Effort.nullable().optional(),
  /** What the connector can do about images for this agent, and how its OpenAI sign-in stands. Null or missing: no image tools. */
  images: AgentImagesStatus.nullable().optional(),
  /** Folders on the connector's machine: what is approved there and where the app may browse. Null or missing: this agent takes no folders. */
  folders: AgentFolderFacts.nullable().optional(),
  /** The owner's defaults for this agent, kept by the hub: where its sessions start, and extra folders every session gets. */
  defaultCwd: FolderPath.nullable().optional(),
  defaultFolders: FolderList.nullable().optional(),
});
export type Agent = z.infer<typeof Agent>;

export const Thread = z.object({
  id: z.string(), title: z.string(), agentId: ns, lastMessageAt: nts, pinned: z.boolean(),
  archived: z.boolean(), createdBy: ns, createdAt: ts, updatedAt: ts,
  /** Per-chat override of the agent's default mode. Null: follow the agent. */
  mode: PermissionMode.nullable().optional(),
  /** The project this session is filed in. Null or missing: Unsorted. */
  projectId: ns.optional(),
  /** The owner's own "where I left off" note. */
  note: z.string().max(4000).nullable().optional(),
  /** Kept by the hub: a short plain-text digest of the last thing the agent said (or why its run failed). */
  summary: z.string().max(600).nullable().optional(),
  /** A recap the agent wrote when the owner asked for one, and when. */
  recap: z.string().max(4000).nullable().optional(),
  recapAt: nts.optional(),
  /** The run that is writing a recap right now. Null when none is. */
  recapRunId: ns.optional(),
  /** Kept by the hub: the status of this session's newest run. Null: it never ran. */
  lastRunStatus: RunStatus.nullable().optional(),
  /** Kept by the hub: when the agent last put something in this session (a reply, a card, a failed run). Null: never. */
  lastAgentAt: nts.optional(),
  /** Up to when the owner has seen the agent's output, on any device. Unread: lastAgentAt is later than this. */
  readAt: nts.optional(),
  /** This session's own model and effort. Null or missing: follow the agent's default. */
  model: ModelName.nullable().optional(),
  effort: Effort.nullable().optional(),
  /** When the owner chose to start a fresh agent session here. Runs before it are not resumed. */
  sessionResetAt: nts.optional(),
  /** Who makes this session's images. Null or missing: follow the project, else Auto. */
  imageRoute: ImageRoute.nullable().optional(),
  /** The session's primary folder (its agent's working directory). Null or missing: not started yet, so the project's or the agent's applies. */
  cwd: FolderPath.nullable().optional(),
  /** Extra folders of this session only, next to what its project and its agent give it. */
  folders: FolderList.nullable().optional(),
});
export type Thread = z.infer<typeof Thread>;

/**
 * A project is a folder for sessions and a one-tap destination: its sessions, the agents that work
 * in it and what happened recently. A session with no project is in Unsorted.
 */
export const Project = z.object({
  id: z.string(), name: z.string().min(1).max(80), description: z.string().max(2000).nullable(),
  /** The agent a new session in this project starts with. Null: ask. */
  defaultAgentId: ns,
  /** The working directory a new session starts in: one of the default agent's workspaces. Null: the agent's own default. */
  defaultCwd: z.string().max(1000).nullable(),
  pinned: z.boolean(), archived: z.boolean(), createdAt: ts, updatedAt: ts,
  /** Who makes images in this project's sessions, unless a session says otherwise. Null or missing: Auto. */
  imageRoute: ImageRoute.nullable().optional(),
  /** Extra folders every session in this project gets, next to the primary folder (`defaultCwd`). */
  folders: FolderList.nullable().optional(),
});
export type Project = z.infer<typeof Project>;

/** A draft or sent email, shown as a card in the chat. */
export const GmailCard = z.object({
  type: z.enum(["gmail_draft", "gmail_sent"]),
  draftId: z.string().max(200).nullable(), threadId: z.string().max(200).nullable(),
  to: z.array(z.string().max(320)).max(100), cc: z.array(z.string().max(320)).max(100), bcc: z.array(z.string().max(320)).max(100),
  subject: z.string().max(1000), body: z.string().max(100000),
  /** True when an existing draft was changed, false when a new one was created. */
  updated: z.boolean().optional(),
});
export type GmailCard = z.infer<typeof GmailCard>;

/** What a dictation wrote to the vault: files, the bullets exactly as on disk, the transcript and flags (NOTES-PLAN.md 6.2). */
export const VaultCaptureCard = z.object({
  type: z.literal("vault_capture"),
  /** The day the bullets were filed under, YYYYMMDD in the owner's time zone. */
  date: z.string().regex(/^\d{8}$/),
  files: z.array(z.object({
    path: z.string().max(500), status: z.enum(["created", "appended"]), bullets: z.array(z.string().max(4000)).max(100),
  })).max(40),
  transcriptPath: z.string().max(500).nullable(),
  flags: z.array(z.string().max(500)).max(50),
  commit: z.string().max(64).nullable().optional(),
});
export type VaultCaptureCard = z.infer<typeof VaultCaptureCard>;

/**
 * A line in a session where what runs changed: another model or effort with the conversation kept
 * ("switch"), or a new agent session that does not see what came before ("fresh"). It rides on a
 * system message, so the change is never silent.
 */
export const SessionMarkerCard = z.object({
  type: z.literal("session_marker"), kind: z.enum(["switch", "fresh", "folders"]),
  model: ModelName.nullable(), effort: Effort.nullable(),
  /** For a fresh agent session that also moved: the folder it works in from here on. */
  cwd: FolderPath.nullable().optional(),
});
export type SessionMarkerCard = z.infer<typeof SessionMarkerCard>;

/** A structured result shown as a card in the chat. `text` on the message carries the same content for older clients. */
export const MessageCard = z.union([GmailCard, VaultCaptureCard, SessionMarkerCard, GeneratedImageCard, ImageIssueCard]);
export type MessageCard = z.infer<typeof MessageCard>;

export const Message = z.object({
  id: z.string(), threadId: z.string(), role: MessageRole, text: z.string(), source: MessageSource,
  runId: ns, authorDeviceId: ns, createdAt: ts,
  card: MessageCard.nullable().optional(),
  /** Pictures the owner attached (attachments.ts). The bytes live on the hub, fetched by id. Null or missing: none. */
  attachments: z.array(MessageAttachment).max(MAX_ATTACHMENTS).nullable().optional(),
});
export type Message = z.infer<typeof Message>;

export const Run = z.object({
  id: z.string(), agentId: z.string(), threadId: ns, prompt: z.string(), status: RunStatus,
  sessionRef: ns, summary: ns, error: ns, costUsd: z.number().nullable(), numTurns: z.number().nullable(),
  durationMs: z.number().nullable(), lastEventIdx: z.number().int(), startedBy: ns, cwd: ns,
  createdAt: ts, startedAt: nts, endedAt: nts, updatedAt: ts,
  /** The permission mode the run is in now. A plan run moves to manual or auto when its plan is approved. */
  mode: PermissionMode.nullable().optional(),
  /** The model the run was asked to use. Null: the connector's setting. What the CLI then reports is on the run's timeline. */
  model: ModelName.nullable().optional(),
  /** The effort the run was asked to use. Null: the CLI's own default. */
  effort: Effort.nullable().optional(),
  /** The extra folders the run was given, next to `cwd`. Null or missing: none (or a run from before folders existed). */
  folders: FolderList.nullable().optional(),
});
export type Run = z.infer<typeof Run>;

export const QuestionOption = z.object({ label: z.string(), description: z.string().optional() });
export const Question = z.object({
  question: z.string(), header: z.string().optional(), multiSelect: z.boolean().optional(),
  options: z.array(QuestionOption).min(2).max(4),
});
export type Question = z.infer<typeof Question>;

export const Approval = z.object({
  id: z.string(), runId: z.string(), agentId: ns, kind: ApprovalKind, tool: ns, title: z.string(),
  summary: ns, input: z.unknown().nullable(), questions: z.array(Question).nullable(), risk: Risk,
  reason: ns, status: ApprovalStatus, decisionMessage: ns, answers: z.record(z.string(), z.string()).nullable(),
  decidedBy: ns, requestedAt: ts, decidedAt: nts,
  /** The run's mode when this was asked. For a decided plan: the mode it was approved into. */
  mode: PermissionMode.nullable().optional(),
});
export type Approval = z.infer<typeof Approval>;

export const InboxItem = z.object({
  id: z.string(), source: InboxSource, externalId: ns, externalUrl: ns, title: z.string(), snippet: ns,
  body: ns, sender: ns, clientLabel: ns, priority: Priority, status: InboxStatus, triageReason: ns,
  assignedAgentId: ns, linkedThreadId: ns, linkedRunId: ns, slaPolicyId: ns, slaDueAt: nts, slaWarnAt: nts,
  slaState: SlaState, respondedAt: nts, snoozeUntil: nts, receivedAt: ts, createdAt: ts, updatedAt: ts,
});
export type InboxItem = z.infer<typeof InboxItem>;

export const Note = z.object({
  id: z.string(), title: z.string(), body: z.string(), tags: z.array(z.string()), rev: z.number().int(),
  source: z.enum(["text", "voice"]), vaultPath: ns, createdAt: ts, updatedAt: ts,
});
export type Note = z.infer<typeof Note>;

/** One note in the vault: metadata only. Bodies are fetched on request and never rest in the hub (NOTES-PLAN.md 7.2). */
export const VaultFile = z.object({
  id: z.string(), path: z.string().max(1000), title: z.string().max(500), type: z.string().max(60).nullable(),
  tags: z.array(z.string().max(100)).max(100), summary: z.string().max(1000).nullable(), mtime: ts, size: z.number().int().nonnegative(),
  hash: z.string().max(64), folder: z.string().max(1000),
});
export type VaultFile = z.infer<typeof VaultFile>;

export const Integration = z.object({
  id: z.string(), kind: z.string(), name: z.string(), status: IntegrationStatus,
  config: z.record(z.string(), z.unknown()).nullable(), lastSyncAt: nts, error: ns,
});
export type Integration = z.infer<typeof Integration>;

export const BusinessCalendar = z.object({
  tz: z.string(), days: z.array(z.number().int().min(0).max(6)), start: z.string().regex(/^\d\d:\d\d$/),
  end: z.string().regex(/^\d\d:\d\d$/), holidays: z.array(z.string()),
});
export type BusinessCalendar = z.infer<typeof BusinessCalendar>;

export const SlaPolicy = z.object({
  id: z.string(), name: z.string(),
  match: z.object({ source: InboxSource.optional(), priority: Priority.optional(), clientLabel: z.string().optional() }),
  respondWithinMinutes: z.number().int().positive(), warnAtPct: z.number().min(1).max(100),
  calendar: BusinessCalendar, isDefault: z.boolean(), updatedAt: ts,
});
export type SlaPolicy = z.infer<typeof SlaPolicy>;

export const Setting = z.object({ id: z.string(), value: z.unknown(), updatedAt: ts });
export type Setting = z.infer<typeof Setting>;

export const ENTITY_SCHEMAS = {
  workspace: Workspace, devices: Device, connectors: Connector, agents: Agent, threads: Thread,
  messages: Message, runs: Run, approvals: Approval, inbox_items: InboxItem, notes: Note,
  integrations: Integration, sla_policies: SlaPolicy, settings: Setting, vault_files: VaultFile, projects: Project,
} satisfies Record<EntityName, z.ZodType>;

export interface EntityTypes {
  workspace: Workspace; devices: Device; connectors: Connector; agents: Agent; threads: Thread;
  messages: Message; runs: Run; approvals: Approval; inbox_items: InboxItem; notes: Note;
  integrations: Integration; sla_policies: SlaPolicy; settings: Setting; vault_files: VaultFile; projects: Project;
}

export const RunEvent = z.object({
  runId: z.string(), idx: z.number().int().nonnegative(), at: ts,
  kind: z.enum(["text", "text_delta", "thinking", "tool_call", "tool_result", "system", "error", "result"]),
  data: z.record(z.string(), z.unknown()),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const Notification = z.object({
  id: z.string(), priority: Priority, channel: z.enum(["approvals", "p0_urgent", "p1_today", "agent_updates", "digest"]),
  title: z.string(), body: z.string(), link: z.string().nullable().optional(),
  actions: z.array(z.string()).optional(), collapseKey: z.string().optional(),
});
export type Notification = z.infer<typeof Notification>;
