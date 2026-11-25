import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback } from "react";
import { WorkspacePane } from "../src/workspace/WorkspacePane";

/**
 * Files, the editor and the terminal on an agent's machine, on a screen of their own (issue #3): on a phone, and
 * from a project. `agent` names the agent (its connector is the machine), `path` the folder to start in,
 * `terminal=1` opens a terminal there right away. On desktop a chat opens the same view in a panel beside it.
 */
export default function WorkspaceScreen() {
  const { agent, path, terminal } = useLocalSearchParams<{ agent: string; path?: string; terminal?: string }>();
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/chats");
  }, []);
  return <WorkspacePane agentId={agent} path={path || null} terminal={terminal === "1"} onClose={close} />;
}
