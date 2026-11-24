import { MemoryStore, SyncClient, type KeyValueStore } from "@homebase/sync-client";
import { startHub, type HubApp, type StartOptions } from "../../server/src/app";
import { createMockAdapter } from "../src/adapters/mock";
import { MOCK_AGENTS } from "../src/config";
import { HubLink } from "../src/HubLink";

export async function waitFor<T>(fn: () => T | undefined | null | false, what = "condition", timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const bootHub = (opts: Partial<StartOptions> = {}) =>
  startHub({ dbPath: ":memory:", quiet: true, seed: { demo: false }, slaTickMs: 3_600_000, ...opts });

export function pairToken(app: HubApp, kind: "device" | "connector", name: string) {
  const { code } = app.directory.createPairingCode(kind, null);
  const r = app.directory.pair({ code, kind, name, platform: "test" });
  if (!r.ok) throw new Error(r.message);
  return r;
}

export async function connectDevice(app: HubApp, name: string, opts: { storage?: KeyValueStore; token?: string; url?: string } = {}) {
  const paired = opts.token ? null : pairToken(app, "device", name);
  const token = opts.token ?? paired!.token;
  const notifications: any[] = [];
  const errors: any[] = [];
  const client = new SyncClient({
    url: opts.url ?? app.url, token, storage: opts.storage ?? new MemoryStore(), client: { platform: "test", app: "0.1.0", name },
    minBackoffMs: 30, maxBackoffMs: 120, pingMs: 60_000,
    onNotify: (n) => notifications.push(n), onMutationError: (e) => errors.push(e),
  });
  await client.start();
  await waitFor(() => client.store.getState().status === "online", `${name} online`);
  return { client, token, notifications, errors, state: () => client.store.getState(), list: <K extends keyof ReturnType<typeof client.store.getState>["entities"]>(e: K) => Object.values(client.store.getState().entities[e]) as any[] };
}

export async function connectMockConnector(app: HubApp, speed = 0.01) {
  const { token } = pairToken(app, "connector", "test-connector");
  const link = new HubLink({
    hubUrl: app.url, token, name: "test-connector", log: () => {},
    agents: MOCK_AGENTS.map((a) => ({ ...a, adapter: createMockAdapter({ speed }) })),
  });
  link.start();
  await link.whenReady();
  return link;
}
