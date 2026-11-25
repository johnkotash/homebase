/**
 * What passes between the workspace screen (React Native) and the workspace view (a DOM component: inline on
 * web and desktop, a WebView on Android). Everything here is plain JSON.
 */

export type Reply<T = unknown> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export type WorkspaceInit = {
  agentName: string;
  /** Where the file browser starts: the session's or project's folder. Null: home. */
  start: string | null;
  terminal: boolean;
  /** Open a terminal in `start` right away. */
  openTerminal: boolean;
  /** A phone (touch, narrow): one pane at a time, the key bar under the terminal. */
  phone: boolean;
};

export type TermAction = "open" | "input" | "resize" | "close";

export type PushEvent = { termId: string; type: "output" | "reattached" | "exit"; data?: string; code?: number | null; reason?: string };

export type WorkspaceHandle = {
  /** Terminal output and events, batched by the screen. */
  push: (events: PushEvent[]) => void;
  /** The phone's back button: the view asks about unsaved files, then calls onClose. */
  requestClose: () => void;
  /** Docked beside the chat: the chat's Terminal button, when the workspace is already open. */
  showTerminal: () => void;
  /** The chat's Files button, when the workspace is already open (a narrow panel shows one pane at a time). */
  showFiles: () => void;
};
