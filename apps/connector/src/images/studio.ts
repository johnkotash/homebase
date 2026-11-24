import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  IMAGES_MCP_SERVER, ImageRoute, RunImageOptions, isImageTool, modelLabel, type AgentImagesStatus, type ImageMaker, type MessageAttachment, type PermissionMode,
} from "@homebase/protocol";
import { decidePermission, type PermissionEnv } from "../adapters/claude-approvals";
import type { AgentAdapter, RunContext } from "../adapters/types";
import type { Verdict } from "../policy";
import { CodexCli, type CodexClient, type CodexLimits, type CodexStatus } from "./codex";
import { BRAND_DIR, ImageStore, SAVE_DIR } from "./store";
import { loadRenderer, type SvgRenderer } from "./svg";
import { StudioRun, buildStudioMcpServer, type OpenAiReadiness } from "./tools";

/**
 * Image making for a Claude agent on this connector (docs/MULTI-PROVIDER-PLAN.md): it keeps track of
 * whether OpenAI is usable here, hands each run its image tools on a loopback MCP server, and reports
 * the facts the app shows. One instance per connector.
 */

export const DEFAULT_CAP_PER_RUN = 4;
export const DEFAULT_CAP_PER_HOUR = 20;

/** Why OpenAI images cannot be made, with the command that fixes it. Null when they can. */
export function openaiNote(s: CodexStatus | null, host: string): string | null {
  if (!s) return "Checking whether Codex is installed…";
  if (!s.installed) return `OpenAI images need the Codex CLI on ${host}. Install it there with \`npm i -g @openai/codex\`, then run \`codex login\`.`;
  if (!s.signedIn) return `Codex is not signed in on ${host}. Run \`codex login\` there (\`codex login --device-auth\` on a machine without a browser).`;
  if (s.method && s.method !== "chatgpt") return `Codex on ${host} is signed in with an API key, not a ChatGPT account. HomeBase uses the ChatGPT plan only: run \`codex logout\`, then \`codex login\`, there.`;
  return null;
}

export interface StudioOptions {
  dataDir: string;
  /** The hub the bytes are sent to. */
  hub: () => { url: string; token: string } | null;
  /** Called when the facts the app shows have changed. */
  onChange?: () => void;
  env?: NodeJS.ProcessEnv;
  log?: (...a: unknown[]) => void;
  now?: () => number;
  /** The name of this machine in messages to the owner. */
  host?: string;
  /** The model the agent runs on when the owner has chosen none (the connector's own setting), for the card of a graphic it drew. */
  claudeModel?: string | null;
  /** Test seams. */
  codex?: CodexClient;
  renderer?: () => Promise<SvgRenderer | null>;
  fetchFn?: typeof fetch;
}

type Binding = { servers: Record<string, unknown>; release(): void };

export class ImageStudio {
  readonly store: ImageStore;
  readonly caps: { perRun: number; perHour: number };
  private codex: CodexClient;
  private renderer: () => Promise<SvgRenderer | null>;
  private canRender = false;
  private status: CodexStatus | null = null;
  private limits: CodexLimits | null = null;
  private checking: Promise<CodexStatus> | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private now: () => number;
  private log: (...a: unknown[]) => void;
  private host: string;
  /** The owner's latest message per live run: what the routing rule reads. */
  private ownerText = new Map<string, string>();
  /** How to put a message into a live run as the owner's next message (the adapter's own follow-up queue). */
  private inputs = new Map<string, (text: string, attachments?: MessageAttachment[]) => void>();
  private lastMaker = new Map<string, ImageMaker>();
  private made = new Map<string, { maker: ImageMaker; name: string }>();
  // The loopback MCP endpoint.
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private bindings = new Map<string, StudioRun>();
  port = 0;

  constructor(private o: StudioOptions) {
    const env = o.env ?? process.env;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.host = o.host ?? hostname();
    this.codex = o.codex ?? new CodexCli({ env });
    this.renderer = o.renderer ?? loadRenderer;
    this.store = new ImageStore({ dataDir: o.dataDir, hub: o.hub, fetchFn: o.fetchFn, now: this.now, log: this.log });
    const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
    this.caps = { perRun: n(env.HB_IMAGES_PER_RUN, DEFAULT_CAP_PER_RUN), perHour: n(env.HB_IMAGES_PER_HOUR, DEFAULT_CAP_PER_HOUR) };
  }

  // ---------------------------------------------------------------- readiness and facts

  /** Asks the Codex CLI whether it is installed and signed in. One check at a time. */
  check(): Promise<CodexStatus> {
    this.checking ??= (async () => {
      const before = JSON.stringify([this.status?.installed, this.status?.version, this.status?.signedIn, this.status?.method]);
      try {
        this.status = await this.codex.status();
      } catch {
        this.status = { installed: false, version: null, signedIn: null, method: null, checkedAt: this.now() };
      }
      const after = JSON.stringify([this.status.installed, this.status.version, this.status.signedIn, this.status.method]);
      if (after !== before) {
        const note = openaiNote(this.status, this.host);
        this.log(note ? `OpenAI images not ready: ${note}` : `OpenAI images ready: Codex ${this.status.version ?? "?"}, signed in with ChatGPT`);
        this.o.onChange?.();
        if (!note) void this.readLimits();
      }
      return this.status;
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** Reads the plan's usage numbers. Quietly keeps the old ones when the CLI does not answer. */
  async readLimits(): Promise<void> {
    if (openaiNote(this.status, this.host)) return;
    const next = await this.codex.limits().catch(() => null);
    if (!next) return;
    const changed = JSON.stringify(next) !== JSON.stringify(this.limits);
    this.limits = next;
    if (changed) this.o.onChange?.();
  }

  private async openaiReady(): Promise<OpenAiReadiness> {
    // A check that is fresh and good is trusted for a minute; a bad one is asked again, so signing in takes effect at once.
    const fresh = this.status && this.now() - this.status.checkedAt < 60_000 && !openaiNote(this.status, this.host);
    const s = fresh ? this.status! : await this.check();
    const note = openaiNote(s, this.host);
    return { ready: !note, note };
  }

  /** What the app shows about images for this agent. */
  facts(): AgentImagesStatus {
    const s = this.status;
    const note = openaiNote(s, this.host);
    return {
      openai: {
        ready: !note, cliVersion: s?.version ?? null, signedIn: s?.signedIn ?? null, method: s?.method ?? null, note: note ? note.slice(0, 300) : null,
        plan: this.limits?.plan ?? null, usedPercent: this.limits?.usedPercent ?? null, windowMins: this.limits?.windowMins ?? null, resetsAt: this.limits?.resetsAt ?? null,
        imagesLastHour: this.store.countLastHour("openai"), capPerHour: this.caps.perHour, capPerRun: this.caps.perRun, checkedAt: s?.checkedAt ?? this.now(),
      },
      claude: { canRender: this.canRender },
      saveDir: SAVE_DIR, brandDir: BRAND_DIR,
    };
  }

  /** First check, then a re-check every two minutes and the plan numbers every ten. */
  async start(): Promise<void> {
    this.canRender = !!(await this.renderer().catch(() => null));
    await this.check();
    await this.readLimits();
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const t = setInterval(() => void fn().catch(() => {}), ms);
      t.unref();
      this.timers.push(t);
    };
    every(120_000, () => this.check());
    every(600_000, () => this.readLimits());
  }

  async stop(): Promise<void> {
    for (const t of this.timers.splice(0)) clearInterval(t);
    this.bindings.clear();
    const s = this.server;
    this.server = null;
    this.starting = null;
    if (s) {
      s.closeAllConnections?.();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  // ---------------------------------------------------------------- wiring into the Claude adapter

  /** The image tools are let through the permission prompt: the routing rule, the caps and the owner's one-tap answer are inside them. */
  decide = (tool: string, input: Record<string, unknown>, env: PermissionEnv): Verdict =>
    isImageTool(tool) ? { tier: "auto", silent: true, reason: "Image tool: routed, capped and attributed by HomeBase" } : decidePermission(tool, input, env);

  /** `extraMcp` for the Claude adapter: this run's image tools, or nothing when images are off for the session. */
  extraMcp = async (ctx: RunContext, info: { cwd: string; mode: () => PermissionMode }): Promise<Binding> => {
    const asked = RunImageOptions.safeParse(ctx.run.options?.images);
    // An older hub sends no image options: the tools are there and follow the default rule.
    const route: ImageRoute = asked.success ? asked.data.route : "auto";
    if (route === "off") return { servers: {}, release() {} };
    await this.listen();
    if (!this.ownerText.has(ctx.run.id)) this.ownerText.set(ctx.run.id, ctx.run.prompt);
    const model = typeof ctx.run.options?.model === "string" ? ctx.run.options.model : this.o.claudeModel ?? null;
    const run = new StudioRun(
      {
        runId: ctx.run.id, threadId: ctx.run.threadId, cwd: resolve(info.cwd), route, check: asked.success ? !!asked.data.check : false,
        ownerText: () => this.ownerText.get(ctx.run.id) ?? ctx.run.prompt, mode: info.mode, claudeModel: () => (model ? modelLabel(model) : null),
        requestApproval: ctx.requestApproval, emit: (kind, data) => ctx.emit(kind, data), signal: ctx.signal,
        // A decision the owner made in the app goes to the agent as their next message, not as tool output (see tools.ts).
        // The routing rule keeps reading the owner's own words, so `ownerText` is left as it is.
        tellAgent: (text) => {
          const input = this.inputs.get(ctx.run.id);
          if (!input) return false;
          input(text);
          return true;
        },
      },
      {
        codex: this.codex, store: this.store, renderer: this.renderer, openaiReady: () => this.openaiReady(),
        afterOpenAi: () => {
          this.o.onChange?.();
          // The plan's numbers lag a little behind a finished image.
          setTimeout(() => void this.readLimits(), 4_000).unref();
        },
        caps: this.caps,
        lastMaker: (t) => (t ? this.lastMaker.get(t) ?? null : null),
        setLastMaker: (t, m) => void (t && this.lastMaker.set(t, m)),
        madeBy: (f) => this.made.get(resolve(f)) ?? null,
        remember: (f, m) => void this.made.set(resolve(f), m),
        now: this.now,
      },
    );
    const token = randomBytes(24).toString("hex");
    this.bindings.set(token, run);
    return {
      servers: { [IMAGES_MCP_SERVER]: { type: "http", url: `http://127.0.0.1:${this.port}/images`, headers: { Authorization: `Bearer ${token}` } } },
      release: () => void this.bindings.delete(token),
    };
  };

  /** Wraps an agent's adapter so the studio knows the owner's latest words in each run (the first message and every follow-up). */
  wrap(adapter: AgentAdapter): AgentAdapter {
    return {
      kind: adapter.kind,
      start: (ctx) => {
        this.ownerText.set(ctx.run.id, ctx.run.prompt);
        const handle = adapter.start(ctx);
        this.inputs.set(ctx.run.id, (text, attachments) => handle.input(text, attachments));
        void handle.done.finally(() => {
          this.ownerText.delete(ctx.run.id);
          this.inputs.delete(ctx.run.id);
        });
        return {
          ...handle,
          input: (text, attachments) => {
            this.ownerText.set(ctx.run.id, text);
            handle.input(text, attachments);
          },
        };
      },
    };
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

  /** Each run has its own random bearer token, so a tool call reaches only the run whose CLI process was handed it. */
  private lookup(req: IncomingMessage): StudioRun | null {
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
      if (!req.url?.startsWith("/images")) return json(404, "Not found");
      const run = this.lookup(req);
      if (!run) return json(401, "Unauthorized");
      if (req.method !== "POST") return json(405, "Method not allowed");
      const mcp = buildStudioMcpServer(run);
      // An image takes half a minute and a question to the owner can stay open for hours: keep-alives stop idle timeouts.
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
