import type { ApprovalRequest, MutationArgs } from "@homebase/protocol";
import { MutationError, type Peer, type Tx, type WorkspaceHub } from "./WorkspaceHub";

export const BIOMETRIC_WINDOW_MS = 60_000;

/** Connector → hub: an agent is waiting for the owner. Stays open until decided. */
export function onApprovalRequest(hub: WorkspaceHub, peer: Peer, req: ApprovalRequest) {
  hub.commit(peer.id, null, (tx) => {
    const run = tx.get("runs", req.runId);
    if (!run) return;
    const agent = tx.get("agents", run.agentId);
    if (!agent || agent.connectorId !== peer.id) return;
    const known = tx.get("approvals", req.id);
    if (known) {
      // Replay after a reconnect: never reopen or duplicate, but a run that came back is waiting again.
      if (known.status === "pending" && run.status === "offline") tx.upsert("runs", { ...run, status: "waiting_approval", updatedAt: tx.now });
      return;
    }
    tx.upsert("approvals", {
      id: req.id, runId: req.runId, agentId: run.agentId, kind: req.kind, tool: req.tool ?? null, title: req.title,
      summary: req.summary ?? null, input: req.input ?? null, questions: req.questions ?? null, risk: req.risk,
      reason: req.reason ?? null, status: "pending", decisionMessage: null, answers: null, decidedBy: null,
      requestedAt: req.requestedAt, decidedAt: null, mode: req.mode ?? run.mode ?? null,
    });
    tx.upsert("runs", { ...run, status: "waiting_approval", updatedAt: tx.now });
    tx.audit("approval.request", "approval", req.id, { runId: req.runId, risk: req.risk, title: req.title, tool: req.tool ?? null, kind: req.kind, mode: req.mode ?? run.mode ?? null });
    const high = req.risk === "high";
    tx.notify({
      priority: high ? "P0" : "P1", channel: "approvals",
      title: req.kind === "question" ? `${agent.name} has a question` : req.kind === "plan" ? `${agent.name} has a plan to review` : `Approval needed: ${req.title}`,
      body: req.kind === "question"
        ? req.questions?.[0]?.question ?? req.title
        : req.kind === "plan" ? req.summary ?? "Open it to approve the plan or ask for changes."
        : `${agent.name} wants to run ${req.tool ?? "an action"}: ${req.summary ?? req.title}`,
      // A plan is approved into a mode, so it is always decided in the app, never from a notification.
      link: `/approvals/${req.id}`, actions: high || req.kind !== "tool" ? ["open"] : ["approve", "deny"],
      collapseKey: req.id, subjectType: "approval", subjectId: req.id,
    });
  });
}

/**
 * State machine: pending → approved | denied (by a device), pending → expired (connector lost the run),
 * pending → cancelled (run ended or was cancelled). Terminal states never change.
 */
export function decideApproval(tx: Tx, args: MutationArgs<"approval.decide">, device: { id: string; canApprove: boolean }) {
  const apr = tx.get("approvals", args.approvalId);
  if (!apr) throw new MutationError("not_found", "Approval not found");
  if (apr.status !== "pending") throw new MutationError("conflict", `This approval is already ${apr.status}`);
  if (!device.canApprove) throw new MutationError("forbidden", "This device cannot approve agent actions");
  if (apr.risk === "high" && args.decision === "approve") {
    const at = args.biometricAt;
    if (at == null || Math.abs(tx.now - at) > BIOMETRIC_WINDOW_MS) {
      throw new MutationError("biometric_required", "High-risk actions must be confirmed in the app within the last 60 seconds");
    }
  }
  if (apr.kind === "question" && args.decision === "approve" && (!args.answers || Object.keys(args.answers).length === 0)) {
    throw new MutationError("invalid_args", "Pick an answer first");
  }
  const status = args.decision === "approve" ? "approved" : "denied";
  const agent = apr.agentId ? tx.get("agents", apr.agentId) : undefined;
  // Approving a plan picks the mode the work continues in. Without a choice it is the careful one.
  let planMode: "manual" | "auto" | null = null;
  if (apr.kind === "plan" && args.decision === "approve") {
    planMode = args.mode ?? "manual";
    if (agent?.modes?.length && !agent.modes.includes(planMode)) throw new MutationError("invalid_args", `${agent.name} cannot run in ${planMode} mode`);
    const run = tx.get("runs", apr.runId);
    if (run) {
      tx.upsert("runs", { ...run, mode: planMode, updatedAt: tx.now });
      const th = run.threadId ? tx.get("threads", run.threadId) : undefined;
      if (th) tx.upsert("threads", { ...th, mode: planMode, updatedAt: tx.now });
    }
  }
  tx.upsert("approvals", {
    ...apr, status, decisionMessage: args.message ?? null, answers: args.answers ?? null, decidedBy: device.id, decidedAt: tx.now,
    mode: planMode ?? apr.mode ?? null,
  });
  tx.audit("approval.decide", "approval", apr.id, {
    decision: args.decision, risk: apr.risk, runId: apr.runId, title: apr.title, tool: apr.tool, input: apr.input, kind: apr.kind,
    message: args.message ?? null, answers: args.answers ?? null, remember: !!args.remember, biometricAt: args.biometricAt ?? null,
    mode: planMode ?? apr.mode ?? null,
  });
  if (agent?.connectorId) {
    tx.command(agent.connectorId, {
      name: "approval.decision", approvalId: apr.id, runId: apr.runId, decision: args.decision, message: args.message ?? null,
      remember: !!args.remember && apr.risk !== "high", answers: args.answers ?? null, decidedBy: device.id, decidedAt: tx.now,
      mode: planMode,
    });
  }
}

export function closeApprovalsForRun(tx: Tx, runId: string, status: "expired" | "cancelled") {
  for (const a of tx.query("approvals", "WHERE run_id = ? AND status = 'pending'", runId)) {
    tx.upsert("approvals", { ...a, status, decidedAt: tx.now });
    tx.audit(`approval.${status}`, "approval", a.id, { runId });
  }
}
