import * as Clipboard from "expo-clipboard";
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { BackHandler, Platform, View } from "react-native";
import { TERMINAL_CAPABILITY, type FileOp } from "@homebase/protocol";
import type { TermEvent } from "@homebase/sync-client";
import { Placeholder } from "../components/lists";
import { useOne } from "../sync/hooks";
import { filesRequest, termClose, termInput, termOpen, termResize } from "../sync/session";
import { color } from "../theme";
import type { PushEvent, Reply, TermAction, WorkspaceHandle, WorkspaceInit } from "./bridge";
import WorkspaceView from "./WorkspaceView";

export type WorkspacePaneProps = {
  agentId: string;
  /** The folder to start in. */
  path?: string | null;
  /** Open a terminal there right away. */
  terminal?: boolean;
  /** Called once the view has dealt with unsaved files. */
  onClose: () => void;
  /** Desktop: in a panel beside the chat. */
  docked?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
};

export type WorkspacePaneHandle = { showTerminal: () => void; showFiles: () => void; requestClose: () => void };

/**
 * Files, the editor and the terminal on an agent's machine (issue #3), on its own screen (app/workspace.tsx) or in
 * a panel beside the chat on desktop (app/chats/[id].tsx).
 *
 * The view itself is a DOM component (WorkspaceView.tsx): CodeMirror and xterm.js, inline on web and desktop, in a
 * WebView on Android. This is its link to the hub: file requests, terminal frames, the clipboard and the back button.
 */
export const WorkspacePane = forwardRef<WorkspacePaneHandle, WorkspacePaneProps>(function WorkspacePane(
  { agentId, path, terminal, onClose, docked, expanded, onExpand }, handle,
) {
  const agent = useOne("agents", agentId);
  const ref = useRef<WorkspaceHandle>(null);
  const dirty = useRef(0);
  const open = useRef(new Set<string>());
  const queue = useRef<PushEvent[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const init = useMemo<WorkspaceInit>(() => ({
    agentName: agent?.name ?? "Agent",
    start: path || null,
    terminal: !!agent?.capabilities?.includes(TERMINAL_CAPABILITY),
    openTerminal: !!terminal,
    phone: Platform.OS !== "web",
    // Fixed when the screen opens: the view keeps its own state from then on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [agentId]);

  // Terminal output goes to the view in small batches: one bridge call per frame on a phone, not one per chunk.
  const push = useCallback((ev: PushEvent) => {
    queue.current.push(ev);
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const batch = queue.current.splice(0);
      if (batch.length) ref.current?.push(batch);
    }, 16);
  }, []);

  const call = useCallback(async (op: string, args: Record<string, unknown>): Promise<Reply> => {
    try {
      return { ok: true, result: await filesRequest(agentId, op as FileOp, args) };
    } catch (e) {
      return { ok: false, error: { code: (e as { code?: string }).code ?? "error", message: (e as Error).message } };
    }
  }, [agentId]);

  const term = useCallback(async (action: TermAction, a: Record<string, unknown>): Promise<Reply<{ termId?: string; shell?: string; cwd?: string }>> => {
    const termId = typeof a.termId === "string" ? a.termId : "";
    switch (action) {
      case "open": {
        let id = "";
        try {
          const r = await termOpen(agentId, typeof a.cwd === "string" ? a.cwd : null, { cols: Number(a.cols) || 80, rows: Number(a.rows) || 24 }, (e: TermEvent) => {
            if (e.type === "exit") open.current.delete(id);
            push({ termId: id, ...e });
          });
          id = r.termId;
          open.current.add(id);
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, error: { code: (e as { code?: string }).code ?? "error", message: (e as Error).message } };
        }
      }
      case "input":
        termInput(termId, String(a.data ?? ""));
        break;
      case "resize":
        termResize(termId, Number(a.cols), Number(a.rows));
        break;
      case "close":
        termClose(termId);
        open.current.delete(termId);
        break;
    }
    return { ok: true, result: {} };
  }, [agentId, push]);

  // Leaving the screen ends its terminals. A dropped connection does not: they are taken up again when it is back.
  useEffect(() => () => {
    for (const id of open.current) termClose(id);
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Android's back button asks about unsaved files first.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!dirty.current) return false;
      ref.current?.requestClose();
      return true;
    });
    return () => sub.remove();
  }, []);

  const close = useCallback(async () => {
    dirty.current = 0;
    onClose();
  }, [onClose]);

  const expand = useCallback(async () => onExpand?.(), [onExpand]);

  useImperativeHandle(handle, () => ({
    showTerminal: () => ref.current?.showTerminal(),
    showFiles: () => ref.current?.showFiles(),
    requestClose: () => ref.current?.requestClose(),
  }), []);

  if (!agent) return <Placeholder icon="folder" title="Agent not found" />;

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <WorkspaceView
        ref={ref}
        init={init}
        call={call}
        term={term}
        copyText={async (text: string) => void (await Clipboard.setStringAsync(text))}
        onDirty={async (n: number) => void (dirty.current = n)}
        onClose={close}
        docked={docked}
        expanded={expanded}
        onExpand={onExpand ? expand : undefined}
        dom={{ style: { flex: 1, backgroundColor: color.bg }, scrollEnabled: false, bounces: false, keyboardDisplayRequiresUserAction: false } as any}
      />
    </View>
  );
});
