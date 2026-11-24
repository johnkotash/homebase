import {
  EFFORTS, canonicalModel, digestText, folderLabel, isDefaultTitle, isLiveRun, newId, offersModels, sameFolder, sameModel, switchImpact, switchMarkerText, titleFromMessage,
  type Agent, type Effort, type MutationArgs, type Run, type RunStatus, type Thread,
} from "@homebase/protocol";
import { MutationError, type Tx, type WorkspaceHub } from "./WorkspaceHub";

/**
 * Session organisation on the hub: what a session (a thread) remembers about where it stands, so a
 * device can show it for a chat from last week without holding that chat's runs.
 *   lastRunStatus  the status of its newest run
 *   summary        a one-line digest of the last thing the agent said, or why its run failed
 *   recap          what the agent wrote when the owner asked for a recap
 * Projects themselves are plain rows; see the project.* mutations.
 */

const newestRun = (tx: Tx, threadId: string) =>
  tx.hub.store.get<{ id: string }>("SELECT id FROM runs WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", threadId)?.id;

/**
 * Called for every run row the hub writes. Keeps the session's `lastRunStatus` in step with its newest
 * run, and stops waiting for a recap once the run that was writing it is over.
 */
export function onRunWritten(tx: Tx, run: Run) {
  if (!run.threadId) return;
  const th = tx.get("threads", run.threadId);
  if (!th) return;
  const patch: Partial<Thread> = {};
  if (newestRun(tx, th.id) === run.id && (th.lastRunStatus ?? null) !== run.status) patch.lastRunStatus = run.status;
  if (th.recapRunId === run.id && !isLiveRun(run.status)) patch.recapRunId = null;
  if (Object.keys(patch).length) tx.upsert("threads", { ...th, ...patch });
}

/** A completed piece of agent text: the session's digest moves on, and a recap run's text becomes the recap. */
export function onAgentText(tx: Tx, run: Run, text: string, at: number) {
  if (!run.threadId) return;
  const th = tx.get("threads", run.threadId);
  if (!th) return;
  const next: Thread = { ...th, lastMessageAt: at, updatedAt: tx.now, summary: digestText(text) || th.summary || null };
  if (th.recapRunId === run.id) {
    next.recap = text.trim().slice(0, 4000);
    next.recapAt = at;
  }
  tx.upsert("threads", next);
}

/**
 * Called when a run starts in a session. If it runs on another model or effort than the session's run
 * before it, or opens a fresh agent session, a marker goes into the conversation at that point: what
 * runs from here on, and whether the agent still has what came before. Nothing changes silently.
 */
export function markSwitch(tx: Tx, thread: Pick<Thread, "id" | "sessionResetAt">, agent: Agent, run: Run, resumed: boolean) {
  if (!offersModels(agent)) return;
  const before = tx.query("runs", "WHERE thread_id = ? AND id != ? ORDER BY created_at DESC, id DESC LIMIT 1", thread.id, run.id)[0];
  if (!before) return; // the first run of a session: nothing to compare with
  const shown = (r: Pick<Run, "model" | "effort">) => ({ model: canonicalModel(r.model ?? agent.configModel ?? null), effort: r.effort ?? agent.configEffort ?? null });
  const now = shown(run);
  const fresh = !resumed && thread.sessionResetAt != null && before.createdAt <= thread.sessionResetAt;
  const impact = switchImpact(shown(before), now);
  if (!fresh && !impact.model && !impact.effort) return;
  const kind = fresh ? "fresh" : "switch";
  // A fresh agent session may also start in another folder ("start fresh in the new folder"): the line says where.
  const moved = fresh && run.cwd && before.cwd && !sameFolder(before.cwd, run.cwd) ? run.cwd : null;
  tx.upsert("messages", {
    id: newId("msg"), threadId: thread.id, role: "system", text: switchMarkerText(kind, now.model, now.effort, moved ? folderLabel(agent, moved) : null), source: "agent", runId: run.id,
    authorDeviceId: null, createdAt: tx.now, card: { type: "session_marker", kind, model: now.model, effort: now.effort, ...(moved ? { cwd: moved } : {}) },
  });
}

/**
 * `model.set`: the owner's default model and effort for an agent, or a session's own. Only what the
 * agent's connector offers is accepted. Nothing is sent to the connector: the choice is read when the
 * next run starts. `fresh` (sessions only) also makes that next run open a new agent session.
 */
export function setModelChoice(tx: Tx, a: MutationArgs<"model.set">) {
  const checked = (agent: Agent): { model?: string | null; effort?: Effort | null } => {
    if (!offersModels(agent)) throw new MutationError("invalid_args", `${agent.name} is a scripted agent: model and effort do not apply to it`);
    const out: { model?: string | null; effort?: Effort | null } = {};
    if (a.model !== undefined) {
      const m = a.model === null ? null : agent.models!.find((x) => sameModel(x, a.model));
      if (m === undefined) throw new MutationError("invalid_args", `${agent.name} does not offer the model ${a.model}`);
      out.model = m;
    }
    if (a.effort !== undefined) {
      if (a.effort !== null && !(agent.efforts ?? EFFORTS).includes(a.effort)) throw new MutationError("invalid_args", `${agent.name} does not offer ${a.effort} effort`);
      out.effort = a.effort;
    }
    return out;
  };
  if (a.scope === "agent") {
    const agent = tx.get("agents", a.id);
    if (!agent) throw new MutationError("not_found", "Agent not found");
    if (a.fresh) throw new MutationError("invalid_args", "Only a session can be given a fresh agent session");
    const p = checked(agent);
    const next = { model: p.model !== undefined ? p.model : agent.defaultModel ?? null, effort: p.effort !== undefined ? p.effort : agent.defaultEffort ?? null };
    if (next.model === (agent.defaultModel ?? null) && next.effort === (agent.defaultEffort ?? null)) return;
    tx.upsert("agents", { ...agent, defaultModel: next.model, defaultEffort: next.effort, updatedAt: tx.now });
    tx.audit("model.set", "agent", agent.id, { scope: "agent", from: { model: agent.defaultModel ?? null, effort: agent.defaultEffort ?? null }, to: next });
    return;
  }
  const th = tx.get("threads", a.id);
  if (!th) throw new MutationError("not_found", "Thread not found");
  const agent = th.agentId ? tx.get("agents", th.agentId) : undefined;
  if (!agent) throw new MutationError("invalid_args", "This session has no agent, so it has no model");
  const p = checked(agent);
  if (a.fresh && tx.query("runs", "WHERE thread_id = ? ORDER BY created_at DESC LIMIT 5", th.id).some((r) => isLiveRun(r.status))) {
    throw new MutationError("conflict", "The agent is still working in this session. Start a fresh agent session when it has finished.");
  }
  const next = { model: p.model !== undefined ? p.model : th.model ?? null, effort: p.effort !== undefined ? p.effort : th.effort ?? null };
  if (!a.fresh && next.model === (th.model ?? null) && next.effort === (th.effort ?? null)) return;
  tx.upsert("threads", { ...th, model: next.model, effort: next.effort, sessionResetAt: a.fresh ? tx.now : th.sessionResetAt ?? null, updatedAt: tx.now });
  tx.audit("model.set", "thread", th.id, { scope: "thread", agentId: agent.id, from: { model: th.model ?? null, effort: th.effort ?? null }, to: next, fresh: !!a.fresh });
}

/** A failed run is where the session stands until someone speaks in it again. */
export function onRunFailed(tx: Tx, run: Run, error: string) {
  if (!run.threadId) return;
  const th = tx.get("threads", run.threadId);
  if (th) tx.upsert("threads", { ...th, summary: digestText(`Run failed: ${error}`) });
}

/**
 * Fills in what sessions created before 2026-11-22 are missing. Nothing is moved or removed: a thread
 * with no project is already in Unsorted. For each thread this sets, only where it is still empty,
 * the status of its newest run and a digest of the agent's last reply; and a thread that still has
 * its placeholder title ("New chat with …") is named after the first thing the owner said in it.
 * Safe to run at every start: a second pass finds nothing to do.
 */
export function backfillSessions(hub: WorkspaceHub): { threads: number; titled: number } {
  let threads = 0;
  let titled = 0;
  const store = hub.store;
  const candidates = store.all<{ id: string }>(
    `SELECT t.id FROM threads t WHERE
       (t.last_run_status IS NULL AND EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = t.id))
       OR (t.summary IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.role != 'user'))
       OR (t.title LIKE 'New %' AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.role = 'user'))`,
  );
  if (!candidates.length) return { threads, titled };
  hub.commit(null, null, (tx) => {
    for (const { id } of candidates) {
      const th = tx.get("threads", id);
      if (!th) continue;
      const next: Thread = { ...th };
      if (th.lastRunStatus == null) {
        const run = store.get<{ status: RunStatus }>("SELECT status FROM runs WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", id);
        if (run) next.lastRunStatus = run.status;
      }
      if (th.summary == null) {
        const last = store.get<{ text: string }>(
          "SELECT text FROM messages WHERE thread_id = ? AND role != 'user' AND card IS NULL ORDER BY created_at DESC, id DESC LIMIT 1", id,
        );
        const digest = last ? digestText(last.text) : "";
        if (digest) next.summary = digest;
      }
      if (isDefaultTitle(th.title)) {
        const first = store.get<{ text: string }>("SELECT text FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at, id LIMIT 1", id);
        if (first) {
          next.title = titleFromMessage(first.text);
          titled++;
        }
      }
      if (JSON.stringify(next) === JSON.stringify(th)) continue;
      tx.upsert("threads", next);
      threads++;
    }
  });
  if (threads) hub.log(`session backfill: ${threads} session(s) updated, ${titled} named from their first message`);
  return { threads, titled };
}
