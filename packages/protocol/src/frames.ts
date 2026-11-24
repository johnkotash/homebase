import { z } from "zod";
import { EntityNameSchema, PermissionMode, Risk, RunMode, RunStatus } from "./enums";
import { AgentAuthProof, AgentGmailStatus, AgentVaultStatus, Notification, Question, RunEvent, VaultFile } from "./entities";
import { Effort, ModelName } from "./models";
import { AgentImagesStatus } from "./images";
import { AgentFolderFacts, FolderOp } from "./folders";
import { MessageAttachment } from "./attachments";
import { BrowserAckFrame, BrowserControlFrame, BrowserInputFrame, BrowserNoticeFrame, BrowserPictureFrame, BrowserStateFrame } from "./browser";

const ClientInfo = z.object({ platform: z.string(), app: z.string(), name: z.string() });

// ---- device → hub ----
export const HelloFrame = z.object({
  t: z.literal("hello"), v: z.literal(1), token: z.string().min(8), role: z.enum(["device", "connector"]),
  lastSeq: z.number().int().nonnegative().optional(), schema: z.number().int().optional(), client: ClientInfo.optional(),
});
export const MutateFrame = z.object({ t: z.literal("mutate"), id: z.string().min(1), name: z.string(), args: z.unknown() });
export const SubFrame = z.object({ t: z.literal("sub"), topic: z.string() });
export const UnsubFrame = z.object({ t: z.literal("unsub"), topic: z.string() });
export const PingFrame = z.object({ t: z.literal("ping") });
/** Vault operations a device may ask for. Phase 1 is read-only (NOTES-PLAN.md 7.2). */
export const VAULT_OPS = ["read", "search", "backlinks", "status"] as const;
export const VaultOp = z.enum(VAULT_OPS);
export type VaultOp = z.infer<typeof VaultOp>;
/** A device asks the vault for something. Relayed to the connector; the answer goes back to this socket only and is never stored. */
export const VaultReqFrame = z.object({ t: z.literal("vault.req"), id: z.string().min(1).max(100), op: VaultOp, args: z.record(z.string(), z.unknown()).default({}) });
/**
 * A device asks an agent's connector about folders on its machine: browse them, check one, approve or forget one.
 * Relayed to that connector; the answer goes back to this socket only. Approve and forget need a device that may approve.
 */
export const FoldersReqFrame = z.object({
  t: z.literal("folders.req"), id: z.string().min(1).max(100), agentId: z.string().min(1).max(100), op: FolderOp, args: z.record(z.string(), z.unknown()).default({}),
});

// ---- connector → hub ----
export const AgentRegistration = z.object({
  key: z.string().min(1), name: z.string(), kind: z.enum(["claude", "mock", "process", "managed", "webhook"]),
  description: z.string().default(""), capabilities: z.array(z.string()).default([]),
  workspaces: z.array(z.object({ label: z.string(), cwd: z.string() })).default([]),
  permissionProfile: z.enum(["standard", "strict"]).optional(), statusNote: z.string().max(300).nullable().optional(),
  /** Permission modes the connector lets this agent run in. The hub never offers a mode outside this list. */
  modes: z.array(PermissionMode).optional(),
  auth: AgentAuthProof.nullable().optional(),
  gmail: AgentGmailStatus.nullable().optional(),
  vault: AgentVaultStatus.nullable().optional(),
  /** The mode a new agent starts with. Used only until the owner picks one. */
  defaultMode: PermissionMode.optional(),
  /** Models and efforts the connector lets this agent run. Left out: they do not apply to this agent. */
  models: z.array(ModelName).max(40).optional(),
  efforts: z.array(Effort).optional(),
  /** What the connector runs the agent with when the owner has chosen nothing. */
  model: ModelName.nullable().optional(),
  effort: Effort.nullable().optional(),
  /** Image making for this agent: which providers are ready on this machine. Left out: the agent has no image tools. */
  images: AgentImagesStatus.nullable().optional(),
  /** Folders for this agent: what this machine has approved and where the app may browse. Left out: the agent takes no folders. */
  folders: AgentFolderFacts.nullable().optional(),
});
export type AgentRegistration = z.input<typeof AgentRegistration>;
export const RegisterFrame = z.object({
  t: z.literal("register"), host: z.object({ name: z.string(), os: z.string() }),
  agents: z.array(AgentRegistration), activeRunIds: z.array(z.string()).optional(),
});
export const CmdAckFrame = z.object({ t: z.literal("cmd.ack"), id: z.string(), ok: z.boolean(), error: z.string().optional() });
export const RunStatusFrame = z.object({
  t: z.literal("run.status"), runId: z.string(), status: RunStatus, sessionRef: z.string().nullable().optional(),
  summary: z.string().nullable().optional(), error: z.string().nullable().optional(), costUsd: z.number().optional(),
  numTurns: z.number().optional(), durationMs: z.number().optional(), at: z.number().int(),
});
export type RunStatusFrame = z.infer<typeof RunStatusFrame>;
export const RunEventFrame = z.object({
  t: z.literal("run.event"), runId: z.string(), idx: z.number().int().nonnegative(), at: z.number().int(),
  kind: RunEvent.shape.kind, persist: z.boolean().optional(), data: z.record(z.string(), z.unknown()),
});
export type RunEventFrame = z.infer<typeof RunEventFrame>;
export const ApprovalRequest = z.object({
  id: z.string(), runId: z.string(), kind: z.enum(["tool", "question", "plan"]), tool: z.string().nullable().optional(),
  title: z.string(), summary: z.string().nullable().optional(), input: z.unknown().optional(),
  questions: z.array(Question).nullable().optional(), risk: Risk, reason: z.string().nullable().optional(),
  requestedAt: z.number().int(), mode: PermissionMode.nullable().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;
export const ApprovalRequestFrame = z.object({ t: z.literal("approval.request"), approval: ApprovalRequest });
/**
 * A connector-side watcher found something for the inbox: new mail or a security flag about mail (Gmail watcher),
 * or a health alert from a check on the connector's machine (backups). Metadata only: there is no body field,
 * so mail bodies cannot reach the hub this way, and there is no priority field.
 */
export const InboxIngestGmailItem = z.object({
  source: z.literal("gmail"), kind: z.enum(["mail", "flag"]), externalId: z.string().min(1).max(200),
  title: z.string().min(1).max(500), snippet: z.string().max(500).nullable().optional(), sender: z.string().max(300).nullable().optional(),
  externalUrl: z.string().max(500).nullable().optional(), receivedAt: z.number().int().optional(),
});
/**
 * `alert`: one open inbox item per `externalId` (P1), updated in place when sent again. `resolve`: closes the open
 * alerts whose `externalId` is this one or starts with it plus ":" (an alert's id is `<condition>:<episode>`).
 */
export const InboxIngestMonitorItem = z.object({
  source: z.literal("monitor"), kind: z.enum(["alert", "resolve"]), externalId: z.string().min(1).max(200).regex(/^[\w.:@-]+$/),
  title: z.string().min(1).max(500), snippet: z.string().max(500).nullable().optional(), sender: z.string().max(300).nullable().optional(),
  receivedAt: z.number().int().optional(),
});
export const InboxIngestFrame = z.object({
  t: z.literal("inbox.ingest"),
  item: z.discriminatedUnion("source", [InboxIngestGmailItem, InboxIngestMonitorItem]),
});
export type InboxIngestFrame = z.infer<typeof InboxIngestFrame>;
/** Note metadata from the connector's vault index: the full list at connect, then batches as files change. */
export const VaultIndexFrame = z.object({
  t: z.literal("vault.index"), full: z.boolean(), upserts: z.array(VaultFile).max(5000), deletes: z.array(z.string().max(200)).max(5000),
});
export type VaultIndexFrame = z.infer<typeof VaultIndexFrame>;
/** The connector's answer to a relayed vault request. */
export const VaultResponseFrame = z.object({
  t: z.literal("vault.response"), id: z.string().min(1).max(100), ok: z.boolean(), result: z.unknown().optional(), error: z.string().max(500).optional(),
});
/** The connector's answer to a relayed folder request. */
export const FoldersResponseFrame = z.object({
  t: z.literal("folders.response"), id: z.string().min(1).max(100), ok: z.boolean(), result: z.unknown().optional(),
  error: z.string().max(500).optional(), code: z.string().max(40).optional(),
});
export const HeartbeatFrame = z.object({ t: z.literal("heartbeat"), activeRuns: z.number().int(), at: z.number().int() });

export const InboundFrame = z.discriminatedUnion("t", [
  HelloFrame, MutateFrame, SubFrame, UnsubFrame, PingFrame, RegisterFrame, CmdAckFrame, RunStatusFrame,
  RunEventFrame, ApprovalRequestFrame, HeartbeatFrame, InboxIngestFrame, VaultReqFrame, VaultIndexFrame, VaultResponseFrame,
  FoldersReqFrame, FoldersResponseFrame,
  // The browser for agents (browser.ts): state and pictures from a connector, a person's hands from a device.
  BrowserStateFrame, BrowserPictureFrame, BrowserNoticeFrame, BrowserInputFrame, BrowserControlFrame, BrowserAckFrame,
]);
export type InboundFrame = z.infer<typeof InboundFrame>;
export type ConnectorToHubFrame =
  | z.input<typeof HelloFrame> | z.input<typeof RegisterFrame> | z.input<typeof CmdAckFrame> | z.input<typeof RunStatusFrame>
  | z.input<typeof RunEventFrame> | z.input<typeof ApprovalRequestFrame> | z.input<typeof HeartbeatFrame> | z.input<typeof PingFrame> | z.input<typeof InboxIngestFrame>
  | z.input<typeof VaultIndexFrame> | z.input<typeof VaultResponseFrame> | z.input<typeof FoldersResponseFrame>;
export type DeviceToHubFrame =
  | z.input<typeof HelloFrame> | z.input<typeof MutateFrame> | z.input<typeof SubFrame> | z.input<typeof UnsubFrame> | z.input<typeof PingFrame> | z.input<typeof VaultReqFrame> | z.input<typeof FoldersReqFrame>;

// ---- hub → device ----
export const Change = z.object({
  seq: z.number().int().positive(), entity: EntityNameSchema, id: z.string(), op: z.enum(["upsert", "delete"]),
  at: z.number().int(), data: z.record(z.string(), z.unknown()).optional(),
});
export type Change = z.infer<typeof Change>;

export const WelcomeFrame = z.object({
  t: z.literal("welcome"), v: z.literal(1), workspaceId: z.string(), deviceId: z.string().optional(),
  connectorId: z.string().optional(), serverTime: z.number().int(), seq: z.number().int().optional(),
  mode: z.enum(["delta", "snapshot"]).optional(),
  resume: z.array(z.object({ runId: z.string(), lastIdx: z.number().int() })).optional(),
});
export const SnapshotFrame = z.object({
  t: z.literal("snapshot"), seq: z.number().int(),
  entities: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export const ChangesFrame = z.object({ t: z.literal("changes"), from: z.number().int(), to: z.number().int(), changes: z.array(Change) });
export const AckFrame = z.object({
  t: z.literal("ack"), id: z.string(), ok: z.boolean(), seq: z.number().int().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const EphemeralFrame = z.object({ t: z.literal("ephemeral"), topic: z.string(), event: RunEvent });
export const NotifyFrame = z.object({ t: z.literal("notify"), notification: Notification });
export const PongFrame = z.object({ t: z.literal("pong") });
export const VaultResFrame = z.object({
  t: z.literal("vault.res"), id: z.string(), ok: z.boolean(), result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
/** hub -> connector: one relayed vault request. Not queued: a request that misses the connector fails on the device. */
export const VaultRequestFrame = z.object({ t: z.literal("vault.request"), id: z.string(), op: VaultOp, args: z.record(z.string(), z.unknown()), deviceId: z.string() });
export type VaultRequestFrame = z.infer<typeof VaultRequestFrame>;
/** hub -> device: the answer to `folders.req`. */
export const FoldersResFrame = z.object({
  t: z.literal("folders.res"), id: z.string(), ok: z.boolean(), result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
/** hub -> connector: one relayed folder request. `canApprove` says whether the asking device may change the allowlist. Not queued. */
export const FoldersRequestFrame = z.object({
  t: z.literal("folders.request"), id: z.string(), agentKey: z.string(), op: FolderOp, args: z.record(z.string(), z.unknown()), deviceId: z.string(), canApprove: z.boolean(),
});
export type FoldersRequestFrame = z.infer<typeof FoldersRequestFrame>;
export const ErrorFrame = z.object({ t: z.literal("error"), code: z.string(), message: z.string() });

// ---- hub → connector ----
export const RunStartCmd = z.object({
  t: z.literal("cmd"), id: z.string(), name: z.literal("run.start"),
  run: z.object({
    id: z.string(), agentKey: z.string(), threadId: z.string().nullable(), prompt: z.string(), cwd: z.string().nullable(),
    resumeSessionRef: z.string().nullable(), options: z.record(z.string(), z.unknown()).optional(),
    /** Pictures on the owner's message. The connector fetches the bytes from the hub (GET /v1/attachments/:id). */
    attachments: z.array(MessageAttachment).optional(),
  }),
});
export const RunInputCmd = z.object({
  t: z.literal("cmd"), id: z.string(), name: z.literal("run.input"), runId: z.string(), text: z.string(),
  attachments: z.array(MessageAttachment).optional(),
});
export const RunCancelCmd = z.object({ t: z.literal("cmd"), id: z.string(), name: z.literal("run.cancel"), runId: z.string() });
export const ApprovalDecisionCmd = z.object({
  t: z.literal("cmd"), id: z.string(), name: z.literal("approval.decision"), approvalId: z.string(), runId: z.string(),
  decision: z.enum(["approve", "deny"]), message: z.string().nullable(), remember: z.boolean(),
  answers: z.record(z.string(), z.string()).nullable(), decidedBy: z.string(), decidedAt: z.number().int(),
  /** Plan approvals only: the mode the run continues in. */
  mode: RunMode.nullable().optional(),
});
export type ApprovalDecisionCmd = z.infer<typeof ApprovalDecisionCmd>;
/** The owner changed the mode of a chat while its run is live. Applies to the approvals still to come. */
export const RunModeCmd = z.object({ t: z.literal("cmd"), id: z.string(), name: z.literal("run.mode"), runId: z.string(), mode: RunMode });
export const CmdFrame = z.discriminatedUnion("name", [RunStartCmd, RunInputCmd, RunCancelCmd, ApprovalDecisionCmd, RunModeCmd]);
export type CmdFrame = z.infer<typeof CmdFrame>;

export const HubToDeviceFrame = z.discriminatedUnion("t", [
  WelcomeFrame, SnapshotFrame, ChangesFrame, AckFrame, EphemeralFrame, NotifyFrame, PongFrame, ErrorFrame, VaultResFrame, FoldersResFrame,
]);
export type HubToDeviceFrame = z.infer<typeof HubToDeviceFrame>;
export type HubToConnectorFrame = z.infer<typeof WelcomeFrame> | CmdFrame | VaultRequestFrame | FoldersRequestFrame | z.infer<typeof PongFrame> | z.infer<typeof ErrorFrame>;
export type OutboundFrame = HubToDeviceFrame | CmdFrame;

export const runTopic = (runId: string) => `run:${runId}`;

// ---- HTTP bodies ----
export const PairRequest = z.object({
  code: z.string().min(4), kind: z.enum(["device", "connector"]), name: z.string().min(1).max(100), platform: z.string().min(1).max(40),
});
export const PairResponse = z.object({ token: z.string(), deviceId: z.string(), workspaceId: z.string() });
export const PairingCodeRequest = z.object({ kind: z.enum(["device", "connector"]) });
export const SimulateRequest = z.object({ kind: z.enum(["gmail", "clickup", "monitor", "resend", "calendar"]) });
