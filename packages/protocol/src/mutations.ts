import { z } from "zod";
import { InboxStatus, PermissionMode, Priority, RunMode } from "./enums";
import { Effort, ModelName } from "./models";
import { ImageRoute } from "./images";
import { FolderList, FolderPath } from "./folders";
import { MAX_ATTACHMENTS, MessageAttachment } from "./attachments";

export const MUTATIONS = {
  "thread.create": z.object({
    threadId: z.string(), title: z.string().min(1).max(200), agentId: z.string().nullable().optional(),
    /** File the new session in a project straight away. Missing or null: Unsorted. */
    projectId: z.string().nullable().optional(),
    /** Start it in this folder instead of the project's or the agent's, and give it these extra folders. Both need a device that may approve. */
    cwd: FolderPath.nullable().optional(), folders: FolderList.optional(),
  }),
  "thread.update": z.object({
    threadId: z.string(), title: z.string().min(1).max(200).optional(), archived: z.boolean().optional(), pinned: z.boolean().optional(),
    /** Move the session: a project id, or null for Unsorted. */
    projectId: z.string().nullable().optional(),
    /** The owner's "where I left off" note. Null or empty clears it. */
    note: z.string().max(4000).nullable().optional(),
  }),
  /** Asks the session's agent to write a recap of where things stand. The answer is kept on the session. */
  "thread.recap": z.object({ threadId: z.string(), messageId: z.string() }),
  /**
   * The owner has the session in view: its agent output counts as read on every device. `at` is the
   * `lastAgentAt` the device was showing, so a reply that lands a moment later stays unread.
   */
  "thread.read": z.object({ threadId: z.string(), at: z.number().int().optional() }),
  "project.create": z.object({
    projectId: z.string(), name: z.string().trim().min(1).max(80), description: z.string().max(2000).nullable().optional(),
    defaultAgentId: z.string().nullable().optional(), defaultCwd: z.string().max(1000).nullable().optional(),
  }),
  "project.update": z.object({
    projectId: z.string(), name: z.string().trim().min(1).max(80).optional(), description: z.string().max(2000).nullable().optional(),
    defaultAgentId: z.string().nullable().optional(), defaultCwd: z.string().max(1000).nullable().optional(),
    pinned: z.boolean().optional(), archived: z.boolean().optional(),
  }),
  /** Removes the project. Its sessions are never deleted: they go back to Unsorted. */
  "project.delete": z.object({ projectId: z.string() }),
  "message.send": z.object({ threadId: z.string(), messageId: z.string(),
    /** May be empty when pictures are attached; the hub refuses a message with neither. */
    text: z.string().max(20000), source: z.enum(["text", "voice"]),
    /**
     * Pictures already uploaded to the hub (PUT /v1/attachments/:id). The hub checks each id and writes the
     * stored type, size and pixels onto the message; what the device says here is only for its own optimistic copy.
     */
    attachments: z.array(MessageAttachment).max(MAX_ATTACHMENTS).optional(),
    /** Set for a dictation meant for the daily note: when it was spoken (device clock) and the device's time zone. */
    capturedAt: z.number().int().optional(), tz: z.string().max(60).optional(),
  }).refine((a) => a.text.length > 0 || !!a.attachments?.length, { message: "A message needs text or an image", path: ["text"] }),
  "run.start": z.object({
    runId: z.string(), agentId: z.string(), threadId: z.string().nullable().optional(), prompt: z.string().min(1).max(20000),
    options: z.object({
      cwd: z.string().optional(), permissionProfile: z.string().optional(), maxTurns: z.number().int().optional(), mode: PermissionMode.optional(),
      /** For this run only. Left out: the session's choice, else the agent's default. */
      model: ModelName.optional(), effort: Effort.optional(),
    }).optional(),
  }),
  "run.input": z.object({ runId: z.string(), text: z.string().min(1).max(20000) }),
  "run.cancel": z.object({ runId: z.string() }),
  "approval.decide": z.object({
    approvalId: z.string(), decision: z.enum(["approve", "deny"]), message: z.string().max(2000).nullable().optional(),
    answers: z.record(z.string(), z.string()).nullable().optional(), remember: z.boolean().optional(), biometricAt: z.number().int().optional(),
    /** Approving a plan: the mode the run (and its chat) continues in. */
    mode: RunMode.optional(),
  }),
  "inbox.update": z.object({
    itemId: z.string(), status: InboxStatus.optional(), priority: Priority.optional(),
    snoozeUntil: z.number().int().nullable().optional(), assignedAgentId: z.string().nullable().optional(),
    linkedThreadId: z.string().nullable().optional(),
  }),
  "inbox.capture": z.object({ itemId: z.string(), title: z.string().min(1).max(500), body: z.string().max(20000).optional(), priority: Priority.optional() }),
  "note.upsert": z.object({
    noteId: z.string(), title: z.string().max(300), body: z.string().max(200000), baseRev: z.number().int().optional(),
    tags: z.array(z.string()).optional(), source: z.enum(["text", "voice"]).optional(),
  }),
  "note.delete": z.object({ noteId: z.string() }),
  "device.update": z.object({ deviceId: z.string(), name: z.string().min(1).max(100).optional(), revoked: z.boolean().optional() }),
  /** Sets an agent's default mode, or a chat's override (null: follow the agent again). */
  "mode.set": z.object({ scope: z.enum(["agent", "thread"]), id: z.string(), mode: PermissionMode.nullable() }),
  /**
   * Sets an agent's default model and effort, or a session's own (null: follow the default again; a
   * field that is not sent is left alone). It applies to the next run. For a session, `fresh: true`
   * also starts a new agent session there, which does not see the conversation so far.
   */
  "model.set": z.object({
    scope: z.enum(["agent", "thread"]), id: z.string(), model: ModelName.nullable().optional(), effort: Effort.nullable().optional(),
    fresh: z.boolean().optional(),
  }),
  /**
   * Folders for an agent (its defaults), a project (every session in it) or one session. `cwd` is the primary
   * folder, where the agent works (null: follow the level above); `folders` are the extra ones, each read-only
   * or read & write. A field that is not sent is left alone. Only folders the agent's connector has approved are
   * accepted, and only from a device that may approve. For a session that already has a conversation, a new
   * `cwd` needs `fresh: true`: a new agent session in that folder, because a conversation resumes only where it started.
   */
  "folders.set": z.object({
    scope: z.enum(["agent", "project", "thread"]), id: z.string(), cwd: FolderPath.nullable().optional(), folders: FolderList.optional(),
    fresh: z.boolean().optional(),
  }),
  /** Who makes images in a session, or in a project's sessions by default. Null: follow the level above (project, then Auto). Applies to the next run. */
  "images.set": z.object({ scope: z.enum(["thread", "project"]), id: z.string(), route: ImageRoute.nullable() }),
  "settings.update": z.object({ key: z.string().min(1).max(100), value: z.unknown() }),
} as const;

export type MutationName = keyof typeof MUTATIONS;
export type MutationArgs<N extends MutationName> = z.infer<(typeof MUTATIONS)[N]>;
export const MUTATION_NAMES = Object.keys(MUTATIONS) as MutationName[];
export const isMutationName = (n: string): n is MutationName => Object.prototype.hasOwnProperty.call(MUTATIONS, n);

export type MutationErrorCode =
  | "unknown_mutation" | "invalid_args" | "not_found" | "forbidden" | "conflict" | "biometric_required" | "internal";
