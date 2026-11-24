import { create } from "zustand";
import { connectedHubUrl, type ConnConfig, type ConnSnapshot, type ConnState } from "./connectionRules";

/**
 * The hub connection bridge of the installed desktop app (apps/desktop/preload.cjs, `homebaseDesktopConnection`).
 * Absent on the phone, in a browser and in the desktop dev setup: then every function here does nothing.
 */
interface ConnBridge {
  initial: ConnSnapshot | null;
  get(): Promise<ConnSnapshot | null>;
  save(config: Partial<ConnConfig>): Promise<({ ok: true } & ConnSnapshot) | { ok: false; errors: Record<string, string> }>;
  retry(): Promise<ConnSnapshot | null>;
  onState(cb: (s: ConnState) => void): () => void;
}

export function desktopConnection(): ConnBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const b = (window as any).homebaseDesktopConnection as ConnBridge | undefined;
  return b && typeof b.save === "function" ? b : undefined;
}

/** Null when this is not the installed desktop app. */
export const useDesktopConnection = create<{ snap: ConnSnapshot | null }>(() => ({ snap: desktopConnection()?.initial ?? null }));

let started = false;
/**
 * Follows the shell's connection. `onHub` gets each new hub address once it answers, so the paired session
 * moves with the tunnel when its local port changes.
 */
export function initDesktopConnection(onHub: (url: string) => void): () => void {
  const b = desktopConnection();
  if (!b || started) return () => {};
  started = true;
  const apply = (state: ConnState) => {
    const cur = useDesktopConnection.getState().snap;
    if (cur) useDesktopConnection.setState({ snap: { ...cur, state } });
    const url = connectedHubUrl(state);
    if (url) onHub(url);
  };
  const off = b.onState(apply);
  // The state may have moved between the preload's snapshot and now.
  void b.get().then((s) => {
    if (!s) return;
    useDesktopConnection.setState({ snap: s });
    apply(s.state);
  });
  return () => {
    off();
    started = false;
  };
}

export async function saveDesktopConnection(config: Partial<ConnConfig>) {
  const b = desktopConnection();
  if (!b) return { ok: false as const, errors: { mode: "Only the desktop app has this setting." } };
  const r = await b.save(config);
  if (r.ok) useDesktopConnection.setState({ snap: { config: r.config, configured: r.configured, state: r.state } });
  return r;
}

export function retryDesktopConnection() {
  void desktopConnection()?.retry();
}
