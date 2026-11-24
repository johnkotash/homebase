import { randomBytes, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  BROWSER_CAPABILITY, BROWSER_MCP_SERVER, BrowserControl, BrowserInput, isBrowserTool, newId, type BrowserFrame, type BrowserState, type PermissionMode,
} from "@homebase/protocol";
import type { PermissionEnv } from "../adapters/claude-approvals";
import type { RunContext } from "../adapters/types";
import type { Verdict } from "../policy";
import { findChrome } from "./cdp";
import { CdpDriver, type BrowserDriver } from "./driver";
import { allowRequest } from "./gate";
import { BrowserNode, fileStore, type NodeStore, type RunBrowser } from "./node";
import { buildBrowserMcpServer, withholdPages } from "./tools";

/**
 * The browser for agents on this connector (docs/BROWSER-AGENT-PLAN.md): one browser node, a loopback MCP
 * endpoint that hands each run its tools, and the relay of the live picture and the owner's hands to and
 * from the hub. One instance per connector.
 *
 *   HB_BROWSER=0              no browser on this connector
 *   HB_BROWSER_EXE            the browser to start (default: Google Chrome on Linux, else Playwright's Chromium)
 *   HB_BROWSER_HEADLESS=1     no window (the default on a server without a display and without Xvfb)
 *   HB_BROWSER_PROFILE        the profile folder (default <data>/browser/profile). Never the owner's own Chrome profile.
 *   HB_BROWSER_ALLOW_PRIVATE  "127.0.0.1:4173,..." private addresses that may be opened, for development
 *   HB_BROWSER_IDLE_MIN       minutes without use before the browser is closed (default 15)
 *   HB_BROWSER_SCALE          device pixels per CSS pixel of a window nobody sees (Xvfb or headless), 1 to 3,
 *                             default 3: how sharp a phone's live picture can be. A window on a real screen stays at 1.
 *   HB_BROWSER_DEBUG=1        temporary diagnostics in the log: each input's fate, the pictures' size and rate
 */

export interface BrowserServiceOptions {
  dataDir: string;
  /** The hub that keeps the small pictures of steps. Null: steps have no pictures. */
  hub?: () => { url: string; token: string } | null;
  env?: NodeJS.ProcessEnv;
  log?: (...a: unknown[]) => void;
  now?: () => number;
  /** Test seams. */
  driver?: BrowserDriver | null;
  store?: NodeStore;
  fetchFn?: typeof fetch;
}

type Binding = { servers: Record<string, unknown>; release(): void };
type Decide = (tool: string, input: Record<string, unknown>, env: PermissionEnv) => Verdict;
type ExtraMcp = (ctx: RunContext, info: { cwd: string; mode: () => PermissionMode }) => Promise<Binding>;

export const NO_BROWSER_NOTE =
  "No browser was found on this machine. Install Google Chrome, or run `npx playwright install chromium`, or point HB_BROWSER_EXE at one, then restart the connector.";

export class BrowserService {
  readonly node: BrowserNode;
  readonly profileDir: string;
  readonly exe: string | null;
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private bindings = new Map<string, RunBrowser>();
  private sender: ((frame: object) => boolean) | null = null;
  private log: (...a: unknown[]) => void;
  private fetchFn: typeof fetch;
  port = 0;

  constructor(private o: BrowserServiceOptions) {
    const env = o.env ?? process.env;
    this.log = o.log ?? (() => {});
    this.fetchFn = o.fetchFn ?? fetch;
    const dir = resolve(o.dataDir, "browser");
    this.profileDir = env.HB_BROWSER_PROFILE?.trim() ? resolve(env.HB_BROWSER_PROFILE.trim()) : resolve(dir, "profile");
    const allowPrivate = (env.HB_BROWSER_ALLOW_PRIVATE ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    this.exe = o.driver === undefined ? findChrome(env) : null;
    const driver = o.driver !== undefined ? o.driver
      : this.exe ? new CdpDriver({
          exe: this.exe, profileDir: this.profileDir, headless: env.HB_BROWSER_HEADLESS === "1", env, log: this.log,
          scale: env.HB_BROWSER_SCALE?.trim() ? Number(env.HB_BROWSER_SCALE) : 3,
          // Pages are kept away from this machine, the home network and the tailnet, whatever they link to or load.
          allowRequest: (url) => allowRequest(url, { allowPrivate }),
        })
      : null;
    const idle = Number(env.HB_BROWSER_IDLE_MIN);
    this.node = new BrowserNode({
      driver, unavailable: driver ? null : NO_BROWSER_NOTE, store: o.store ?? fileStore(dir), allowPrivate, now: o.now, log: this.log, debug: env.HB_BROWSER_DEBUG === "1",
      idleMs: Number.isFinite(idle) && env.HB_BROWSER_IDLE_MIN ? idle * 60_000 : undefined,
      onState: (state) => this.send({ t: "browser.state", state }),
      onFrame: (frame) => this.send({ t: "browser.frame", frame }),
      onNotice: (deviceId, message) => this.send({ t: "browser.notice", deviceId, message: message.slice(0, 400) }),
      saveShot: o.hub ? (jpeg) => this.saveShot(jpeg) : undefined,
      wipeProfile: () => rmSync(this.profileDir, { recursive: true, force: true }),
    });
  }

  get available(): boolean {
    return !this.node.state().unavailable;
  }

  /** What the agent's registration says: the capability the app looks for. */
  get capabilities(): string[] {
    return this.available ? [BROWSER_CAPABILITY] : [];
  }

  // ---------------------------------------------------------------- the hub

  /** How frames leave for the hub. Set once the link exists. */
  attach(sender: (frame: object) => boolean) {
    this.sender = sender;
  }

  private send(frame: object) {
    this.sender?.(frame);
  }

  /** The link is up (first connect and every reconnect): say where things stand. */
  onReady() {
    this.send({ t: "browser.state", state: this.node.state() });
  }

  /** A frame the hub relayed from a device, or its count of viewers. Anything else is ignored. */
  onHubFrame(frame: any) {
    if (!frame || typeof frame !== "object") return;
    if (frame.t === "browser.viewers") return this.node.setViewers(Number(frame.count) || 0);
    if (frame.t === "browser.ack") return this.node.ack(Number(frame.seq));
    if (frame.t === "browser.input") {
      const input = BrowserInput.safeParse(frame.input);
      if (input.success) void this.node.input(input.data);
      else if (this.node.debug) this.log(`browser debug: input refused: ${input.error.issues[0]?.message}`);
      return;
    }
    if (frame.t === "browser.control") {
      const control = BrowserControl.safeParse(frame.control);
      if (!control.success && this.node.debug) this.log(`browser debug: control refused: ${control.error.issues[0]?.path.join(".")} ${control.error.issues[0]?.message}`);
      if (control.success) void this.node.control(control.data, typeof frame.deviceId === "string" ? frame.deviceId : null);
    }
  }

  /** A small picture of a step, kept by the hub with the images made in sessions. Null when it could not be stored. */
  private async saveShot(jpeg: Buffer): Promise<string | null> {
    const hub = this.o.hub?.();
    if (!hub) return null;
    const id = newId("art");
    try {
      const res = await this.fetchFn(`${hub.url.replace(/\/+$/, "")}/v1/artifacts/${id}`, {
        method: "PUT", headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": "image/jpeg" }, body: new Uint8Array(jpeg),
      });
      return res.ok ? id : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- wiring into an agent adapter

  /** The browser tools pass the permission prompt untouched: the gate, the pace and the owner's approval are inside them. */
  decideWith(inner: Decide): Decide {
    return (tool, input, env) => (isBrowserTool(tool) ? { tier: "auto", silent: true, reason: "Browser tool: gated by the browser itself" } : inner(tool, input, env));
  }

  /** `extraMcp` for an agent adapter: this run's browser tools. */
  extraMcp: ExtraMcp = async (ctx, info) => {
    if (!this.available) return { servers: {}, release() {} };
    await this.listen();
    const run: RunBrowser = { runId: ctx.run.id, threadId: ctx.run.threadId, mode: info.mode, ask: ctx.requestApproval, emit: (kind, data) => ctx.emit(kind, data), signal: ctx.signal };
    const token = randomBytes(24).toString("hex");
    this.bindings.set(token, run);
    return {
      servers: { [BROWSER_MCP_SERVER]: { type: "http", url: `http://127.0.0.1:${this.port}/browser`, headers: { Authorization: `Bearer ${token}` } } },
      release: () => {
        this.bindings.delete(token);
        // The run's last process is gone: its claim on the browser goes with it.
        if (![...this.bindings.values()].some((b) => b.runId === run.runId)) this.node.runEnded(run.runId);
      },
    };
  };

  /** Page text stays off the run timeline; the agent's own words are what the owner reads. */
  redact = (tool: string | null, output: string): string => (isBrowserTool(tool) ? withholdPages(output) : output);

  async stop(): Promise<void> {
    this.bindings.clear();
    await this.node.stop();
    const s = this.server;
    this.server = null;
    this.starting = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  // ---------------------------------------------------------------- the loopback MCP endpoint

  private listen(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((ok, fail) => {
      const server = createServer((req, res) => void this.onRequest(req, res));
      server.once("error", fail);
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        server.unref();
        ok();
      });
    });
    return this.starting;
  }

  /** Each run has its own random bearer token, so a tool call reaches only the run whose process was handed it. */
  private lookup(req: IncomingMessage): RunBrowser | null {
    const m = /^Bearer\s+([0-9a-f]+)$/i.exec(req.headers.authorization ?? "");
    if (!m) return null;
    for (const [token, run] of this.bindings) {
      const a = Buffer.from(token);
      const b = Buffer.from(m[1]);
      if (a.length === b.length && timingSafeEqual(a, b)) return run;
    }
    return null;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse) {
    const json = (code: number, message: string) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
    };
    try {
      if (!req.url?.startsWith("/browser")) return json(404, "Not found");
      const run = this.lookup(req);
      if (!run) return json(401, "Unauthorized");
      if (req.method !== "POST") return json(405, "Method not allowed");
      const mcp = buildBrowserMcpServer(this.node, run);
      // A step can wait on the owner for hours (an approval, a sign-in): keep-alives stop idle timeouts.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, keepAliveMs: 15_000 } as any);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) json(500, (err as Error).message ?? "Internal error");
    }
  }
}

/** Several `extraMcp` hooks as one: every server is offered, every binding released. */
export function mergeExtraMcp(...hooks: Array<ExtraMcp | null | undefined>): ExtraMcp {
  const list = hooks.filter((h): h is ExtraMcp => !!h);
  return async (ctx, info) => {
    const parts = await Promise.all(list.map((h) => h(ctx, info)));
    return { servers: Object.assign({}, ...parts.map((p) => p.servers)), release: () => parts.forEach((p) => p.release()) };
  };
}

export type { BrowserFrame, BrowserState };
