import type { ApprovalDecisionCmd, ApprovalRequest, MessageAttachment, RunEventKind, RunStatus } from "@homebase/protocol";

export type ApprovalDraft = Omit<ApprovalRequest, "id" | "runId" | "requestedAt">;
export type ApprovalDecision = Pick<ApprovalDecisionCmd, "decision" | "message" | "answers" | "remember"> & { mode?: "manual" | "auto" | null };

export interface RunSpec {
  id: string;
  agentKey: string;
  threadId: string | null;
  prompt: string;
  cwd: string | null;
  resumeSessionRef: string | null;
  options?: Record<string, unknown>;
  /** Pictures on the owner's first message (ids and facts; the bytes come from `RunContext.loadAttachment`). */
  attachments?: MessageAttachment[];
}

/** What an adapter can do to the outside world. The connector supplies it; adapters never touch the socket. */
export interface RunContext {
  run: RunSpec;
  signal: AbortSignal;
  emit(kind: RunEventKind, data: Record<string, unknown>, opts?: { persist?: boolean }): void;
  status(status: RunStatus, extra?: { sessionRef?: string; summary?: string; error?: string; costUsd?: number; numTurns?: number; durationMs?: number }): void;
  /** Sends approval.request, sets waiting_approval, and resolves when the owner decides. No timeout. */
  requestApproval(draft: ApprovalDraft): Promise<ApprovalDecision>;
  /** Fetches the bytes of a picture the owner attached (from the hub, with this connector's token). Left out: pictures cannot be read. */
  loadAttachment?(a: MessageAttachment): Promise<Uint8Array>;
}

export interface RunHandle {
  /** Follow-up user message into a live run, with any pictures the owner attached to it. */
  input(text: string, attachments?: MessageAttachment[]): void;
  cancel(): void;
  /** The owner changed the chat's mode while this run is live. Adapters without modes leave it out. */
  setMode?(mode: "manual" | "auto"): void;
  /** Settles when the run has reported a terminal status. */
  done: Promise<void>;
}

export interface AgentAdapter {
  kind: "mock" | "claude" | "process";
  start(ctx: RunContext): RunHandle;
}
