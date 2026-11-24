import {
  EFFORTS, GeneratedImageCard, GmailCard, IMAGE_CHECK_SETTING, ImageIssueCard, MAKER_LABEL, PermissionMode, VaultCaptureCard, isLiveRun, newId, resolveImageRoute, resolveModelChoice, stripAgentMarkup,
  type Agent, type InboundFrame, type MessageAttachment, type Run, type RunEventFrame, type RunStatusFrame, type Thread,
} from "@homebase/protocol";
import { MutationError, type Peer, type Tx, type WorkspaceHub } from "./WorkspaceHub";
import { closeApprovalsForRun } from "./approvals";
import { foldersForRun, markFolders } from "./folders";
import { markSwitch, onAgentText, onRunFailed } from "./sessions";

type RegisterFrame = Extract<InboundFrame, { t: "register" }>;

export function resumeList(hub: WorkspaceHub, connectorId: string) {
  return hub.store
    .all<{ id: string; last_event_idx: number }>(
      `SELECT r.id, r.last_event_idx FROM runs r JOIN agents a ON a.id = r.agent_id
       WHERE a.connector_id = ? AND r.status IN ('queued','starting','running','waiting_approval','offline') AND r.updated_at > ?`,
      connectorId, hub.now() - 86_400_000,
    )
    .map((r) => ({ runId: r.id, lastIdx: Number(r.last_event_idx) }));
}

/**
 * The permission mode a run starts in: what was asked for this run, else the chat's override, else
 * the agent's default, else manual. Null for agents without modes. Never a mode the connector did not offer.
 */
export function resolveMode(agent: Pick<Agent, "modes" | "defaultMode">, thread?: Pick<Thread, "mode"> | null, asked?: unknown): PermissionMode | null {
  const offered = agent.modes ?? [];
  if (!offered.length) return null;
  for (const m of [asked, thread?.mode, agent.defaultMode, "manual"]) {
    const p = PermissionMode.safeParse(m);
    if (p.success && offered.includes(p.data)) return p.data;
  }
  return offered[0];
}

export function startRun(
  tx: Tx,
  a: { runId: string; agentId: string; threadId?: string | null; prompt: string; cwd?: string | null; options?: Record<string, unknown>; attachments?: MessageAttachment[] },
): Run {
  const agent = tx.get("agents", a.agentId);
  if (!agent) throw new MutationError("not_found", "Agent not found");
  if (!agent.connectorId) throw new MutationError("conflict", `${agent.name} has no connector yet. Start the connector and try again.`);
  if (tx.get("runs", a.runId)) throw new MutationError("conflict", "Run already exists");
  const prev = a.threadId
    ? tx.query("runs", "WHERE thread_id = ? AND session_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1", a.threadId)[0]
    : undefined;
  const thread = a.threadId ? tx.get("threads", a.threadId) : undefined;
  // The agent session this run continues. None when the owner asked for a fresh one since that session last ran.
  const resume = prev && prev.createdAt > (thread?.sessionResetAt ?? 0) ? prev : undefined;
  // Model and effort: this run's own, else the session's, else the owner's default for the agent. Null: the connector's setting.
  const choice = resolveModelChoice(agent, thread ?? null, { model: a.options?.model, effort: a.options?.effort });
  // A thread keeps its working directory: an agent session can only be resumed from where it started.
  // A session's first run starts in its project's directory, when the agent has that directory.
  // Folders (ARCHITECTURE.md 6.6): the primary one is the run's own, else where the session it resumes lives, else the
  // session's, else where it last worked, else the project's, the agent's default, the agent's sandbox. The extra ones
  // come from the agent's defaults, the project and the session, and only those the agent's connector has approved go out.
  const project = thread?.projectId ? tx.get("projects", thread.projectId) : undefined;
  const { cwd, folders } = foldersForRun({ agent, thread: thread ?? null, project: project ?? null, asked: a.cwd ?? null, prev: prev ?? null, resume: resume ?? null });
  const mode = resolveMode(agent, thread ?? null, a.options?.mode);
  // Images: who makes them here (the session's choice, else its project's, else Auto) and whether Claude checks each one.
  // Sent only to an agent whose connector offers image tools; the connector does the routing.
  const images = agent.images
    ? {
        route: resolveImageRoute(thread ?? null, thread?.projectId ? tx.get("projects", thread.projectId) ?? null : null).route,
        check: tx.get("settings", IMAGE_CHECK_SETTING)?.value === true,
      }
    : null;
  const run = tx.upsert("runs", {
    id: a.runId, agentId: agent.id, threadId: a.threadId ?? null, prompt: a.prompt, status: "queued", sessionRef: null, summary: null,
    error: null, costUsd: null, numTurns: null, durationMs: null, lastEventIdx: -1, startedBy: tx.actorId, cwd,
    createdAt: tx.now, startedAt: null, endedAt: null, updatedAt: tx.now, mode, model: choice.model, effort: choice.effort, folders,
  });
  // The session remembers the folder it works in from its first run on, so every device can show it.
  if (thread && !thread.cwd && cwd) tx.patch("threads", thread.id, { cwd });
  // A change of model or effort, or a fresh agent session, is written into the session where it happens.
  if (thread) markSwitch(tx, thread, agent, run, !!resume);
  if (thread) markFolders(tx, thread, run, agent);
  tx.audit("run.start", "run", run.id, {
    agentId: agent.id, agentKey: agent.key, threadId: run.threadId, prompt: a.prompt.slice(0, 500), mode, model: choice.model, effort: choice.effort, resumed: !!resume,
    cwd, folders: folders ?? [], ...(a.attachments?.length ? { attachments: a.attachments.map((x) => x.id) } : {}),
  });
  tx.command(agent.connectorId, {
    name: "run.start",
    run: {
      id: run.id, agentKey: agent.key, threadId: run.threadId, prompt: a.prompt, cwd, resumeSessionRef: resume?.sessionRef ?? null,
      // Only a model and an effort this agent offers go out; anything else that was asked for is dropped here.
      options: {
        permissionProfile: agent.permissionProfile, ...(a.options ?? {}), ...(mode ? { mode } : {}),
        model: choice.model ?? undefined, effort: choice.effort ?? undefined,
        ...(images ? { images } : {}),
        // Extra folders, when there are any (none: nothing is sent, exactly as before folders existed). Put after the
        // caller's own options, so a device can never slip a folder in here.
        ...(folders?.length ? { folders } : {}),
      },
      // The owner's pictures, as ids and facts only. The connector fetches the bytes from the hub.
      ...(a.attachments?.length ? { attachments: a.attachments } : {}),
    },
  });
  return run;
}

export function onRegister(hub: WorkspaceHub, peer: Peer, frame: RegisterFrame) {
  hub.commit(peer.id, null, (tx) => {
    const now = tx.now;
    tx.upsert("connectors", { id: peer.id, name: frame.host.name || peer.name, host: frame.host, status: "online", lastSeenAt: now });
    const keys = new Set<string>();
    for (const reg of frame.agents) {
      keys.add(reg.key);
      // Agents are matched by key so seeded history and threads keep pointing at the same agent.
      const existing =
        tx.query("agents", "WHERE key = ? AND connector_id = ?", reg.key, peer.id)[0] ??
        tx.query("agents", "WHERE key = ? AND connector_id IS NULL", reg.key)[0];
      const next: Agent = {
        id: existing?.id ?? newId("agt"), connectorId: peer.id, key: reg.key, name: reg.name, kind: reg.kind,
        description: reg.description ?? "", capabilities: reg.capabilities ?? [], workspaces: reg.workspaces ?? [],
        permissionProfile: reg.permissionProfile ?? existing?.permissionProfile ?? "standard", status: "online", updatedAt: now,
        statusNote: reg.statusNote ?? null,
        // The default mode is the owner's setting: a connector restart never changes it, unless that mode is gone.
        modes: reg.modes ?? null,
        defaultMode: reg.modes?.length ? (existing?.defaultMode && reg.modes.includes(existing.defaultMode) ? existing.defaultMode : reg.modes.includes("manual") ? "manual" : reg.modes[0]) : null,
        auth: reg.auth ?? null,
        gmail: reg.gmail ?? null,
        vault: reg.vault ?? null,
        // Model and effort: what the connector offers and is configured with. A scripted agent offers none.
        models: reg.models?.length ? reg.models : null,
        efforts: reg.models?.length ? reg.efforts ?? [...EFFORTS] : null,
        configModel: reg.model ?? null,
        configEffort: reg.effort ?? null,
        defaultModel: null,
        defaultEffort: null,
        images: reg.images ?? null,
        // Folders: what the connector has approved is the connector's word; the default folders are the owner's and are kept.
        folders: reg.folders ?? null,
        defaultCwd: existing?.defaultCwd ?? null,
        defaultFolders: existing?.defaultFolders ?? null,
      };
      // The owner's default model and effort survive a connector restart, unless the connector stopped offering them.
      const kept = resolveModelChoice({ ...next, defaultModel: existing?.defaultModel, defaultEffort: existing?.defaultEffort });
      next.defaultModel = kept.model;
      next.defaultEffort = kept.effort;
      // A brand-new agent starts in the mode its connector suggests (the Notes agent: Auto). After that it is the owner's setting.
      if (!existing && reg.defaultMode && reg.modes?.includes(reg.defaultMode)) next.defaultMode = reg.defaultMode;
      // A connector re-registers whenever one agent's note or auth facts change; rows that did not change are left alone.
      const same = existing && JSON.stringify({ ...existing, updatedAt: 0 }) === JSON.stringify({ ...existing, ...next, updatedAt: 0 });
      if (!same) tx.upsert("agents", next);
    }
    for (const a of tx.query("agents", "WHERE connector_id = ?", peer.id)) {
      if (!keys.has(a.key) && a.status !== "offline") tx.upsert("agents", { ...a, status: "offline", updatedAt: now });
    }
    // Reconcile runs: anything the connector no longer holds is lost; its open approvals expire.
    const held = new Set(frame.activeRunIds ?? []);
    const stale = tx.query(
      "runs",
      `WHERE status IN ('starting','running','waiting_approval','offline') AND agent_id IN (SELECT id FROM agents WHERE connector_id = ?)`,
      peer.id,
    );
    for (const run of stale) {
      if (held.has(run.id)) continue;
      if (run.status !== "offline") {
        tx.upsert("runs", { ...run, status: "offline", error: "The connector restarted and lost this run.", endedAt: now, updatedAt: now });
      }
      closeApprovalsForRun(tx, run.id, "expired");
      hub.dropCommandsForRun(peer.id, run.id);
    }
  });
  hub.log(`connector registered ${frame.agents.length} agent(s): ${frame.agents.map((a) => a.key).join(", ")}`);
}

export function onConnectorGone(hub: WorkspaceHub, connectorId: string) {
  hub.commit(connectorId, null, (tx) => {
    const now = tx.now;
    const c = tx.get("connectors", connectorId);
    if (c) tx.upsert("connectors", { ...c, status: "offline", lastSeenAt: now });
    for (const a of tx.query("agents", "WHERE connector_id = ?", connectorId)) {
      if (a.status !== "offline") tx.upsert("agents", { ...a, status: "offline", updatedAt: now });
    }
    const live = tx.query(
      "runs", `WHERE status IN ('starting','running','waiting_approval') AND agent_id IN (SELECT id FROM agents WHERE connector_id = ?)`, connectorId,
    );
    for (const run of live) tx.upsert("runs", { ...run, status: "offline", updatedAt: now });
  });
}

function ownedRun(tx: Tx, peer: Peer, runId: string): Run | undefined {
  const run = tx.get("runs", runId);
  if (!run) return undefined;
  const agent = tx.get("agents", run.agentId);
  return agent?.connectorId === peer.id ? run : undefined;
}

export function onRunStatus(hub: WorkspaceHub, peer: Peer, f: RunStatusFrame) {
  hub.commit(peer.id, null, (tx) => {
    const run = ownedRun(tx, peer, f.runId);
    if (!run) return;
    const terminal = f.status === "succeeded" || f.status === "failed" || f.status === "cancelled";
    const wasTerminal = ["succeeded", "failed", "cancelled"].includes(run.status);
    if (wasTerminal) return; // terminal states are final
    const next: Run = {
      ...run, status: f.status, sessionRef: f.sessionRef ?? run.sessionRef, summary: f.summary ?? run.summary,
      error: f.status === "failed" ? f.error ?? "Run failed" : f.status === "offline" ? run.error : null,
      costUsd: f.costUsd ?? run.costUsd, numTurns: f.numTurns ?? run.numTurns, durationMs: f.durationMs ?? run.durationMs,
      startedAt: run.startedAt ?? (f.status === "running" ? f.at : null), endedAt: terminal ? f.at : null, updatedAt: tx.now,
    };
    tx.upsert("runs", next);
    if (!terminal) return;
    closeApprovalsForRun(tx, run.id, "cancelled");
    const agent = tx.get("agents", run.agentId);
    const who = agent?.name ?? "Agent";
    if (f.status === "failed") {
      if (run.threadId) {
        tx.upsert("messages", {
          id: newId("msg"), threadId: run.threadId, role: "system", text: `Run failed: ${next.error}`, source: "agent", runId: run.id,
          authorDeviceId: null, createdAt: tx.now,
        });
        onRunFailed(tx, run, next.error ?? "The run ended with an error.");
      }
      tx.notify({
        priority: "P1", channel: "p1_today", title: `${who} failed`, body: next.error ?? "The run ended with an error.",
        link: `/runs/${run.id}`, actions: ["open"], collapseKey: run.id, subjectType: "run", subjectId: run.id,
      });
    } else if (f.status === "succeeded") {
      tx.notify({
        priority: "P3", channel: "agent_updates", title: `${who} finished`, body: stripAgentMarkup(next.summary ?? run.prompt),
        link: run.threadId ? `/chats/${run.threadId}` : `/runs/${run.id}`, actions: ["open"], collapseKey: run.id,
        subjectType: "run", subjectId: run.id,
      });
    }
  });
}

export function onRunEvent(hub: WorkspaceHub, peer: Peer, f: RunEventFrame) {
  const event = { runId: f.runId, idx: f.idx, at: f.at, kind: f.kind, data: f.data };
  if (f.persist === false) {
    // Streaming chunks are not stored; they only go to whoever is watching the run right now.
    const owner = hub.store.get<{ c: string | null }>(
      "SELECT a.connector_id AS c FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.id = ?", f.runId,
    );
    if (owner?.c === peer.id) hub.publishRunEvent(event);
    return;
  }
  const fresh = hub.commit(peer.id, null, (tx) => {
    const run = ownedRun(tx, peer, f.runId);
    if (!run) return false;
    const r = hub.store.run(
      "INSERT OR IGNORE INTO run_events (run_id, idx, at, kind, data) VALUES (?, ?, ?, ?, ?)", f.runId, f.idx, f.at, f.kind, JSON.stringify(f.data),
    );
    if (r.changes === 0) return false; // duplicate from a replay
    hub.store.run("UPDATE runs SET last_event_idx = MAX(last_event_idx, ?) WHERE id = ?", f.idx, f.runId);
    // What the connector's policy let through or blocked without asking is part of the audit trail.
    const decision = f.data.decision;
    if (f.kind === "system" && (decision === "auto_approved" || decision === "blocked")) {
      const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
      tx.audit(decision === "auto_approved" ? "approval.auto" : "approval.blocked", "run", run.id, {
        runId: run.id, mode: str(f.data.mode, 20) ?? run.mode ?? null, tool: str(f.data.tool, 100), title: str(f.data.title, 300),
        summary: str(f.data.summary, 2000), reason: str(f.data.reason, 300),
      });
    }
    if (f.kind === "system" && f.data.modeChanged === true) {
      // The connector says which mode the run is really in (for example when it does not allow the one asked for).
      const m = PermissionMode.safeParse(f.data.mode);
      const cur = tx.get("runs", run.id)!;
      if (m.success && m.data !== cur.mode) tx.upsert("runs", { ...cur, mode: m.data, updatedAt: tx.now });
    }
    // A draft the agent saved in Gmail (or an approved send) is shown in the chat as a card.
    // What a dictation wrote to the vault: files, bullets as on disk, the transcript and flags.
    const vcard = f.kind === "system" ? VaultCaptureCard.safeParse(f.data.vaultCard) : null;
    if (vcard?.success) {
      const c = vcard.data;
      if (run.threadId) {
        const lines = [
          `Captured ${c.date} \u2014 ${c.files.length} file${c.files.length === 1 ? "" : "s"}`,
          ...c.files.flatMap((x) => ["", `${x.path}  (${x.status})`, ...x.bullets.map((b) => `  ${b}`)]),
          ...(c.transcriptPath ? ["", `Transcript: ${c.transcriptPath}`] : []),
          ...(c.flags.length ? ["", "Flags", ...c.flags.map((x) => `  - ${x}`)] : []),
        ];
        tx.upsert("messages", {
          id: newId("msg"), threadId: run.threadId, role: "assistant", text: lines.join("\n"), source: "agent", runId: run.id,
          authorDeviceId: null, createdAt: f.at, card: c,
        });
      }
      tx.audit("vault.write", "run", run.id, {
        runId: run.id, tool: "vault_append_daily", paths: c.files.map((x) => x.path), transcript: c.transcriptPath, commit: c.commit ?? null,
      });
    }
    const card = f.kind === "system" ? GmailCard.safeParse(f.data.gmailCard) : null;
    if (card?.success && run.threadId) {
      const c = card.data;
      const lines = [
        c.type === "gmail_sent" ? "Email sent from Gmail" : c.updated ? "Draft updated in Gmail" : "Draft saved in Gmail",
        `To: ${c.to.join(", ") || "(none)"}`, ...(c.cc.length ? [`Cc: ${c.cc.join(", ")}`] : []), ...(c.bcc.length ? [`Bcc: ${c.bcc.join(", ")}`] : []),
        `Subject: ${c.subject}`, "", c.body,
      ];
      tx.upsert("messages", {
        id: newId("msg"), threadId: run.threadId, role: "assistant", text: lines.join("\n"), source: "agent", runId: run.id,
        authorDeviceId: null, createdAt: f.at, card: c,
      });
      if (c.type === "gmail_sent") tx.audit("gmail.send", "run", run.id, { runId: run.id, to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject.slice(0, 300), draftId: c.draftId, threadId: c.threadId });
    }
    // An image made in the session (by OpenAI, or drawn by Claude) is its own card, with the maker the connector stamped on it.
    const icard = f.kind === "system" ? GeneratedImageCard.safeParse(f.data.imageCard) : null;
    if (icard?.success) {
      const c = icard.data;
      if (run.threadId) {
        const lines = [
          `Image by ${MAKER_LABEL[c.maker]}${c.base ? `, on an image by ${MAKER_LABEL[c.base.maker]}` : ""}: ${c.name}`, c.prompt,
          ...(c.savedPath ? [`Saved to ${c.savedPath}`] : []),
        ];
        tx.upsert("messages", {
          id: newId("msg"), threadId: run.threadId, role: "assistant", text: lines.join("\n"), source: "agent", runId: run.id,
          authorDeviceId: null, createdAt: f.at, card: c,
        });
      }
      tx.audit("image.made", "run", run.id, {
        runId: run.id, maker: c.maker, via: c.via, model: c.model, artifactId: c.artifactId, name: c.name, prompt: c.prompt.slice(0, 2000),
        references: c.references, savedPath: c.savedPath, seconds: c.seconds, bytes: c.bytes, routedWhy: c.routedWhy ?? null, base: c.base ?? null,
      });
    }
    // An image that was not made: the provider's name and the reason, where the image would have been.
    const issue = f.kind === "system" ? ImageIssueCard.safeParse(f.data.imageIssue) : null;
    if (issue?.success) {
      const c = issue.data;
      if (run.threadId) {
        tx.upsert("messages", {
          id: newId("msg"), threadId: run.threadId, role: "assistant", text: [`${MAKER_LABEL[c.maker]}: ${c.title}`, c.message, ...(c.hint ? [c.hint] : [])].join("\n"),
          source: "agent", runId: run.id, authorDeviceId: null, createdAt: f.at, card: c,
        });
      }
      tx.audit("image.failed", "run", run.id, { runId: run.id, maker: c.maker, reason: c.reason, title: c.title, message: c.message.slice(0, 500) });
    }
    // Each completed assistant text is also a chat message in the run's thread.
    if (f.kind === "text" && run.threadId && typeof f.data.text === "string" && f.data.text.trim()) {
      tx.upsert("messages", {
        id: newId("msg"), threadId: run.threadId, role: "assistant", text: f.data.text, source: "agent", runId: run.id,
        authorDeviceId: null, createdAt: f.at,
      });
      // The session moves on: last activity, the one-line digest and, for a recap run, the recap itself.
      onAgentText(tx, run, f.data.text, f.at);
    }
    return true;
  });
  if (fresh) hub.publishRunEvent(event);
}

export function cancelRun(tx: Tx, runId: string) {
  const run = tx.get("runs", runId);
  if (!run) throw new MutationError("not_found", "Run not found");
  if (!isLiveRun(run.status) && run.status !== "offline") throw new MutationError("conflict", `Run already ${run.status}`);
  const agent = tx.get("agents", run.agentId);
  tx.audit("run.cancel", "run", run.id, {});
  const connectorOnline = !!agent?.connectorId && !!tx.hub.connectorPeer(agent.connectorId);
  if (connectorOnline && run.status !== "offline" && run.status !== "queued") {
    tx.command(agent!.connectorId!, { name: "run.cancel", runId });
    return;
  }
  // Nobody is running it: settle it here.
  if (agent?.connectorId) tx.hub.dropCommandsForRun(agent.connectorId, runId);
  if (connectorOnline) tx.command(agent!.connectorId!, { name: "run.cancel", runId });
  tx.upsert("runs", { ...run, status: "cancelled", endedAt: tx.now, updatedAt: tx.now });
  closeApprovalsForRun(tx, runId, "cancelled");
}
