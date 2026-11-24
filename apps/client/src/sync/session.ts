import { PermissionsAndroid, Platform } from "react-native";
import { create } from "zustand";
import type { FolderOp, MutationArgs, MutationName, Notification, VaultOp } from "@homebase/protocol";
import type { BrowserControl, BrowserInput, BrowserToDevice } from "@homebase/protocol";
import { SyncClient, createSyncStore, type MutationResult } from "@homebase/sync-client";
import { bdbg } from "../browserDebug";
import { sameClientSession } from "./sessionKey";
import { clearNoteCache } from "../vault/cache";
import { cacheStorage, sessionStorage, type Session } from "./storage";
import { connectedHubUrl, defaultHubUrl } from "../desktop/connectionRules";
import { useDesktopConnection } from "../desktop/connection";

export const APP_VERSION = "0.1.0";
export const isElectron = Platform.OS === "web" && typeof navigator !== "undefined" && /electron/i.test(navigator.userAgent);
export const platformName = Platform.OS === "web" ? (isElectron ? "desktop" : "web") : Platform.OS;
// EXPO_PUBLIC_HUB_URL is baked in at build time (scripts/android.mjs --release --hub-url ...), so a phone build opens on the server's address.
// A production web build opened from the hub itself (http://my-server:8787/) starts with that address.
export const DEFAULT_HUB_URL = defaultHubUrl({
  platform: Platform.OS, production: process.env.NODE_ENV === "production",
  location: Platform.OS === "web" && typeof window !== "undefined" ? window.location : null, envUrl: process.env.EXPO_PUBLIC_HUB_URL,
});

/**
 * Android 16+ puts private addresses (LAN, 10.0.2.2, tailnet 100.x) behind the local-network permission.
 * Ask before the first request to one; a refusal just lets the request fail with the usual message.
 */
async function ensureLocalNetwork(url: string) {
  if (Platform.OS !== "android" || Number(Platform.Version) < 36) return;
  const host = url.replace(/^https?:\/\//i, "").split(/[/:]/)[0];
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || /\.(local|ts\.net)$/i.test(host);
  if (!priv) return;
  try {
    const perm = "android.permission.ACCESS_LOCAL_NETWORK" as any;
    if (!(await PermissionsAndroid.check(perm))) await PermissionsAndroid.request(perm);
  } catch {}
}

/** One entity store for the life of the app; SyncClient instances come and go with pairing. */
export const syncStore = createSyncStore();

export interface Toast { id: number; title: string; body?: string; tone?: "error" | "ok"; link?: string | null }
interface SessionState {
  ready: boolean;
  session: Session | null;
  /** In-app toasts, oldest first. Shown as a stack by ToastHost: top-right on a wide window, top on a phone. */
  toasts: Toast[];
}
export const useSession = create<SessionState>(() => ({ ready: false, session: null, toasts: [] }));

let client: SyncClient | null = null;
/** The pairing the running client was started for. */
let clientSession: { url: string; token: string } | null = null;
let toastSeq = 0;
const notifyHandlers = new Set<(n: Notification) => void>();

export function onNotify(fn: (n: Notification) => void) {
  notifyHandlers.add(fn);
  return () => void notifyHandlers.delete(fn);
}

const MAX_TOASTS = 4;

export function showToast(title: string, body?: string, tone?: "error" | "ok", link?: string | null) {
  const id = ++toastSeq;
  // The same message twice in a row replaces itself instead of stacking.
  const rest = useSession.getState().toasts.filter((t) => !(t.title === title && t.body === body && t.link === link));
  useSession.setState({ toasts: [...rest, { id, title, body, tone, link }].slice(-MAX_TOASTS) });
  // Errors stay a little longer; every toast can also be closed by hand.
  setTimeout(() => dismissToast(id), tone === "error" ? 9000 : 6000);
}

export function dismissToast(id: number) {
  const cur = useSession.getState().toasts;
  if (cur.some((t) => t.id === id)) useSession.setState({ toasts: cur.filter((t) => t.id !== id) });
}

function startClient(session: Session) {
  client?.stop();
  clientSession = { url: session.url, token: session.token };
  client = new SyncClient({
    url: session.url, token: session.token, storage: cacheStorage, store: syncStore,
    client: { platform: platformName, app: APP_VERSION, name: session.name },
    onNotify: (n) => notifyHandlers.forEach((h) => h(n)),
    onMutationError: (e) => showToast("That didn't go through", e.message, "error"),
    onServerError: (e) => bdbg("hub refused a frame", e),
    onUnauthorized: () => {
      // Revoked from another device, or the hub database was recreated.
      void unpair("This device is no longer paired with the hub.");
    },
  });
  void client.start();
}

export async function initSession() {
  let session = await sessionStorage.load();
  // Installed desktop app: when the tunnel is already up, use the address it is on now (its local port can change).
  const hub = connectedHubUrl(useDesktopConnection.getState().snap?.state);
  if (session && hub && session.url !== hub) {
    session = { ...session, url: hub };
    await sessionStorage.save(session);
  }
  useSession.setState({ ready: true, session });
  if (!session) return;
  // The root mounted again (Android re-created the activity): the running connection, and what the screens subscribed on it, stay.
  if (client && sameClientSession(clientSession, session)) return void client.reconnectNow();
  startClient(session);
}

/**
 * The installed desktop app reaches the hub through its own SSH tunnel (or a direct address), and the tunnel's
 * local port can change between runs. The pairing (token) stays; only the address it is used at moves.
 */
export async function followHubAddress(url: string) {
  const s = useSession.getState().session;
  if (!s || s.url === url) return;
  const next = { ...s, url };
  await sessionStorage.save(next);
  useSession.setState({ session: next });
  startClient(next);
}

export async function pairDevice(input: { url: string; code: string; name: string }): Promise<{ ok: true } | { ok: false; message: string }> {
  const url = input.url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: "The server URL must start with http:// or https://" };
  let res: Response;
  await ensureLocalNetwork(url);
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    res = await fetch(`${url}/v1/pair`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ code: input.code.trim(), kind: "device", name: input.name.trim() || "My device", platform: platformName }),
    });
    clearTimeout(t);
  } catch {
    const tailnet = /\.ts\.net|\/\/100\./.test(url);
    return { ok: false, message: `Can't reach a hub at ${url}. Check the address${tailnet ? ", that Tailscale is connected on this device," : ""} and that the hub is running.` };
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok || !json?.token) return { ok: false, message: json?.error?.message ?? `The hub answered ${res.status}.` };
  const session: Session = { url, token: json.token, deviceId: json.deviceId, workspaceId: json.workspaceId, name: input.name.trim() || "My device" };
  await sessionStorage.save(session);
  useSession.setState({ session });
  startClient(session);
  return { ok: true };
}

export async function unpair(reason?: string) {
  const c = client;
  client = null;
  clientSession = null;
  await c?.wipe();
  await clearNoteCache().catch(() => 0); // cached note bodies go with the pairing
  await sessionStorage.clear();
  useSession.setState({ session: null });
  if (reason) showToast("Unpaired", reason, "error");
}

export function mutate<N extends MutationName>(name: N, args: MutationArgs<N>): Promise<MutationResult> {
  if (!client) return Promise.resolve({ ok: false, error: { code: "not_paired", message: "This device is not paired" } });
  return client.mutate(name, args);
}

/** Asks the vault (through the hub) for a note, a search, backlinks or status. Online only. */
export function vaultRequest<T = unknown>(op: VaultOp, args: Record<string, unknown> = {}): Promise<T> {
  if (!client) return Promise.reject(Object.assign(new Error("This device is not paired"), { code: "not_paired" }));
  return client.vault<T>(op, args);
}

/**
 * Asks an agent's connector about folders on its machine (through the hub): browse, check one, approve or forget one.
 * Online only. Approving and forgetting need a device that may approve.
 */
export function folderRequest<T = unknown>(agentId: string, op: FolderOp, args: Record<string, unknown> = {}): Promise<T> {
  if (!client) return Promise.reject(Object.assign(new Error("This device is not paired"), { code: "not_paired" }));
  return client.folders<T>(agentId, op, args);
}

export function subscribeTopic(topic: string): () => void {
  return client?.subscribe(topic) ?? (() => {});
}

export function reconnectNow() {
  client?.reconnectNow();
}

/** Settings escape hatch: refetch everything from the hub. Keeps pairing, the token and unsent changes. */
export function resyncEverything(): boolean {
  if (!client) return false;
  client.resync();
  return true;
}

/** Authenticated REST call to the hub. The token goes in the Authorization header, never in the URL. */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = useSession.getState().session;
  if (!session) throw new Error("Not paired");
  const res = await fetch(`${session.url}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${session.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `Hub answered ${res.status}`);
  return json as T;
}

// ---- the browser on a connector (docs/BROWSER-AGENT-PLAN.md) ----

/** Watches a connector's browser until the returned function is called: its state and its live picture. */
export function watchBrowser(connectorId: string, on: (m: BrowserToDevice) => void): () => void {
  return client?.watchBrowser(connectorId, on) ?? (() => {});
}

/** A tap, a scroll or a key for the browser. Dropped when offline: a late keystroke is worse than a lost one. */
export function browserInput(connectorId: string, input: BrowserInput): boolean {
  return client?.browserInput(connectorId, input) ?? false;
}

/** Asks the hub again where a watched browser stands. False when offline (the next connection asks anyway). */
export function refreshBrowser(connectorId: string): boolean {
  return client?.refreshBrowser(connectorId) ?? false;
}

/** Tells the browser node a picture arrived, so it sends the next one (and lighter ones on a slow link). */
export function browserAck(connectorId: string, seq: number): void {
  client?.browserAck(connectorId, seq);
}

/** A button of the browser view (take over, hand back, sign in, settings). False when it could not be sent. */
export function browserControl(connectorId: string, control: BrowserControl): boolean {
  const sent = client?.browserControl(connectorId, control) ?? false;
  bdbg("control", { action: control.action, layout: control.layout, size: control.size, sent });
  if (!sent) showToast("Not connected", "The browser can be driven only while this device is online.", "error");
  return sent;
}
